// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { createApp, defineComponent, h, nextTick } from 'vue';
import { createBetterFilesClient } from '@better-files/client';
import { createBetterFilesVue } from '@better-files/vue';
import { createBetterFilesSvelte, type QueryState } from '@better-files/svelte';
import { betterFilesHandle, betterFilesHandlers } from '@better-files/svelte/kit';
import { as, fixture, TENANT } from '../fixtures.js';

async function waitFor(check: () => boolean, timeout = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await nextTick();
  }
}

async function setup() {
  const f = await fixture();
  const room = await f.room();
  await f.upload('alice', {
    parentId: room.rootNodeId,
    filename: 'first.pdf',
    content: f.bytes(10),
  });
  type Server = typeof f.dr;
  const client = (who: string) =>
    createBetterFilesClient<Server>({
      baseURL: 'http://app.test',
      tenantId: TENANT,
      headers: () => ({ authorization: `Bearer ${who}` }),
      fetch: (input, init) => f.dr.handler(new Request(input, init)),
    });
  return { f, room, client };
}

describe('Vue bindings', () => {
  it('loads the index, gates on capabilities and refreshes after uploads', async () => {
    const { f, room, client } = await setup();
    const rooms = createBetterFilesVue<typeof f.dr>();
    let upload: ReturnType<typeof rooms.useUpload>['upload'] | undefined;

    const Index = defineComponent({
      setup() {
        const index = rooms.useRoomIndex(() => room.id);
        const uploader = rooms.useUpload();
        upload = uploader.upload;
        return () =>
          index.loading.value && !index.data.value
            ? h('p', 'loading')
            : h(
                'ul',
                (index.data.value ?? []).map((node) =>
                  h('li', { key: node.id }, [
                    `${node.index} ${node.name}`,
                    h(
                      rooms.Can,
                      { roomId: room.id, nodeId: node.id, capability: 'DOWNLOAD_ORIGINAL' },
                      { default: () => h('b', ' download'), fallback: () => h('em', ' view only') },
                    ),
                  ]),
                ),
              );
      },
    });

    const container = document.createElement('div');
    const app = createApp(Index);
    app.use(rooms.plugin, { client: client('alice') });
    app.mount(container);
    await waitFor(() => container.textContent === '1 first.pdf download');

    await upload!({
      parentId: room.rootNodeId,
      file: new Blob([f.bytes(20)]),
      filename: 'second.pdf',
    });
    await waitFor(() => container.textContent?.includes('2 second.pdf') ?? false);
    app.unmount();

    // Outsiders get the server's refusal as an error state.
    let error: string | undefined;
    const Outsider = defineComponent({
      setup() {
        const index = rooms.useRoomIndex(room.id);
        return () => {
          error = index.error.value?.message;
          return h('p', error ?? '');
        };
      },
    });
    const other = createApp(Outsider);
    other.use(rooms.plugin, { client: client('dave') });
    other.mount(document.createElement('div'));
    await waitFor(() => error !== undefined);
    other.unmount();
  });
});

describe('Svelte stores', () => {
  it('share one cache, refresh after writes and follow the store contract', async () => {
    const { f, room, client } = await setup();
    const rooms = createBetterFilesSvelte<typeof f.dr>(client('alice'));
    const seen: QueryState<unknown[]>[] = [];
    const index = rooms.roomIndex(room.id);
    const stop = index.subscribe((value) => seen.push(value as QueryState<unknown[]>));
    expect(seen[0]).toMatchObject({ loading: true, data: undefined });
    await waitFor(() => seen.at(-1)?.data?.length === 1);

    let caps: { can(nodeId: string, capability: string): boolean; loading: boolean } | undefined;
    const stopCaps = rooms
      .capabilities(room.id, [room.rootNodeId])
      .subscribe((value) => (caps = value));
    await waitFor(() => caps?.loading === false);
    expect(caps!.can(room.rootNodeId, 'MANAGE')).toBe(true);

    const uploads: { status: string }[][] = [];
    const stopUploads = rooms.uploads.subscribe((items) => uploads.push(items));
    await rooms.uploads.upload({
      parentId: room.rootNodeId,
      file: f.bytes(5),
      filename: 'second.pdf',
    });
    expect(uploads.at(-1)).toEqual([
      expect.objectContaining({ status: 'done', filename: 'second.pdf' }),
    ]);
    await waitFor(() => seen.at(-1)?.data?.length === 2);

    const rename = rooms.action(
      (c, name: string) => c.folders.create({ parentId: room.rootNodeId, name }),
      'index:',
    );
    const statuses: { pending: boolean }[] = [];
    const stopRename = rename.subscribe((value) => statuses.push(value));
    await rename.run('Legal');
    expect(statuses.map((s) => s.pending)).toEqual([false, true, false]);
    await waitFor(() => seen.at(-1)?.data?.length === 3);

    stop();
    stopCaps();
    stopUploads();
    stopRename();
    // After the last subscriber leaves, the store stops listening.
    const before = seen.length;
    rooms.invalidate();
    expect(seen.length).toBe(before);
    expect(
      (await f.dr.api.rooms.index(as('alice'), { tenantId: TENANT, roomId: room.id })).length,
    ).toBe(3);
  });

  it('mounts the protocol in SvelteKit through a handle hook or route handlers', async () => {
    const { f, room } = await setup();
    const event = (path: string, init?: RequestInit) => ({
      request: new Request(`http://app.test${path}`, init),
      url: new URL(`http://app.test${path}`),
      getClientAddress: () => '203.0.113.9',
    });
    const post = {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'x-better-files': '1',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ tenantId: TENANT, roomId: room.id }),
    };
    const handle = betterFilesHandle(f.dr);
    const response = await handle({
      event: event('/api/better-files/rooms/get', post),
      resolve: () => new Response('app'),
    });
    expect(response.status).toBe(200);
    const passed = await handle({ event: event('/dashboard'), resolve: () => new Response('app') });
    expect(await passed.text()).toBe('app');
    const { POST } = betterFilesHandlers(f.dr);
    expect((await POST(event('/api/better-files/rooms/get', post))).status).toBe(200);
  });
});
