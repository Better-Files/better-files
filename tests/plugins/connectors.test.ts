import { describe, expect, it } from 'vitest';
import {
  box,
  connectorsPlugin,
  dropbox,
  googleDrive,
  microsoftGraph,
  type Connector,
  type RemoteItem,
} from '@better-files/plugin-connectors';
import { as, fixture, TENANT } from '../fixtures.js';

/** An in-memory drive: folder id -> children, file id -> content. */
function fakeDrive() {
  const tree: Record<string, RemoteItem[]> = {
    root: [
      { id: 'f-legal', name: 'Legal', kind: 'folder' },
      { id: 'd-readme', name: 'Read me.txt', kind: 'file', revision: 'r1' },
    ],
    'f-legal': [
      { id: 'd-spa', name: 'SPA/v3.txt', kind: 'file', revision: 'r1' },
      { id: 'f-empty', name: 'Board', kind: 'folder' },
    ],
    'f-empty': [],
  };
  const content: Record<string, string> = {
    'd-readme': 'hello',
    'd-spa': 'share purchase agreement',
  };
  const connector: Connector = {
    id: 'fake',
    label: 'Fake Drive',
    list: async ({ folderId, token }) => {
      if (token !== 'drive-token') throw new Error('bad token');
      return tree[folderId ?? 'root'] ?? [];
    },
    download: async ({ item }) => ({
      bytes: new TextEncoder().encode(content[item.id]!),
      filename: item.name,
    }),
  };
  return { tree, content, connector };
}

