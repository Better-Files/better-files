import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import type { BetterFilesPlugin } from '@better-files/core';
import { viewerPlugin, type PageRenderer } from '@better-files/viewer/server';
import { ndaPlugin } from '@better-files/plugin-nda';
import { as, fixture, TENANT } from '../fixtures.js';

async function pdf(pages: number) {
  const document = await PDFDocument.create();
  for (let i = 1; i <= pages; i++)
    document.addPage([400, 600]).drawText(`Page ${i}`, { x: 50, y: 500, size: 32 });
  return new Uint8Array(await document.save());
}

async function setup(plugins: readonly BetterFilesPlugin[] = [viewerPlugin({ batch: 2 })]) {
  const f = await fixture({ plugins });
  const room = await f.room();
  const { document } = await f.upload('alice', {
    parentId: room.rootNodeId,
    filename: 'cim.pdf',
    content: await pdf(3),
    mimeType: 'application/pdf',
  });
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
  return { f, room, document };
}

const webp = (bytes: Uint8Array) =>
  new TextDecoder().decode(bytes.subarray(0, 4)) === 'RIFF' &&
  new TextDecoder().decode(bytes.subarray(8, 12)) === 'WEBP';

describe('secure viewer', () => {
  it('renders watermarked page images for view-only readers without exposing the file', async () => {
    const { f, room, document } = await setup();
    const api = f.dr.api as unknown as {
      viewer: {
        open(
          c: unknown,
          i: object,
        ): Promise<{
          supported: boolean;
          versionId: string;
          pages: { width: number; height: number }[];
          tickets: { page: number; url: string }[];
        }>;
        pages(c: unknown, i: object): Promise<{ tickets: { page: number; url: string }[] }>;
      };
    };
    const opened = await api.viewer.open(as('bob'), { tenantId: TENANT, nodeId: document.id });
    expect(opened).toMatchObject({ supported: true, pages: [{ width: 400, height: 600 }, {}, {}] });
    expect(opened.tickets.map((t) => t.page)).toEqual([1, 2]);

    const first = await f.download(opened.tickets[0]!.url);
    expect(first.response.headers.get('content-type')).toBe('image/webp');
    expect(webp(first.body)).toBe(true);
    // Bob may only view: the original stays out of reach.
    await expect(
      f.dr.api.documents.requestOriginal(as('bob'), { tenantId: TENANT, nodeId: document.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const more = await api.viewer.pages(as('bob'), {
      tenantId: TENANT,
      nodeId: document.id,
      versionId: opened.versionId,
      from: 3,
      to: 9,
    });
    expect(more.tickets.map((t) => t.page)).toEqual([3]);
    await expect(
      api.viewer.pages(as('bob'), {
        tenantId: TENANT,
        nodeId: document.id,
        versionId: opened.versionId,
        from: 4,
        to: 5,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    const activity = await f.dr.api.activity.list(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      nodeId: document.id,
    });
    expect(activity.some((r) => r.action === 'document.viewed' && r.actorId === 'bob')).toBe(true);
    await expect(
      api.viewer.open(as('dave'), { tenantId: TENANT, nodeId: document.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('stamps each page with who viewed it, and respects NDA gates', async () => {
    const stamps: string[] = [];
    const renderer: PageRenderer = {
      pages: async () => [{ number: 1, width: 10, height: 10 }],
      render: async ({ stamp }) => {
        stamps.push(stamp ?? '');
        return { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' };
      },
    };
    const { f, room, document } = await setup([ndaPlugin(), viewerPlugin({ renderer })]);
    const opened = await (
      f.dr.api as unknown as {
        viewer: { open(c: unknown, i: object): Promise<{ tickets: { url: string }[] }> };
      }
    ).viewer.open(as('alice'), { tenantId: TENANT, nodeId: document.id });
    await f.download(opened.tickets[0]!.url);
    expect(stamps[0]).toMatch(/^alice@acme\.test · \d{4}-\d{2}-\d{2} \d{2}:\d{2} · [0-9A-F]{8}$/);

    const nda = (
      f.dr.api as unknown as { nda: { publish(c: unknown, i: object): Promise<unknown> } }
    ).nda;
    await nda.publish(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      title: 'NDA',
      text: 'Keep it secret.',
    });
    await expect(
      (
        f.dr.api as unknown as { viewer: { open(c: unknown, i: object): Promise<unknown> } }
      ).viewer.open(as('bob'), { tenantId: TENANT, nodeId: document.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' }); // the pending NDA clamps VIEW away
  });
});
