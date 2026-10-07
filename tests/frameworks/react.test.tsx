// @vitest-environment happy-dom
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { createBetterFilesClient } from '@better-files/client';
import { createBetterFilesReact } from '@better-files/react';
import { fixture, TENANT } from '../fixtures.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function waitFor(check: () => boolean, timeout = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for the UI');
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
  }
}

describe('React bindings', () => {
  it('loads the index, gates on capabilities and refreshes after uploads', async () => {
    const f = await fixture();
    const room = await f.room();
    await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'first.pdf',
      content: f.bytes(10),
    });
    type Server = typeof f.dr;
    const react = createBetterFilesReact<Server>();
    const client = (who: string) =>
      createBetterFilesClient<Server>({
        baseURL: 'http://app.test',
        tenantId: TENANT,
        headers: () => ({ authorization: `Bearer ${who}` }),
        fetch: (input, init) => f.dr.handler(new Request(input, init)),
      });

    let upload: ReturnType<typeof react.useUpload>['upload'] | undefined;
    function Index() {
      const index = react.useRoomIndex(room.id);
      const uploader = react.useUpload();
      useEffect(() => {
        upload = uploader.upload;
      });
      if (index.loading && !index.data) return <p>loading</p>;
      if (index.error) return <p>error: {index.error.message}</p>;
      return (
        <ul>
          {index.data?.map((node) => (
            <li key={node.id}>
              {node.index} {node.name}
              <react.Can
                roomId={room.id}
                nodeId={node.id}
                capability="DOWNLOAD_ORIGINAL"
                fallback={<em> view only</em>}
              >
                <b> download</b>
              </react.Can>
            </li>
          ))}
        </ul>
      );
    }

    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <react.BetterFilesProvider client={client('alice')}>
          <Index />
        </react.BetterFilesProvider>,
      );
    });
    await waitFor(() => container.textContent?.includes('first.pdf download') ?? false);
    expect(container.textContent).toBe('1 first.pdf download');

    await act(async () => {
      await upload!({
        parentId: room.rootNodeId,
        file: new Blob([f.bytes(20)]),
        filename: 'second.pdf',
      });
    });
    await waitFor(() => container.textContent?.includes('second.pdf') ?? false);
    expect(container.textContent).toContain('2 second.pdf');

    // Someone outside the room gets the server's refusal as an error state.
    const outsider = createRoot(document.createElement('div'));
    const other = document.createElement('div');
    const outsiderRoot = createRoot(other);
    await act(async () => {
      outsiderRoot.render(
        <react.BetterFilesProvider client={client('bob')}>
          <Index />
        </react.BetterFilesProvider>,
      );
    });
    await waitFor(() => other.textContent?.startsWith('error') ?? false);
    expect(other.textContent).toBe('error: Access denied');
    await act(async () => {
      root.unmount();
      outsider.unmount();
      outsiderRoot.unmount();
    });
  });
});
