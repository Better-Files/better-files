/**
 * The query cache and standard reads the UI bindings (React, Vue, Svelte) share: keyed results, deduplicated
 * in-flight requests, and invalidation by key prefix after writes.
 */

export interface CacheEntry {
  data?: unknown;
  error?: Error;
  loading: boolean;
  promise?: Promise<void>;
  loadedAt?: number;
}

export class QueryCache {
  private entries = new Map<string, CacheEntry>();
  private listeners = new Set<() => void>();
  private version = 0;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Changes whenever any entry changes. */
  snapshot = () => this.version;

  get(key: string): CacheEntry | undefined {
    return this.entries.get(key);
  }

  private emit() {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  /** Loads `key` unless it is cached or loading; `force` refetches while keeping the current data. */
  load(key: string, fetcher: () => Promise<unknown>, force = false): Promise<void> {
    const current = this.entries.get(key);
    if (current?.promise) return current.promise;
    if (current && !force && (current.data !== undefined || current.error))
      return Promise.resolve();
    const promise = fetcher().then(
      (data) => {
        this.entries.set(key, { data, loading: false, loadedAt: Date.now() });
        this.emit();
      },
      (error: unknown) => {
        this.entries.set(key, {
          ...(current?.data !== undefined ? { data: current.data } : {}),
          error: error instanceof Error ? error : new Error(String(error)),
          loading: false,
        });
        this.emit();
      },
    );
    this.entries.set(key, { ...current, loading: true, promise });
    this.emit();
    return promise;
  }

  /** Drops cached results whose key starts with `prefix` (all when omitted); mounted queries refetch. */
  invalidate(prefix = '') {
    for (const key of [...this.entries.keys()])
      if (key.startsWith(prefix)) this.entries.delete(key);
    this.emit();
  }
}

export interface QueryDefinition<G extends string = string, M extends string = string> {
  key: string;
  group: G;
  method: M;
  input: Record<string, unknown>;
}

const query = <const G extends string, const M extends string>(
  key: string,
  group: G,
  method: M,
  input: Record<string, unknown>,
): QueryDefinition<G, M> => ({ key, group, method, input });

/** The reads every binding offers, with the cache keys uploads and writes invalidate. */
export const standardQueries = {
  rooms: (input: { status?: 'draft' | 'live' | 'closed' | 'archived' } = {}) =>
    query(`rooms:${input.status ?? ''}`, 'rooms', 'list', input),
  room: (roomId: string) => query(`room:${roomId}`, 'rooms', 'get', { roomId }),
  roomIndex: (roomId: string) => query(`index:${roomId}`, 'rooms', 'index', { roomId }),
  folder: (nodeId: string) => query(`folder:${nodeId}`, 'folders', 'list', { nodeId }),
  document: (nodeId: string) => query(`document:${nodeId}`, 'documents', 'get', { nodeId }),
  members: (roomId: string) => query(`members:${roomId}`, 'members', 'list', { roomId }),
  activity: (roomId: string, options: { limit?: number } = {}) =>
    query(`activity:${roomId}:${options.limit ?? ''}`, 'activity', 'list', { roomId, ...options }),
  capabilities: (roomId: string, nodeIds: readonly string[]) => {
    const sorted = [...new Set(nodeIds)].sort();
    return query(`caps:${roomId}:${sorted.join(',')}`, 'permissions', 'capabilities', {
      roomId,
      nodeIds: sorted,
    });
  },
};

/** Runs a query definition on a client. */
export const runQuery = (client: object, definition: QueryDefinition): Promise<unknown> =>
  (client as Record<string, Record<string, (input: object) => Promise<unknown>>>)[
    definition.group
  ]![definition.method]!(definition.input);

/** Cache prefixes to drop after an upload lands. */
export const uploadInvalidations = (input: { parentId?: string; documentId?: string }) => [
  `folder:${input.parentId ?? ''}`,
  'index:',
  ...(input.documentId ? [`document:${input.documentId}`] : []),
];
