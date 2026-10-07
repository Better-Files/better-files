import type { DatabaseAdapter } from '@better-files/core';

/** What the index holds for one folder or document. */
export interface SearchDocument {
  tenantId: string;
  roomId: string;
  nodeId: string;
  kind: 'folder' | 'document';
  name: string;
  /**
   * Extracted text of the current version (empty when there is none). Undefined on name-only changes (renames,
   * moves): the backend then keeps the text and `versionId` it already holds.
   */
  text?: string;
  versionId?: string;
  updatedAt: number;
}

export interface SearchQuery {
  tenantId: string;
  roomId: string;
  /** The query as typed (trimmed). */
  q: string;
  /** Normalized, de-duplicated words of the query (at most 8). */
  words: readonly string[];
  kind?: 'folder' | 'document';
  /**
   * `all` (default): every word must match (the search box). `any`: items matching more words rank higher, but one
   * is enough (retrieval for AI questions, where most words of a sentence are not in the document).
   */
  match?: 'all' | 'any';
  /** How many candidates to return; the plugin filters them by permission afterwards. */
  limit: number;
}

export interface SearchHit {
  nodeId: string;
  /** Higher ranks first. Only compared between hits of the same query. */
  score: number;
  /** A short excerpt of the matched text. The plugin drops it for callers who cannot view the document. */
  snippet?: string;
}

/** Where the plugin also has the operation's database, for backends that keep the index in it. */
export interface BackendContext {
  db: DatabaseAdapter;
}

/**
 * Where the search index lives. The plugin decides what to index and filters every result by the caller's
 * permissions (and by tenant and trash state, from Better Files' own tables), so a backend only has to find candidates:
 * it never decides who may see what.
 */
export interface SearchBackend {
  readonly id: string;
  /** Adds or replaces the entry for `document.nodeId`. */
  upsert(document: SearchDocument, context: BackendContext): Promise<void>;
  /** Drops every entry of a room (the room was deleted). */
  removeRoom(input: { tenantId: string; roomId: string }, context: BackendContext): Promise<void>;
  query(query: SearchQuery, context: BackendContext): Promise<SearchHit[]>;
  /**
   * The indexed text of these nodes, for features that read it after their own permission checks (the AI plugin).
   * Nodes without text are left out.
   */
  texts(
    input: { tenantId: string; nodeIds: readonly string[] },
    context: BackendContext,
  ): Promise<Map<string, string>>;
}

interface SearchEntry {
  id: string;
  tenantId: string;
  roomId: string;
  nodeId: string;
  kind: 'folder' | 'document';
  versionId?: string;
  name: string;
  /** Lower-cased, whitespace-folded name and text: what queries match against. */
  haystack: string;
  text?: string;
  updatedAt: number;
  createdAt: number;
}

export const normalize = (text: string) =>
  text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');

export function snippet(text: string, words: readonly string[], radius = 80): string | undefined {
  const lower = text.toLowerCase();
  const at = Math.min(...words.map((word) => lower.indexOf(word)).filter((index) => index >= 0));
  if (!Number.isFinite(at)) return undefined;
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}

/**
 * The default backend: the plugin's `searchEntries` table in your own database, matched by substring. Needs no
 * other service; fine for rooms of up to tens of thousands of items. Extracted text is stored in plain text in the
 * database, so enable `indexContent` where the database is protected at rest.
 */
export function sqlSearchBackend(): SearchBackend {
  return {
    id: 'sql',
    async upsert(document, { db }) {
      const { tenantId, nodeId } = document;
      const existing = await db.findOne<SearchEntry>('searchEntries', { tenantId, nodeId });
      const keep = document.text === undefined;
      const text = keep ? existing?.text : document.text;
      const versionId = keep ? existing?.versionId : document.versionId;
      const fields = {
        roomId: document.roomId,
        kind: document.kind,
        name: document.name,
        haystack: normalize(`${document.name}\n${text ?? ''}`),
        updatedAt: document.updatedAt,
      };
      await db.transaction(async (tx) => {
        if (existing)
          await tx.update(
            'searchEntries',
            { id: existing.id, tenantId },
            { ...fields, text: text || null, versionId: versionId ?? null },
          );
        else
          await tx.insert('searchEntries', {
            id: `se_${nodeId}`,
            tenantId,
            nodeId,
            ...fields,
            ...(text ? { text } : {}),
            ...(versionId ? { versionId } : {}),
            createdAt: document.updatedAt,
          });
      });
    },
    async removeRoom({ tenantId, roomId }, { db }) {
      await db.transaction((tx) => tx.delete('searchEntries', { tenantId, roomId }));
    },
    async query(query, { db }) {
      const where = {
        tenantId: query.tenantId,
        roomId: query.roomId,
        ...(query.kind ? { kind: query.kind } : {}),
      };
      if (query.match === 'any') {
        // One lookup per word; entries score by how many words they hold and how often.
        const scored = new Map<string, { entry: SearchEntry; score: number }>();
        for (const word of query.words) {
          const entries = await db.findMany<SearchEntry>('searchEntries', {
            where: { ...where, haystack: { contains: word } },
            limit: query.limit,
          });
          for (const entry of entries) {
            const current = scored.get(entry.nodeId) ?? { entry, score: 0 };
            current.score += 1 + Math.min(entry.haystack.split(word).length - 1, 10) / 10;
            scored.set(entry.nodeId, current);
          }
        }
        return [...scored.values()]
          .sort((a, b) => b.score - a.score)
          .slice(0, query.limit)
          .map(({ entry, score }) => {
            const excerpt = entry.text ? snippet(entry.text, query.words) : undefined;
            return { nodeId: entry.nodeId, score, ...(excerpt ? { snippet: excerpt } : {}) };
          });
      }
      const longest = query.words.reduce((a, b) => (b.length > a.length ? b : a));
      const candidates = await db.findMany<SearchEntry>('searchEntries', {
        where: { ...where, haystack: { contains: longest } },
        limit: query.limit,
      });
      return candidates
        .filter((entry) => query.words.every((word) => entry.haystack.includes(word)))
        .map((entry) => {
          const excerpt = entry.text ? snippet(entry.text, query.words) : undefined;
          const nameHits = query.words.filter((word) =>
            normalize(entry.name).includes(word),
          ).length;
          return {
            nodeId: entry.nodeId,
            score: nameHits * 10 + (excerpt ? 1 : 0),
            ...(excerpt ? { snippet: excerpt } : {}),
          };
        });
    },
    async texts({ tenantId, nodeIds }, { db }) {
      if (nodeIds.length === 0) return new Map();
      const entries = await db.findMany<SearchEntry>('searchEntries', {
        where: { tenantId, nodeId: { in: [...nodeIds] } },
      });
      return new Map(
        entries.filter((entry) => entry.text).map((entry) => [entry.nodeId, entry.text!]),
      );
    },
  };
}
