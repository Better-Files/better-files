import {
  liveInvalidations,
  QueryCache,
  runQuery,
  standardQueries,
  uploadInvalidations,
  type BetterFilesClient,
  type OperationResult,
  type QueryDefinition,
  type RoomActivity,
  type UploadInput,
  type UploadProgress,
} from '@better-files/client';

/** The Svelte store contract: `$store` works in Svelte 4 and 5 components without importing svelte here. */
export interface Readable<T> {
  subscribe(run: (value: T) => void): () => void;
}

export interface QueryState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
}

export interface QueryStore<T> extends Readable<QueryState<T>> {
  /** Fetches again, keeping the current data while it loads. */
  refresh(): Promise<void>;
}

export interface UploadItem {
  id: string;
  filename: string;
  progress: UploadProgress;
  status: 'uploading' | 'done' | 'failed';
  error?: Error;
  documentId?: string;
}

/** A writable-backed readable: the minimal store the bindings need. */
function state<T>(initial: T) {
  let value = initial;
  const subscribers = new Set<(value: T) => void>();
  return {
    get: () => value,
    set(next: T) {
      value = next;
      for (const run of subscribers) run(value);
    },
    subscribe(run: (value: T) => void) {
      subscribers.add(run);
      run(value);
      return () => {
        subscribers.delete(run);
      };
    },
  };
}

/**
 * Typed Svelte stores for one Better Files server type:
 *
 * ```svelte
 * <script lang="ts">
 *   import { rooms } from '$lib/better-files';           // createBetterFilesSvelte<typeof dr>(client)
 *   const index = rooms.roomIndex(data.roomId);
 * </script>
 * {#each $index.data ?? [] as node}<p>{node.index} {node.name}</p>{/each}
 * ```
 *
 * Stores load when first subscribed and share one cache, so writes and uploads refresh every view.
 */