async function waitDone(f: Awaited<ReturnType<typeof fixture>>, who: string, importId: string) {
  const api = f.dr.api as unknown as {
    connectors: { status(c: unknown, i: object): Promise<{ status: string }> };
  };
  for (let i = 0; i < 200; i++) {
    const status = await api.connectors.status(as(who), { tenantId: TENANT, importId });
    if (status.status !== 'running')
      return status as {
        status: string;
        imported: number;
        updated: number;
        skipped: number;
        failed: number;
        errors: unknown[];
      };
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Import did not finish');
}

describe('connectors plugin', () => {
  it('imports folders and files, then re-imports only what changed', async () => {
    const drive = fakeDrive();
    const f = await fixture({
      plugins: [
        connectorsPlugin({
          connectors: [drive.connector],
          token: async ({ principalId }) => (principalId === 'alice' ? 'drive-token' : undefined),
        }),
      ],
    });
    const room = await f.room();
    const browsed = await f.dr.api.connectors.browse(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      connector: 'fake',
    });
    expect(browsed.map((item) => item.name)).toEqual(['Legal', 'Read me.txt']);

    const started = await f.dr.api.connectors.import(as('alice'), {
      tenantId: TENANT,
      connector: 'fake',
      destinationId: room.rootNodeId,
      items: browsed,
    });
    expect(await waitDone(f, 'alice', started.importId)).toMatchObject({
      status: 'done',
      imported: 2,
      failed: 0,
    });
    const index = await f.dr.api.rooms.index(as('alice'), { tenantId: TENANT, roomId: room.id });
    // Slashes in remote names are replaced; items keep the drive's order.
    expect(index.map((n) => `${n.index} ${n.name}`)).toEqual([
      '1 Legal',
      '1.1 SPA_v3.txt',
      '1.2 Board',
      '2 Read me.txt',
    ]);

    // Change one remote file and import again: one new version, one skipped.
    drive.tree['f-legal']![0]!.revision = 'r2';
    drive.content['d-spa'] = 'share purchase agreement, signed';
    const again = await f.dr.api.connectors.import(as('alice'), {
      tenantId: TENANT,
      connector: 'fake',
      destinationId: room.rootNodeId,
      items: browsed,
    });
    expect(await waitDone(f, 'alice', again.importId)).toMatchObject({
      imported: 0,
      updated: 1,
      skipped: 1,
    });
    const spa = (
      await f.dr.api.rooms.index(as('alice'), { tenantId: TENANT, roomId: room.id })
    ).find((n) => n.name === 'SPA_v3.txt')!;
    expect(
      await f.dr.api.versions.list(as('alice'), { tenantId: TENANT, nodeId: spa.id }),
    ).toHaveLength(2);

    const activity = await f.dr.api.activity.list(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
    });
    expect(activity.filter((r) => r.action === 'connector.imported')).toHaveLength(2);
  });

  it('needs a connected account and upload access', async () => {
    const drive = fakeDrive();
    const f = await fixture({
      plugins: [
        connectorsPlugin({
          connectors: [drive.connector],
          token: async ({ principalId }) => (principalId === 'bob' ? 'drive-token' : undefined),
        }),
      ],
    });
    const room = await f.room();
    await expect(
      f.dr.api.connectors.browse(as('alice'), {
        tenantId: TENANT,
        roomId: room.id,
        connector: 'fake',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Connect Fake Drive first' });
    await expect(
      f.dr.api.connectors.browse(as('alice'), {
        tenantId: TENANT,
        roomId: room.id,
        connector: 'nope',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    const team = await f.dr.api.groups.create(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      name: 'Buyers',
      preset: 'view',
    });
    await f.dr.api.members.invite(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      email: 'bob@acme.test',
      groupIds: [team.id],
    });
    await expect(
      f.dr.api.connectors.import(as('bob'), {
        tenantId: TENANT,
        connector: 'fake',
        destinationId: room.rootNodeId,
        items: [{ id: 'd-readme', name: 'Read me.txt', kind: 'file' }],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('connector providers', () => {
  const recorder = (responses: ((url: string, init?: RequestInit) => Response)[]) => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, ...(init ? { init } : {}) });
      return responses.shift()!(url, init);
    }) as typeof globalThis.fetch;
    return { calls, fetch };
  };
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

  it('Google Drive pages through folders and exports native documents', async () => {
    const { calls, fetch } = recorder([
      () =>
        json({
          nextPageToken: 'p2',
          files: [
            {
              id: 'a',
              name: 'Plan',
              mimeType: 'application/vnd.google-apps.document',
              modifiedTime: '2026-01-01T00:00:00Z',
            },
          ],
        }),
      () =>
        json({ files: [{ id: 'b', name: 'Q3', mimeType: 'application/vnd.google-apps.folder' }] }),
      () => new Response('%PDF-1.7'),
    ]);
    const drive = googleDrive();
    const items = await drive.list({ token: 't', fetch });
    expect(items).toEqual([
      expect.objectContaining({ id: 'a', kind: 'file', revision: '2026-01-01T00:00:00Z' }),
      expect.objectContaining({ id: 'b', kind: 'folder' }),
    ]);
    expect(new URL(calls[0]!.url).searchParams.get('q')).toBe(
      "'root' in parents and trashed = false",
    );
    expect(new URL(calls[1]!.url).searchParams.get('pageToken')).toBe('p2');
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe('Bearer t');
    const file = await drive.download({ token: 't', fetch, item: items[0]!, maxBytes: 1000 });
    expect(file).toMatchObject({ filename: 'Plan.pdf', mimeType: 'application/pdf' });
    expect(calls[2]!.url).toContain('/files/a/export?mimeType=application%2Fpdf');
  });

  it('Dropbox continues cursors and escapes the API argument header', async () => {
    const { calls, fetch } = recorder([
      () =>
        json({
          entries: [{ '.tag': 'folder', id: 'id:1', name: 'Deals' }],
          cursor: 'c1',
          has_more: true,
        }),
      () =>
        json({
          entries: [
            { '.tag': 'file', id: 'id:2', name: 'Café.pdf', size: 3, content_hash: 'h' },
            { '.tag': 'deleted', id: 'x', name: 'gone' },
          ],
          cursor: 'c2',
          has_more: false,
        }),
      () => new Response('abc'),
    ]);
    const connector = dropbox();
    const items = await connector.list({ token: 't', fetch });
    expect(items.map((i) => [i.id, i.kind, i.revision])).toEqual([
      ['id:1', 'folder', undefined],
      ['id:2', 'file', 'h'],
    ]);
    expect(JSON.parse(String(calls[1]!.init!.body))).toEqual({ cursor: 'c1' });
    await connector.download({
      token: 't',
      fetch,
      item: { id: 'id:é', name: 'x', kind: 'file' },
      maxBytes: 10,
    });
    expect((calls[2]!.init!.headers as Record<string, string>)['dropbox-api-arg']).toBe(
      '{"path":"id:\\u00e9"}',
    );
  });

  it('Microsoft Graph follows next links; Box pages by offset; oversized files are refused', async () => {
    const graph = recorder([
      () =>
        json({
          value: [{ id: '1', name: 'A', folder: {} }],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next',
        }),
      () =>
        json({
          value: [{ id: '2', name: 'b.docx', file: { mimeType: 'application/msword' }, cTag: 'c' }],
        }),
    ]);
    const items = await microsoftGraph({ driveId: 'D1' }).list({
      token: 't',
      fetch: graph.fetch,
      folderId: 'F',
    });
    expect(items.map((i) => i.kind)).toEqual(['folder', 'file']);
    expect(graph.calls[0]!.url).toContain('/drives/D1/items/F/children');
    expect(graph.calls[1]!.url).toBe('https://graph.microsoft.com/v1.0/next');

    const boxed = recorder([
      () => json({ total_count: 2, entries: [{ id: '1', type: 'file', name: 'a', sha1: 's' }] }),
      () => json({ total_count: 2, entries: [{ id: '2', type: 'web_link', name: 'link' }] }),
      () => new Response('x'.repeat(50)),
    ]);
    const connector = box();
    expect((await connector.list({ token: 't', fetch: boxed.fetch })).map((i) => i.id)).toEqual([
      '1',
    ]);
    expect(boxed.calls[1]!.url).toContain('offset=1');
    await expect(
      connector.download({
        token: 't',
        fetch: boxed.fetch,
        item: { id: '1', name: 'a', kind: 'file' },
        maxBytes: 10,
      }),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });

    const refused = recorder([() => new Response('nope', { status: 401 })]);
    await expect(googleDrive().list({ token: 't', fetch: refused.fetch })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});
