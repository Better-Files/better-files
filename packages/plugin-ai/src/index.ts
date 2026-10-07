import {
  Capability,
  BetterFilesError,
  definePlugin,
  endpoint,
  notFound,
  v,
  type DatabaseAdapter,
  type DataRoomDocument,
  type DataRoomNode,
  type BetterFilesPlugin,
  type PluginContext,
} from '@better-files/core';

export { claudeProvider, type ClaudeProviderOptions } from './claude.js';

/** One document excerpt the model may read. */
export interface AiSource {
  id: string;
  title: string;
  text: string;
}

export interface AiAnswer {
  text: string;
  /** Passages the answer relies on, by source. */
  citations: { sourceId: string; quote: string }[];
  /** The model declined to answer. */
  refused: boolean;
  model?: string;
}

/** Any model behind a small interface; `claudeProvider()` is the default implementation. */
export interface AiProvider {
  answer(input: {
    question: string;
    sources: readonly AiSource[];
    signal?: AbortSignal;
  }): Promise<AiAnswer>;
  summarize(input: {
    source: AiSource;
    instructions?: string;
    signal?: AbortSignal;
  }): Promise<AiAnswer>;
}

export interface AiOptions {
  provider: AiProvider;
  /** Documents sent per question. Default 8. */
  maxSources?: number;
  /** Characters of each document sent. Default 20 000. */
  maxCharsPerSource?: number;
  /**
   * Require `COPY_TEXT` on every document the model reads, not only on documents flagged view-only or no-copy.
   * For rooms where text must never leave the viewer for anyone without copy rights. Default false.
   */
  requireCopyText?: boolean;
}

/** The search plugin's index, as this plugin uses it (`searchPlugin()` exposes it as `backend`). */
interface SearchIndex {
  query(
    query: {
      tenantId: string;
      roomId: string;
      q: string;
      words: readonly string[];
      kind?: 'folder' | 'document';
      match?: 'all' | 'any';
      limit: number;
    },
    context: { db: DatabaseAdapter },
  ): Promise<{ nodeId: string; score: number }[]>;
  texts(
    input: { tenantId: string; nodeIds: readonly string[] },
    context: { db: DatabaseAdapter },
  ): Promise<Map<string, string>>;
}

const stopwords = new Set(
  'a an and are as at be by can do does for from has have how in is it its of on or that the this to was were what when where which who why will with within'.split(
    ' ',
  ),
);

const keywords = (question: string) =>
  [
    ...new Set(
      question
        .normalize('NFKC')
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word.length > 2 && !stopwords.has(word)),
    ),
  ]
    .sort((a, b) => b.length - a.length)
    .slice(0, 6);

/** The part of a long document around the question's keywords, within `limit` characters. */
function excerpt(text: string, words: readonly string[], limit: number): string {
  if (text.length <= limit) return text;
  const lower = text.toLowerCase();
  const hits = words.flatMap((word) => {
    const out: number[] = [];
    for (
      let at = lower.indexOf(word);
      at >= 0 && out.length < 20;
      at = lower.indexOf(word, at + word.length)
    )
      out.push(at);
    return out;
  });
  if (hits.length === 0) return text.slice(0, limit);
  const window = Math.max(400, Math.floor(limit / Math.min(hits.length, 10)));
  const ranges = hits
    .sort((a, b) => a - b)
    .map(
      (at) =>
        [Math.max(0, at - window / 2), Math.min(text.length, at + window / 2)] as [number, number],
    );
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  let out = '';
  for (const [start, end] of merged) {
    const piece = `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}\n`;
    if (out.length + piece.length > limit) break;
    out += piece;
  }
  return out || text.slice(0, limit);
}

const folded = (text: string) => text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Permission-aware AI over a room: questions answered from the documents the asker may view, with citations, and
 * document summaries. Retrieval goes through the search plugin's index (enable `indexContent`), whatever its
 * backend. Before any text is sent to the model, every candidate is checked against Better Files' own tables: same
 * tenant and room, not in the trash, `VIEW` for the asker, and `COPY_TEXT` when the document is view-only or
 * no-copy. The model never sees what the asker could not open, and citations are kept only when they quote a
 * document the asker was given.
 */