export function createBetterFilesSvelte<T extends { api: object }>(
  client: BetterFilesClient<T>,
  options: { cache?: QueryCache } = {},
) {
  const cache = options.cache ?? new QueryCache();

  /** Any read, cached under `key`; a `null` key never fetches. */
  function query<O>(
    key: string | null,
    fetcher: (client: BetterFilesClient<T>) => Promise<O>,
  ): QueryStore<O> {
    const read = (): QueryState<O> => {
      const entry = key ? cache.get(key) : undefined;
      return {
        data: entry?.data as O | undefined,
        error: entry?.error,
        loading: key !== null && (entry === undefined || entry.loading),
      };
    };
    const subscribers = new Set<(value: QueryState<O>) => void>();
    let stop: (() => void) | undefined;
    const ensure = () => {
      if (key && !cache.get(key)) void cache.load(key, () => fetcher(client));
    };
    return {
      subscribe(run) {
        subscribers.add(run);
        if (subscribers.size === 1)
          stop = cache.subscribe(() => {
            // An invalidation dropped the entry while someone is watching: load it again.
            ensure();
            const value = read();
            for (const subscriber of subscribers) subscriber(value);
          });
        ensure();
        run(read());
        return () => {
          subscribers.delete(run);
          if (subscribers.size === 0) stop?.();
        };
      },
      refresh: async () => {
        if (key) await cache.load(key, () => fetcher(client), true);
      },
    };
  }

  const standard = <G extends string, M extends string>(definition: QueryDefinition<G, M> | null) =>
    query(
      definition?.key ?? null,
      (c) => runQuery(c, definition!) as Promise<OperationResult<T, G, M>>,
    );

  type Id = string | null | undefined;

  /** Capabilities for many nodes; the value has `can(nodeId, capability)`. */
  function capabilities(roomId: Id, nodeIds: readonly string[]) {
    const definition =
      roomId && nodeIds.length ? standardQueries.capabilities(roomId, nodeIds) : null;
    const inner = query(
      definition?.key ?? null,
      (c) => runQuery(c, definition!) as Promise<Record<string, string[]>>,
    );
    type Value = QueryState<Record<string, string[]>> & {
      can(nodeId: string, capability: string): boolean;
    };
    return {
      subscribe(run: (value: Value) => void) {
        return inner.subscribe((value) =>
          run({
            ...value,
            can: (nodeId, capability) => value.data?.[nodeId]?.includes(capability) ?? false,
          }),
        );
      },
      refresh: inner.refresh,
    };
  }

  /** Upload progress for every file started through `uploads.upload`. */
  function createUploads() {
    const items = state<UploadItem[]>([]);
    const update = (itemId: string, patch: Partial<UploadItem>) =>
      items.set(items.get().map((item) => (item.id === itemId ? { ...item, ...patch } : item)));
    return {
      subscribe: items.subscribe,
      async upload(input: UploadInput) {
        const itemId = Math.random().toString(36).slice(2);
        const filename =
          input.filename ??
          (typeof File !== 'undefined' && input.file instanceof File ? input.file.name : 'file');
        const total = input.file instanceof Uint8Array ? input.file.byteLength : input.file.size;
        items.set([
          ...items.get(),
          { id: itemId, filename, progress: { loaded: 0, total, ratio: 0 }, status: 'uploading' },
        ]);
        try {
          const result = await client.upload({
            ...input,
            onProgress: (progress) => {
              update(itemId, { progress });
              input.onProgress?.(progress);
            },
          });
          update(itemId, { status: 'done', documentId: result.document.id });
          for (const prefix of uploadInvalidations(input)) cache.invalidate(prefix);
          return result;
        } catch (error) {
          update(itemId, {
            status: 'failed',
            error: error instanceof Error ? error : new Error(String(error)),
          });
          throw error;
        }
      },
      clear: () => items.set(items.get().filter((item) => item.status === 'uploading')),
    };
  }

  /** Wraps a write: `$rename.pending`, `rename.run(...)`; invalidates cache prefixes after success. */
  function action<A extends unknown[], O>(
    run: (client: BetterFilesClient<T>, ...args: A) => Promise<O>,
    invalidates?: string | string[],
  ) {
    const status = state<{ pending: boolean; error?: Error }>({ pending: false });
    return {
      subscribe: status.subscribe,
      async run(...args: A) {
        status.set({ pending: true });
        try {
          const result = await run(client, ...args);
          for (const prefix of typeof invalidates === 'string'
            ? [invalidates]
            : (invalidates ?? []))
            cache.invalidate(prefix);
          status.set({ pending: false });
          return result;
        } catch (error) {
          status.set({
            pending: false,
            error: error instanceof Error ? error : new Error(String(error)),
          });
          throw error;
        }
      },
    };
  }

  /** A room's latest activity; while subscribed it keeps the room's other stores live. */
  function live(
    roomId: Id,
    onActivity?: (activity: RoomActivity) => void,
  ): Readable<RoomActivity | undefined> {
    const latest = state<RoomActivity | undefined>(undefined);
    let subscribers = 0;
    let subscription: { close(): void } | undefined;
    return {
      subscribe(run) {
        const stop = latest.subscribe(run);
        if (subscribers++ === 0 && roomId)
          subscription = client.subscribe(roomId, {
            onActivity(activity) {
              for (const prefix of liveInvalidations(roomId, activity)) cache.invalidate(prefix);
              latest.set(activity);
              onActivity?.(activity);
            },
          });
        return () => {
          stop();
          if (--subscribers === 0) {
            subscription?.close();
            subscription = undefined;
          }
        };
      },
    };
  }

  return {
    client,
    cache,
    query,
    live,
    invalidate: (prefix?: string) => cache.invalidate(prefix),
    rooms: (input: { status?: 'draft' | 'live' | 'closed' | 'archived' } = {}) =>
      standard(standardQueries.rooms(input)),
    room: (roomId: Id) => standard(roomId ? standardQueries.room(roomId) : null),
    roomIndex: (roomId: Id) => standard(roomId ? standardQueries.roomIndex(roomId) : null),
    folder: (nodeId: Id) => standard(nodeId ? standardQueries.folder(nodeId) : null),
    document: (nodeId: Id) => standard(nodeId ? standardQueries.document(nodeId) : null),
    members: (roomId: Id) => standard(roomId ? standardQueries.members(roomId) : null),
    activity: (roomId: Id, options: { limit?: number } = {}) =>
      standard(roomId ? standardQueries.activity(roomId, options) : null),
    capabilities,
    uploads: createUploads(),
    action,
  };
}

export type BetterFilesSvelte<T extends { api: object }> = ReturnType<
  typeof createBetterFilesSvelte<T>
>;
