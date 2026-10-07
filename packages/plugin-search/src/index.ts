import {
  Capability,
  defineTable,
  definePlugin,
  endpoint,
  field,
  v,
  type DatabaseAdapter,
  type DataRoomDocument,
  type DataRoomNode,
  type DocumentVersion,
  type MaintenanceContext,
} from '@better-files/core';
import { normalize, sqlSearchBackend, type SearchBackend } from './backend.js';

export {
  sqlSearchBackend,
  type BackendContext,
  type SearchBackend,
  type SearchDocument,
  type SearchHit,
  type SearchQuery,
} from './backend.js';
export { meilisearchBackend, meilisearchId, type MeilisearchOptions } from './meilisearch.js';

/** Turns a file's bytes into searchable text. */
export interface Extractor {
  readonly id: string;
  accepts(input: { mimeType?: string; filename: string; head: Uint8Array }): boolean;
  extract(bytes: Uint8Array): Promise<string>;
}

const textTypes = /^(text\/|application\/(json|xml|csv|x-yaml|yaml|markdown))/;
const textExtensions = /\.(txt|md|csv|tsv|json|xml|ya?ml|log|html?)$/i;

/** UTF-8 text files: plain text, CSV, JSON, Markdown, XML, YAML. */
export const plainTextExtractor: Extractor = {
  id: 'text',
  accepts: ({ mimeType, filename }) =>
    (mimeType ? textTypes.test(mimeType) : false) || textExtensions.test(filename),
  extract: async (bytes) => new TextDecoder('utf-8', { fatal: false }).decode(bytes),
};

/** PDF text through `unpdf` (an optional dependency). */
export const pdfExtractor: Extractor = {
  id: 'pdf',
  accepts: ({ head }) => new TextDecoder().decode(head.subarray(0, 5)) === '%PDF-',
  async extract(bytes) {
    const { extractText, getDocumentProxy } = (await import('unpdf')) as typeof import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: true });
    return Array.isArray(text) ? text.join('\n') : text;
  },
};

export interface SearchOptions {
  /**
   * Where the index lives. Default `sqlSearchBackend()`, a table in your database; `meilisearchBackend()` for
   * typo-tolerant, ranked search over large rooms.
   */
  backend?: SearchBackend;
  /**
   * Index document text as well as names. The extracted text is stored by the backend in plain text (files stay
   * encrypted in storage): in your database with the SQL backend, in Meilisearch with that one. Enable it where
   * the index is protected at rest. Default false.
   */
  indexContent?: boolean;
  extractors?: readonly Extractor[];
  /** Characters of text kept per document. Default 200 000. */
  maxTextLength?: number;
  /** Files larger than this are indexed by name only. Default 50 MiB. */
  maxFileBytes?: number;
  /** Candidates fetched from the backend per query, before permission filtering. Default 1000. */
  candidateLimit?: number;
}