export function aiPlugin(options: AiOptions) {
  const maxSources = options.maxSources ?? 8;
  const maxChars = options.maxCharsPerSource ?? 20_000;
  const action = 'better-files:ai:query';
  let index: SearchIndex | undefined;

  const searchIndex = (): SearchIndex => {
    if (!index)
      throw new BetterFilesError('INTERNAL_ERROR', 'The AI plugin needs the search plugin');
    return index;
  };

  /** Documents of the target room the caller may read as text, from the given candidates. */
  async function readable(
    context: PluginContext,
    roomId: string,
    nodeIds: readonly string[],
  ): Promise<Map<string, DataRoomNode>> {
    if (nodeIds.length === 0) return new Map();
    const nodes = await context.db.findMany<DataRoomNode>('nodes', {
      where: {
        tenantId: context.tenantId,
        roomId,
        kind: 'document',
        id: { in: [...nodeIds] },
        deletedAt: { isNull: true },
      },
    });
    const masks = await context.capabilitiesOf(nodes);
    const documents = await context.db.findMany<DataRoomDocument>('documents', {
      where: { tenantId: context.tenantId, id: { in: nodes.map((node) => node.id) } },
    });
    const flags = new Map(documents.map((document) => [document.id, document.flags ?? {}]));
    return new Map(
      nodes
        .filter((node) => {
          const mask = masks.get(node.id) ?? 0;
          if ((mask & Capability.VIEW) === 0) return false;
          const document = flags.get(node.id);
          const protectedText =
            options.requireCopyText || !document || document.viewOnly || document.noCopy;
          return !protectedText || (mask & Capability.COPY_TEXT) !== 0;
        })
        .map((node) => [node.id, node]),
    );
  }

  return definePlugin({
    id: 'ai',
    dependsOn: ['search'],
    actions: [action],
    accessModel: [
      {
        relations: ['owner', 'admin', 'publisher', 'editor', 'contributor', 'viewer', 'auditor'],
        actions: [action],
      },
    ],
    init({ plugins }) {
      const search = plugins.find((plugin) => plugin.id === 'search') as
        | (BetterFilesPlugin & { backend?: SearchIndex })
        | undefined;
      const backend = search?.backend;
      if (!backend || typeof backend.query !== 'function' || typeof backend.texts !== 'function')
        throw new BetterFilesError(
          'INVALID_INPUT',
          'The AI plugin needs searchPlugin() from @better-files/plugin-search, with a backend that implements texts()',
        );
      index = backend;
    },
    endpoints: {
      ask: endpoint({
        operation: { action, target: 'room', mutates: false, allowClosed: true },
        input: v.object({ roomId: v.id(), question: v.string({ min: 3, max: 2000, trim: true }) }),
        target: (input) => ({ roomId: input.roomId }),
        async handler(context, input) {
          const room = context.room!;
          const words = keywords(input.question);
          const hits = words.length
            ? await searchIndex().query(
                {
                  tenantId: context.tenantId,
                  roomId: room.id,
                  q: input.question,
                  words,
                  kind: 'document',
                  match: 'any',
                  limit: 200,
                },
                { db: context.db },
              )
            : [];
          const scores = new Map<string, number>();
          for (const hit of hits)
            scores.set(hit.nodeId, Math.max(scores.get(hit.nodeId) ?? -Infinity, hit.score));
          const allowed = await readable(context, room.id, [...scores.keys()]);
          // Text is fetched only for documents that passed the permission check.
          const candidates = [...allowed.keys()]
            .sort((a, b) => scores.get(b)! - scores.get(a)!)
            .slice(0, maxSources * 2);
          const texts = await searchIndex().texts(
            { tenantId: context.tenantId, nodeIds: candidates },
            { db: context.db },
          );
          const ranked = candidates.filter((id) => texts.get(id)).slice(0, maxSources);
          if (ranked.length === 0)
            return {
              answer: 'None of the documents you can view in this room address this question.',
              citations: [],
              sources: [],
              refused: false,
            };
          const sources: AiSource[] = ranked.map((id) => ({
            id,
            title: allowed.get(id)!.name,
            text: excerpt(texts.get(id)!, words, maxChars),
          }));
          const result = await options.provider.answer({ question: input.question, sources });
          await context.activity({
            roomId: room.id,
            action: 'ai.asked',
            metadata: {
              question: input.question.slice(0, 300),
              sources: sources.map((s) => s.id),
              refused: result.refused,
            },
          });
          const byId = new Map(sources.map((source) => [source.id, source]));
          return {
            answer: result.text,
            refused: result.refused,
            // A citation must point at a document the asker was given and quote text from it, so a provider (or a
            // prompt-injected document) cannot attribute words to documents the asker never saw.
            citations: result.citations
              .filter((citation) => {
                const source = byId.get(citation.sourceId);
                return (
                  source !== undefined &&
                  folded(citation.quote).length > 0 &&
                  folded(source.text).includes(folded(citation.quote))
                );
              })
              .map((citation) => ({
                nodeId: citation.sourceId,
                name: byId.get(citation.sourceId)!.title,
                quote: citation.quote,
              })),
            sources: sources.map((source) => ({ nodeId: source.id, name: source.title })),
          };
        },
      }),
      summarize: endpoint({
        operation: {
          action,
          target: 'node',
          capabilities: ['VIEW'],
          mutates: false,
          allowClosed: true,
        },
        input: v.object({ nodeId: v.id(), instructions: v.optional(v.string({ max: 1000 })) }),
        target: (input) => ({ nodeId: input.nodeId }),
        async handler(context, input) {
          const node = context.node!;
          if (node.kind !== 'document')
            throw new BetterFilesError('INVALID_INPUT', 'Only documents can be summarized');
          if (!(await readable(context, node.roomId, [node.id])).has(node.id))
            throw new BetterFilesError(
              'FORBIDDEN',
              'This document is view only: its text cannot be sent to the assistant',
            );
          const text = (
            await searchIndex().texts(
              { tenantId: context.tenantId, nodeIds: [node.id] },
              { db: context.db },
            )
          ).get(node.id);
          if (!text)
            throw notFound(
              'Indexed text for this document (enable indexContent in the search plugin)',
            );
          const source = { id: node.id, title: node.name, text: text.slice(0, maxChars * 4) };
          const result = await options.provider.summarize({
            source,
            ...(input.instructions ? { instructions: input.instructions } : {}),
          });
          await context.activity({
            roomId: node.roomId,
            action: 'ai.summarized',
            nodeId: node.id,
            metadata: { refused: result.refused },
          });
          return {
            summary: result.text,
            refused: result.refused,
            citations: result.citations
              .filter(
                (c) =>
                  c.sourceId === node.id &&
                  folded(c.quote).length > 0 &&
                  folded(source.text).includes(folded(c.quote)),
              )
              .map((c) => c.quote),
          };
        },
      }),
    },
  });
}
