import { BetterFilesError } from '@better-files/core';
import type { SearchBackend, SearchDocument } from './backend.js';

export interface MeilisearchOptions {
  /** `https://search.example.com` or `http://127.0.0.1:7700`. */
  host: string;
  /** A key allowed to manage the index and its documents (not a search-only key). */
  apiKey?: string;
  /** Index uid. Default `better-files`. One index holds every tenant; queries always filter by tenant and room. */
  index?: string;
  /** Characters of context around a match in snippets (Meilisearch counts words; this is divided by 6). Default 160. */
  snippetLength?: number;
  /**
   * Wait for each write to be applied before returning, so a search right after an upload finds it. Off by
   * default: Meilisearch applies writes asynchronously within milliseconds, and waiting slows event delivery.
   */
  waitForWrites?: boolean;
  /** How long to wait for one task. Default 10 s. */
  taskTimeoutMs?: number;
  /** For tests, proxies and runtimes without a global fetch. */
  fetch?: typeof globalThis.fetch;
}

interface MeiliTask {
  taskUid: number;
}

interface MeiliHit {
  nodeId: string;
  _rankingScore?: number;
  _formatted?: { text?: string };
}

const encoder = new TextEncoder();

/** Meilisearch ids allow `[A-Za-z0-9_-]` only; tenant and node ids may hold anything. */
export function meilisearchId(tenantId: string, nodeId: string): string {
  const bytes = encoder.encode(`${tenantId}\u0000${nodeId}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A quoted filter value: Meilisearch filter strings escape `"` and `\` with a backslash. */
const quote = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * Keeps the search index in [Meilisearch](https://www.meilisearch.com) over its HTTP API (no SDK): typo tolerance,
 * prefix matching and relevance ranking for large rooms, and extracted text kept out of your database. Better Files
 * still filters every result by permission, tenant and trash state, so the index only finds candidates.
 *
 * The index is created and configured on first use (`tenantId`, `roomId` and `kind` filterable; `name` ranked above
 * `text`). Meilisearch 1.3 or later.
 */
export function meilisearchBackend(options: MeilisearchOptions): SearchBackend {
  const host = options.host.replace(/\/+$/, '');
  const uid = options.index ?? 'better-files';
  const doFetch = options.fetch ?? globalThis.fetch;
  const cropLength = Math.max(5, Math.round((options.snippetLength ?? 160) / 6));
  const taskTimeout = options.taskTimeoutMs ?? 10_000;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await doFetch(`${host}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!response.ok) {
      const error = new BetterFilesError(
        'INTERNAL_ERROR',
        `Meilisearch ${method} ${path} failed (${response.status}): ${String(json.message ?? text)}`,
      );
      (error as { meiliCode?: unknown }).meiliCode = json.code;
      throw error;
    }
    return json as T;
  }

  async function waitFor(task: MeiliTask): Promise<void> {
    const deadline = Date.now() + taskTimeout;
    for (let delay = 5; ; delay = Math.min(delay * 2, 250)) {
      const state = await call<{ status: string; error?: { message?: string } }>(
        'GET',
        `/tasks/${task.taskUid}`,
      );
      if (state.status === 'succeeded') return;
      if (state.status === 'failed' || state.status === 'canceled')
        throw new BetterFilesError(
          'INTERNAL_ERROR',
          `Meilisearch task ${task.taskUid} ${state.status}: ${state.error?.message ?? ''}`,
        );
      if (Date.now() > deadline)
        throw new BetterFilesError('INTERNAL_ERROR', `Meilisearch task ${task.taskUid} timed out`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // Index creation and settings are applied once per process, and always waited for: a filter on an attribute that
  // is not yet filterable fails.
  let ready: Promise<void> | undefined;
  function ensureIndex(): Promise<void> {
    ready ??= (async () => {
      try {
        await waitFor(await call<MeiliTask>('POST', '/indexes', { uid, primaryKey: 'id' }));
      } catch (error) {
        if (
          (error as { meiliCode?: unknown }).meiliCode !== 'index_already_exists' &&
          !String((error as Error).message).includes('already exists')
        )
          throw error;
      }
      await waitFor(
        await call<MeiliTask>('PATCH', `/indexes/${encodeURIComponent(uid)}/settings`, {
          filterableAttributes: ['tenantId', 'roomId', 'kind'],
          searchableAttributes: ['name', 'text'],
          displayedAttributes: ['id', 'nodeId', 'roomId', 'kind', 'name', 'text'],
        }),
      );
    })().catch((error: unknown) => {
      ready = undefined;
      throw error;
    });
    return ready;
  }

  const write = async (task: MeiliTask) => {
    if (options.waitForWrites) await waitFor(task);
  };
  const documents = `/indexes/${encodeURIComponent(uid)}/documents`;

  return {
    id: 'meilisearch',
    async upsert(document: SearchDocument) {
      await ensureIndex();
      // PUT merges into the stored document, so a rename (no `text`) keeps the text already indexed.
      await write(
        await call<MeiliTask>('PUT', documents, [
          {
            id: meilisearchId(document.tenantId, document.nodeId),
            tenantId: document.tenantId,
            roomId: document.roomId,
            nodeId: document.nodeId,
            kind: document.kind,
            name: document.name,
            updatedAt: document.updatedAt,
            ...(document.text === undefined
              ? {}
              : { text: document.text || null, versionId: document.versionId ?? null }),
          },
        ]),
      );
    },
    async removeRoom({ tenantId, roomId }) {
      await ensureIndex();
      await write(
        await call<MeiliTask>('POST', `${documents}/delete`, {
          filter: `tenantId = ${quote(tenantId)} AND roomId = ${quote(roomId)}`,
        }),
      );
    },
    async query(query) {
      await ensureIndex();
      const filter = [
        `tenantId = ${quote(query.tenantId)}`,
        `roomId = ${quote(query.roomId)}`,
        ...(query.kind ? [`kind = ${quote(query.kind)}`] : []),
      ].join(' AND ');
      const result = await call<{ hits: MeiliHit[] }>(
        'POST',
        `/indexes/${encodeURIComponent(uid)}/search`,
        {
          q: query.match === 'any' ? query.words.join(' ') : query.q,
          // `last` drops query words from the end until something matches: callers put important words first.
          matchingStrategy: query.match === 'any' ? 'last' : 'all',
          filter,
          limit: query.limit,
          attributesToRetrieve: ['nodeId'],
          attributesToCrop: ['text'],
          cropLength,
          cropMarker: '…',
          showRankingScore: true,
        },
      );
      return result.hits.map((hit, rank) => {
        const excerpt = hit._formatted?.text?.replace(/\s+/g, ' ').trim();
        return {
          nodeId: hit.nodeId,
          // Meilisearch returns hits best first; the ranking score (0..1) keeps that order.
          score: hit._rankingScore ?? 1 - rank / (result.hits.length + 1),
          ...(excerpt ? { snippet: excerpt } : {}),
        };
      });
    },
    async texts({ tenantId, nodeIds }) {
      await ensureIndex();
      const out = new Map<string, string>();
      for (const nodeId of new Set(nodeIds)) {
        const path = `${documents}/${meilisearchId(tenantId, nodeId)}?fields=nodeId,text`;
        try {
          const document = await call<{ nodeId?: string; text?: string | null }>('GET', path);
          if (document.nodeId === nodeId && document.text) out.set(nodeId, document.text);
        } catch (error) {
          if ((error as { meiliCode?: unknown }).meiliCode !== 'document_not_found') throw error;
        }
      }
      return out;
    },
  };
}
