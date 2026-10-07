import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
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

export interface QueryState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
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

/**
 * Typed React bindings for one Better Files server type:
 *
 * ```tsx
 * export const { BetterFilesProvider, useRoomIndex, useFolder, useUpload, Can } = createBetterFilesReact<typeof dr>();
 * <BetterFilesProvider client={createBetterFilesClient<typeof dr>({ tenantId })}>…</BetterFilesProvider>
 * ```
 */
export function createBetterFilesReact<T extends { api: object }>() {
  type Client = BetterFilesClient<T>;
  interface Value {
    client: Client;
    store: QueryCache;
  }
  const Context = createContext<Value | null>(null);

  function BetterFilesProvider(props: { client: Client; children?: ReactNode }) {
    const store = useMemo(() => new QueryCache(), []);
    const value = useMemo(() => ({ client: props.client, store }), [props.client, store]);
    return <Context.Provider value={value}>{props.children}</Context.Provider>;
  }

  function useValue(): Value {
    const value = useContext(Context);
    if (!value) throw new Error('Wrap the tree in <BetterFilesProvider client={…}>');
    return value;
  }

  const useClient = (): Client => useValue().client;

  /** Invalidates cached queries by key prefix: `invalidate('folder:')`, or everything. */
  function useInvalidate() {
    const { store } = useValue();
    return useCallback((prefix?: string) => store.invalidate(prefix), [store]);
  }

  /** Any read, cached under `key`; a `null` key skips fetching (for inputs that are not ready yet). */
  function useQuery<O>(key: string | null, fetcher: (client: Client) => Promise<O>): QueryState<O> {
    const { client, store } = useValue();
    useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
    const latest = useRef(fetcher);
    latest.current = fetcher;
    const entry = key ? store.get(key) : undefined;
    useEffect(() => {
      if (key) void store.load(key, () => latest.current(client));
    }, [key, client, store, entry === undefined]);
    const refresh = useCallback(async () => {
      if (key) await store.load(key, () => latest.current(client), true);
    }, [key, client, store]);
    return {
      data: entry?.data as O | undefined,
      error: entry?.error,
      loading: key !== null && (entry === undefined || entry.loading),
      refresh,
    };
  }

  /** A standard read; `null` when its input is not ready. */
  function useStandard<G extends string, M extends string>(
    definition: QueryDefinition<G, M> | null,
  ) {
    return useQuery(
      definition?.key ?? null,
      (client) => runQuery(client, definition!) as Promise<OperationResult<T, G, M>>,
    );
  }

  const useRooms = (input: { status?: 'draft' | 'live' | 'closed' | 'archived' } = {}) =>
    useStandard(standardQueries.rooms(input));
  const useRoom = (roomId: string | null | undefined) =>
    useStandard(roomId ? standardQueries.room(roomId) : null);
  const useRoomIndex = (roomId: string | null | undefined) =>
    useStandard(roomId ? standardQueries.roomIndex(roomId) : null);
  const useFolder = (nodeId: string | null | undefined) =>
    useStandard(nodeId ? standardQueries.folder(nodeId) : null);
  const useDocument = (nodeId: string | null | undefined) =>
    useStandard(nodeId ? standardQueries.document(nodeId) : null);
  const useMembers = (roomId: string | null | undefined) =>
    useStandard(roomId ? standardQueries.members(roomId) : null);
  const useActivity = (roomId: string | null | undefined, options: { limit?: number } = {}) =>
    useStandard(roomId ? standardQueries.activity(roomId, options) : null);

  /** Capabilities for many nodes of a room in one call; `can(nodeId, 'DOWNLOAD_ORIGINAL')`. */
  function useCapabilities(roomId: string | null | undefined, nodeIds: readonly string[]) {
    const definition =
      roomId && nodeIds.length ? standardQueries.capabilities(roomId, nodeIds) : null;
    const state = useQuery<Record<string, string[]>>(
      definition?.key ?? null,
      (client) => runQuery(client, definition!) as Promise<Record<string, string[]>>,
    );
    const can = useCallback(
      (nodeId: string, capability: string) => state.data?.[nodeId]?.includes(capability) ?? false,
      [state.data],
    );
    return { ...state, can };
  }

  /** Renders children only when the caller holds a capability on a node. Advisory: the server always checks. */
  function Can(props: {
    roomId: string;
    nodeId: string;
    capability: string;
    fallback?: ReactNode;
    children?: ReactNode;
  }) {
    const { can, loading } = useCapabilities(props.roomId, [props.nodeId]);
    if (loading) return null;
    return <>{can(props.nodeId, props.capability) ? props.children : (props.fallback ?? null)}</>;
  }

  /** Uploads with per-file progress; the destination folder's queries refresh when each finishes. */
  function useUpload() {
    const { client, store } = useValue();
    const [items, setItems] = useState<UploadItem[]>([]);
    const upload = useCallback(
      async (input: UploadInput) => {
        const id = Math.random().toString(36).slice(2);
        const filename =
          input.filename ??
          (typeof File !== 'undefined' && input.file instanceof File ? input.file.name : 'file');
        const total = input.file instanceof Uint8Array ? input.file.byteLength : input.file.size;
        const update = (patch: Partial<UploadItem>) =>
          setItems((current) =>
            current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
          );
        setItems((current) => [
          ...current,
          { id, filename, progress: { loaded: 0, total, ratio: 0 }, status: 'uploading' },
        ]);
        try {
          const result = await client.upload({
            ...input,
            onProgress: (progress) => {
              update({ progress });
              input.onProgress?.(progress);
            },
          });
          update({ status: 'done', documentId: result.document.id });
          for (const prefix of uploadInvalidations(input)) store.invalidate(prefix);
          return result;
        } catch (error) {
          update({
            status: 'failed',
            error: error instanceof Error ? error : new Error(String(error)),
          });
          throw error;
        }
      },
      [client, store],
    );
    const clear = useCallback(
      () => setItems((current) => current.filter((item) => item.status === 'uploading')),
      [],
    );
    return { upload, items, clear };
  }

  /**
   * Keeps a room's views live: follows its activity stream and refreshes the affected queries (index, folders,
   * documents, members, capabilities) as changes happen. Returns the latest activity entry.
   */
  function useLiveRoom(
    roomId: string | null | undefined,
    onActivity?: (activity: RoomActivity) => void,
  ) {
    const { client, store } = useValue();
    const [last, setLast] = useState<RoomActivity | undefined>();
    const handler = useRef(onActivity);
    handler.current = onActivity;
    useEffect(() => {
      if (!roomId) return;
      const subscription = client.subscribe(roomId, {
        onActivity(activity) {
          for (const prefix of liveInvalidations(roomId, activity)) store.invalidate(prefix);
          setLast(activity);
          handler.current?.(activity);
        },
      });
      return () => subscription.close();
    }, [roomId, client, store]);
    return last;
  }

  /** Wraps a write: `const rename = useAction((client, name) => client.folders.rename(…), 'folder:')`. */
  function useAction<A extends unknown[], O>(
    action: (client: Client, ...args: A) => Promise<O>,
    invalidates?: string | string[],
  ) {
    const { client, store } = useValue();
    const [state, setState] = useState<{ pending: boolean; error?: Error }>({ pending: false });
    const run = useCallback(
      async (...args: A) => {
        setState({ pending: true });
        try {
          const result = await action(client, ...args);
          for (const prefix of typeof invalidates === 'string'
            ? [invalidates]
            : (invalidates ?? []))
            store.invalidate(prefix);
          setState({ pending: false });
          return result;
        } catch (error) {
          setState({
            pending: false,
            error: error instanceof Error ? error : new Error(String(error)),
          });
          throw error;
        }
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [client, store],
    );
    return { run, ...state };
  }

  return {
    BetterFilesProvider,
    useClient,
    useQuery,
    useInvalidate,
    useRooms,
    useRoom,
    useRoomIndex,
    useFolder,
    useDocument,
    useMembers,
    useActivity,
    useCapabilities,
    useUpload,
    useAction,
    useLiveRoom,
    Can,
  };
}