async function readBytes(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array | undefined> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Documents flagged view-only or no-copy: their text is not handed out as text (snippets, AI answers). */
export async function copyProtected(
  db: DatabaseAdapter,
  tenantId: string,
  documentIds: readonly string[],
): Promise<Set<string>> {
  if (documentIds.length === 0) return new Set();
  const documents = await db.findMany<DataRoomDocument>('documents', {
    where: { tenantId, id: { in: [...documentIds] } },
  });
  return new Set(
    documents
      .filter((document) => document.flags?.viewOnly || document.flags?.noCopy)
      .map((document) => document.id),
  );
}

/**
 * Whether a caller may read a document's extracted text outside the viewer. `VIEW` is needed; on documents flagged
 * view-only or no-copy, `COPY_TEXT` is needed too, so search and AI cannot turn a protected document into text.
 */
export const mayReadText = (mask: number, copyProtectedDocument: boolean): boolean =>
  (mask & Capability.VIEW) !== 0 && (!copyProtectedDocument || (mask & Capability.COPY_TEXT) !== 0);

/** The part of a maintenance context indexing uses, so reindexing from a request can provide it too. */
type IndexContext = Pick<MaintenanceContext, 'now' | 'logger' | 'readVersion'>;

/**
 * Search inside a room: names always, and document text when `indexContent` is on. Results only include items the
 * caller can list, and text snippets only for documents they can view. The index follows uploads, renames, moves,
 * version restores and virus-scan verdicts through events, and lives in your database (`sqlSearchBackend`, the
 * default) or in Meilisearch (`meilisearchBackend`).
 */
export function searchPlugin(options: SearchOptions = {}) {
  const extractors = options.extractors ?? [plainTextExtractor, pdfExtractor];
  const maxText = options.maxTextLength ?? 200_000;
  const maxBytes = options.maxFileBytes ?? 50 * 1024 * 1024;
  const backend = options.backend ?? sqlSearchBackend();
  const candidateLimit = options.candidateLimit ?? 1000;

  async function extract(
    context: IndexContext,
    tenantId: string,
    version: DocumentVersion,
  ): Promise<string> {
    if (!options.indexContent || version.status !== 'ready' || version.size > maxBytes) return '';
    const bytes = await readBytes(await context.readVersion(tenantId, version.id), maxBytes);
    if (!bytes) return '';
    const extractor = extractors.find((candidate) =>
      candidate.accepts({
        ...(version.mimeType ? { mimeType: version.mimeType } : {}),
        filename: version.filename,
        head: bytes.subarray(0, 16),
      }),
    );
    if (!extractor) return '';
    try {
      return (await extractor.extract(bytes)).slice(0, maxText);
    } catch (error) {
      context.logger.warn('Text extraction failed', {
        versionId: version.id,
        extractor: extractor.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return '';
    }
  }

  async function index(
    context: IndexContext,
    db: DatabaseAdapter,
    tenantId: string,
    nodeId: string,
    withText: boolean,
  ) {
    const node = await db.findOne<DataRoomNode>('nodes', { id: nodeId, tenantId });
    if (!node || !node.parentId) return;
    // Name-only changes leave `text` undefined, so the backend keeps the text it has.
    let content: { text: string; versionId?: string } | undefined;
    if (node.kind === 'document' && withText) {
      const document = await db.findOne<DataRoomDocument>('documents', { id: node.id, tenantId });
      const version = document?.currentVersionId
        ? await db.findOne<DocumentVersion>('versions', { id: document.currentVersionId, tenantId })
        : null;
      content = {
        text: version ? await extract(context, tenantId, version) : '',
        ...(version ? { versionId: version.id } : {}),
      };
    }
    await backend.upsert(
      {
        tenantId,
        roomId: node.roomId,
        nodeId: node.id,
        kind: node.kind,
        name: node.name,
        updatedAt: context.now,
        ...content,
      },
      { db },
    );
  }

  const contentEvents = new Set([
    'document.uploaded',
    'version.created',
    'version.restored',
    'version.scanned',
  ]);
  const nameEvents = new Set(['folder.created', 'folder.renamed', 'document.renamed']);

  const plugin = definePlugin({
    id: 'search',
    actions: ['better-files:search:reindex'],
    accessModel: [{ relations: ['owner', 'admin'], actions: ['better-files:search:reindex'] }],
    schema: {
      searchEntries: defineTable({
        fields: {
          roomId: field.string(),
          nodeId: field.string(),
          kind: field.enum(['folder', 'document'] as const),
          versionId: field.string({ required: false }),
          name: field.string(),
          haystack: field.string(),
          text: field.string({ required: false }),
          updatedAt: field.timestamp(),
        },
        indexes: [
          { fields: ['tenantId', 'nodeId'], unique: true },
          { fields: ['tenantId', 'roomId'] },
        ],
      }),
    },
    async onEvent(event, context) {
      const nodeId = typeof event.data.nodeId === 'string' ? event.data.nodeId : undefined;
      if (event.type === 'room.deleted' && event.roomId) {
        await backend.removeRoom(
          { tenantId: event.tenantId, roomId: event.roomId },
          { db: context.db },
        );
        return;
      }
      if (!nodeId) return;
      if (contentEvents.has(event.type))
        await index(context, context.db, event.tenantId, nodeId, true);
      else if (nameEvents.has(event.type))
        await index(context, context.db, event.tenantId, nodeId, false);
    },
    endpoints: {
      query: endpoint({
        operation: {
          action: 'better-files:documents:list',
          target: 'room',
          mutates: false,
          allowClosed: true,
        },
        input: v.object({
          roomId: v.id(),
          q: v.string({ min: 1, max: 200, trim: true }),
          kind: v.optional(v.enum(['folder', 'document'] as const)),
          limit: v.optional(v.number({ int: true, min: 1, max: 100 })),
        }),
        target: (input) => ({ roomId: input.roomId }),
        async handler(context, input) {
          const room = context.room!;
          const words = [
            ...new Set(
              normalize(input.q)
                .split(' ')
                .filter((word) => word.length > 0),
            ),
          ].slice(0, 8);
          if (words.length === 0) return [];
          const hits = await backend.query(
            {
              tenantId: context.tenantId,
              roomId: room.id,
              q: input.q,
              words,
              ...(input.kind ? { kind: input.kind } : {}),
              limit: candidateLimit,
            },
            { db: context.db },
          );
          if (hits.length === 0) return [];
          // The backend only proposes candidates. Tenant, room, trash state and permissions come from Better Files'
          // own tables, so a stale or shared index cannot reveal anything.
          const nodes = await context.db.findMany<DataRoomNode>('nodes', {
            where: {
              tenantId: context.tenantId,
              roomId: room.id,
              id: { in: [...new Set(hits.map((hit) => hit.nodeId))] },
              deletedAt: { isNull: true },
              ...(input.kind ? { kind: input.kind } : {}),
            },
          });
          const masks = await context.capabilitiesOf(nodes);
          const byId = new Map(nodes.map((node) => [node.id, node]));
          const protectedText = await copyProtected(
            context.db,
            context.tenantId,
            nodes.filter((node) => node.kind === 'document').map((node) => node.id),
          );
          const seen = new Set<string>();
          const results = hits
            .filter((hit) => {
              if (seen.has(hit.nodeId) || !byId.has(hit.nodeId)) return false;
              seen.add(hit.nodeId);
              return ((masks.get(hit.nodeId) ?? 0) & Capability.LIST) !== 0;
            })
            .map((hit) => {
              const node = byId.get(hit.nodeId)!;
              const mask = masks.get(hit.nodeId) ?? 0;
              const text = mayReadText(mask, protectedText.has(hit.nodeId))
                ? hit.snippet
                : undefined;
              return {
                nodeId: node.id,
                kind: node.kind,
                name: node.name,
                parentId: node.parentId,
                score: hit.score,
                ...(text ? { snippet: text } : {}),
              };
            })
            .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
          await context.activity({
            roomId: room.id,
            action: 'search.performed',
            metadata: { q: input.q.slice(0, 100), results: results.length },
          });
          return results.slice(0, input.limit ?? 50);
        },
      }),
      reindex: endpoint({
        operation: {
          action: 'better-files:search:reindex',
          target: 'room',
          mutates: false,
          allowClosed: true,
        },
        input: v.object({ roomId: v.id() }),
        target: (input) => ({ roomId: input.roomId }),
        async handler(context) {
          const room = context.room!;
          const nodes = await context.db.findMany<DataRoomNode>('nodes', {
            where: { tenantId: context.tenantId, roomId: room.id, deletedAt: { isNull: true } },
          });
          const indexing: IndexContext = {
            now: context.now,
            logger: context.logger,
            readVersion: (_tenantId, versionId) => context.readVersion(versionId),
          };
          for (const node of nodes)
            await index(indexing, context.db, context.tenantId, node.id, true);
          return { indexed: nodes.filter((node) => node.parentId).length };
        },
      }),
    },
  });
  // Plugins that read the index (the AI plugin) find the backend here, from `init({ plugins })`.
  return Object.assign(plugin, { backend });
}
