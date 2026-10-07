import {
  computed,
  defineComponent,
  inject,
  onScopeDispose,
  provide,
  shallowRef,
  toValue,
  watch,
  type App,
  type ComputedRef,
  type InjectionKey,
  type MaybeRefOrGetter,
  type PropType,
  type Ref,
} from 'vue';
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
  data: ComputedRef<T | undefined>;
  error: ComputedRef<Error | undefined>;
  loading: ComputedRef<boolean>;
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
 * Typed Vue bindings for one Better Files server type. Arguments accept refs and getters, so queries follow route
 * params:
 *
 * ```ts
 * export const rooms = createBetterFilesVue<typeof dr>();
 * app.use(rooms.plugin, { client: createBetterFilesClient<typeof dr>({ tenantId }) });
 * // in setup()
 * const index = rooms.useRoomIndex(() => route.params.roomId as string);
 * ```
 */
export function createBetterFilesVue<T extends { api: object }>() {
  type Client = BetterFilesClient<T>;
  interface Value {
    client: Client;
    cache: QueryCache;
  }
  const key: InjectionKey<Value> = Symbol('better-iam:better-files');

  /** `app.use(rooms.plugin, { client })`. */
  const plugin = {
    install(app: App, options: { client: Client }) {
      app.provide(key, { client: options.client, cache: new QueryCache() });
    },
  };

  /** Provides a client to a subtree from a component's setup, instead of the app plugin. */
  function provideBetterFiles(client: Client) {
    provide(key, { client, cache: new QueryCache() });
  }

  function useValue(): Value {
    const value = inject(key, null);
    if (!value)
      throw new Error('Install the Better Files plugin: app.use(rooms.plugin, { client })');
    return value;
  }

  const useClient = (): Client => useValue().client;

  function useInvalidate() {
    const { cache } = useValue();
    return (prefix?: string) => cache.invalidate(prefix);
  }

  /** Any read, cached under a (reactive) key; a `null` key skips fetching. */
  function useQuery<O>(
    source: MaybeRefOrGetter<string | null>,
    fetcher: (client: Client) => Promise<O>,
  ): QueryState<O> {
    const { client, cache } = useValue();
    const version = shallowRef(cache.snapshot());
    onScopeDispose(cache.subscribe(() => (version.value = cache.snapshot())));
    const current = computed(() => toValue(source));
    const entry = computed(() => {
      void version.value;
      return current.value ? cache.get(current.value) : undefined;
    });
    // Loads on mount, when the key changes, and again after an invalidation drops the entry.
    watch(
      [current, () => entry.value === undefined],
      ([name]) => {
        if (name) void cache.load(name, () => fetcher(client));
      },
      { immediate: true },
    );
    return {
      data: computed(() => entry.value?.data as O | undefined),
      error: computed(() => entry.value?.error),
      loading: computed(
        () => current.value !== null && (entry.value === undefined || entry.value.loading),
      ),
      refresh: async () => {
        if (current.value) await cache.load(current.value, () => fetcher(client), true);
      },
    };
  }

  function useStandard<G extends string, M extends string>(
    make: () => QueryDefinition<G, M> | null,
  ) {
    const definition = computed(make);
    return useQuery(
      () => definition.value?.key ?? null,
      (client) => runQuery(client, definition.value!) as Promise<OperationResult<T, G, M>>,
    );
  }

  type Id = MaybeRefOrGetter<string | null | undefined>;
  const id = (value: Id) => toValue(value) ?? null;

  const useRooms = (
    input: MaybeRefOrGetter<{ status?: 'draft' | 'live' | 'closed' | 'archived' }> = {},
  ) => useStandard(() => standardQueries.rooms(toValue(input)));
  const useRoom = (roomId: Id) =>
    useStandard(() => (id(roomId) ? standardQueries.room(id(roomId)!) : null));
  const useRoomIndex = (roomId: Id) =>
    useStandard(() => (id(roomId) ? standardQueries.roomIndex(id(roomId)!) : null));
  const useFolder = (nodeId: Id) =>
    useStandard(() => (id(nodeId) ? standardQueries.folder(id(nodeId)!) : null));
  const useDocument = (nodeId: Id) =>
    useStandard(() => (id(nodeId) ? standardQueries.document(id(nodeId)!) : null));
  const useMembers = (roomId: Id) =>
    useStandard(() => (id(roomId) ? standardQueries.members(id(roomId)!) : null));
  const useActivity = (roomId: Id, options: { limit?: number } = {}) =>
    useStandard(() => (id(roomId) ? standardQueries.activity(id(roomId)!, options) : null));

  /** Capabilities for many nodes of a room in one call; `can(nodeId, 'DOWNLOAD_ORIGINAL')`. */
  function useCapabilities(roomId: Id, nodeIds: MaybeRefOrGetter<readonly string[]>) {
    const definition = computed(() => {
      const room = id(roomId);
      const nodes = toValue(nodeIds);
      return room && nodes.length ? standardQueries.capabilities(room, nodes) : null;
    });
    const state = useQuery(
      () => definition.value?.key ?? null,
      (client) => runQuery(client, definition.value!) as Promise<Record<string, string[]>>,
    );
    const can = (nodeId: string, capability: string) =>
      state.data.value?.[nodeId]?.includes(capability) ?? false;
    return { ...state, can };
  }

  /** Renders the default slot only when the caller holds a capability; `#fallback` otherwise. Advisory. */
  const Can = defineComponent({
    name: 'BetterFilesCan',
    props: {
      roomId: { type: String, required: true },
      nodeId: { type: String, required: true },
      capability: { type: String as PropType<string>, required: true },
    },
    setup(props, { slots }) {
      const capabilities = useCapabilities(
        () => props.roomId,
        () => [props.nodeId],
      );
      return () => {
        if (capabilities.loading.value) return null;
        return capabilities.can(props.nodeId, props.capability)
          ? slots.default?.()
          : slots.fallback?.();
      };
    },
  });

  /** Uploads with per-file progress; the destination folder's queries refresh when each finishes. */
  function useUpload() {
    const { client, cache } = useValue();
    const items: Ref<UploadItem[]> = shallowRef([]);
    const update = (itemId: string, patch: Partial<UploadItem>) =>
      (items.value = items.value.map((item) =>
        item.id === itemId ? { ...item, ...patch } : item,
      ));
    async function upload(input: UploadInput) {
      const itemId = Math.random().toString(36).slice(2);
      const filename =
        input.filename ??
        (typeof File !== 'undefined' && input.file instanceof File ? input.file.name : 'file');
      const total = input.file instanceof Uint8Array ? input.file.byteLength : input.file.size;
      items.value = [
        ...items.value,
        { id: itemId, filename, progress: { loaded: 0, total, ratio: 0 }, status: 'uploading' },
      ];
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
    }
    const clear = () => (items.value = items.value.filter((item) => item.status === 'uploading'));
    return { upload, items, clear };
  }

  /** Keeps a room's views live from its activity stream; the ref holds the latest entry. */
  function useLiveRoom(roomId: Id, onActivity?: (activity: RoomActivity) => void) {
    const { client, cache } = useValue();
    const last = shallowRef<RoomActivity | undefined>();
    let subscription: { close(): void } | undefined;
    watch(
      () => id(roomId),
      (room) => {
        subscription?.close();
        subscription = room
          ? client.subscribe(room, {
              onActivity(activity) {
                for (const prefix of liveInvalidations(room, activity)) cache.invalidate(prefix);
                last.value = activity;
                onActivity?.(activity);
              },
            })
          : undefined;
      },
      { immediate: true },
    );
    onScopeDispose(() => subscription?.close());
    return last;
  }

  /** Wraps a write and invalidates cache prefixes after it succeeds. */
  function useAction<A extends unknown[], O>(
    action: (client: Client, ...args: A) => Promise<O>,
    invalidates?: string | string[],
  ) {
    const { client, cache } = useValue();
    const pending = shallowRef(false);
    const error = shallowRef<Error | undefined>();
    async function run(...args: A) {
      pending.value = true;
      error.value = undefined;
      try {
        const result = await action(client, ...args);
        for (const prefix of typeof invalidates === 'string' ? [invalidates] : (invalidates ?? []))
          cache.invalidate(prefix);
        return result;
      } catch (caught) {
        error.value = caught instanceof Error ? caught : new Error(String(caught));
        throw caught;
      } finally {
        pending.value = false;
      }
    }
    return { run, pending, error };
  }

  return {
    plugin,
    provideBetterFiles,
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
