import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { ndaPlugin } from '@better-files/plugin-nda';
import { watermarkPlugin } from '@better-files/plugin-watermark';
import { as, fixture, TENANT } from '../fixtures.js';

describe('NDA plugin', () => {
  it('withholds content until the current NDA is accepted, and asks again for new versions', async () => {
    const f = await fixture({ plugins: [ndaPlugin()] });
    const room = await f.room();
    const { document } = await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'terms.pdf',
      content: f.bytes(50),
    });
    const buyers = await f.dr.api.groups.create(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      name: 'Buyers',
      preset: 'download',
    });
    await f.dr.api.members.invite(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      email: 'bob@acme.test',
      groupIds: [buyers.id],
    });
    const caps = () =>
      f.dr.capabilitiesFor(as('bob'), {
        tenantId: TENANT,
        roomId: room.id,
        nodeIds: [document.id],
      });
    expect((await caps())[document.id]).toContain('DOWNLOAD_WATERMARKED');

    await expect(
      f.dr.api.nda.publish(as('bob'), {
        tenantId: TENANT,
        roomId: room.id,
        text: 'Keep it secret.',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const nda = await f.dr.api.nda.publish(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      title: 'Project NDA',
      text: 'Keep it secret.',
    });
    expect(nda).toMatchObject({ version: 1, active: true, appliesTo: 'everyone' });

    // Bob sees names only; the room owner is exempt.
    expect((await caps())[document.id]).toEqual(['LIST']);
    await expect(
      f.dr.api.documents.requestDownload(as('bob'), { tenantId: TENANT, nodeId: document.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(
      (
        await f.dr.capabilitiesFor(as('alice'), {
          tenantId: TENANT,
          roomId: room.id,
          nodeIds: [document.id],
        })
      )[document.id],
    ).toContain('MANAGE');

    expect(await f.dr.api.nda.get(as('bob'), { tenantId: TENANT, roomId: room.id })).toMatchObject({
      required: true,
      nda: { version: 1 },
    });
    const accepted = await f.dr.api.nda.accept(as('bob'), {
      tenantId: TENANT,
      roomId: room.id,
      version: 1,
    });
    expect(accepted).toMatchObject({ identityId: 'bob', version: 1, email: 'bob@acme.test' });
    expect(accepted.textSha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await caps())[document.id]).toContain('DOWNLOAD_WATERMARKED');

    await f.dr.api.nda.publish(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      text: 'Keep it very secret.',
    });
    expect((await caps())[document.id]).toEqual(['LIST']);
    await expect(
      f.dr.api.nda.accept(as('bob'), { tenantId: TENANT, roomId: room.id, version: 1 }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await f.dr.api.nda.accept(as('bob'), { tenantId: TENANT, roomId: room.id, version: 2 });
    expect((await caps())[document.id]).toContain('DOWNLOAD_WATERMARKED');

    const acceptances = await f.dr.api.nda.acceptances(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
    });
    expect(acceptances.map((a) => a.version)).toEqual([1, 2]);
    await f.dr.api.nda.publish(as('alice'), { tenantId: TENANT, roomId: room.id, active: false });
    expect(await f.dr.api.nda.get(as('bob'), { tenantId: TENANT, roomId: room.id })).toEqual({
      nda: null,
      required: false,
    });
  });

  it('can apply to guests only', async () => {
    const f = await fixture({ plugins: [ndaPlugin()] });
    const room = await f.room();
    const buyers = await f.dr.api.groups.create(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      name: 'Buyers',
      preset: 'view',
    });
    await f.dr.api.members.invite(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      email: 'bob@acme.test',
      groupIds: [buyers.id],
    });
    await f.dr.api.nda.publish(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      text: 'Guests sign this.',
      appliesTo: 'external',
    });
    expect(await f.dr.api.nda.get(as('bob'), { tenantId: TENANT, roomId: room.id })).toMatchObject({
      required: false,
    });
    f.principals.bob = { ...f.principals.bob!, guest: true };
    expect(await f.dr.api.nda.get(as('bob'), { tenantId: TENANT, roomId: room.id })).toMatchObject({
      required: true,
    });
  });
});

describe('watermark plugin', () => {
  async function samplePdf(pages = 2) {
    const pdf = await PDFDocument.create();
    for (let i = 0; i < pages; i++)
      pdf.addPage([595, 842]).drawText(`Page ${i + 1}`, { x: 50, y: 700, size: 24 });
    return new Uint8Array(await pdf.save());
  }
  const hex = (text: string) => Buffer.from(text, 'latin1').toString('hex').toUpperCase();

  it('stamps PDFs with the downloader and a forensic code', async () => {
    const f = await fixture({ plugins: [watermarkPlugin()] });
    const seen: { code?: unknown }[] = [];
    f.dr.events.subscribe('document.watermarked', (event) => void seen.push(event.data));
    const room = await f.room();
    const original = await samplePdf();
    const { document } = await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'cim.pdf',
      content: original,
      mimeType: 'application/pdf',
    });
    const ticket = await f.dr.api.documents.requestDownload(as('alice'), {
      tenantId: TENANT,
      nodeId: document.id,
    });
    const { response, body } = await f.download(ticket.url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('cim.pdf');
    const stamped = await PDFDocument.load(body);
    expect(stamped.getPageCount()).toBe(2);
    // Page content streams are compressed; inflate them to find the stamp.
    const raw = Buffer.from(body).toString('latin1');
    const content = [...raw.matchAll(/stream\r?\n([\s\S]*?)endstream/g)]
      .map((match) => {
        try {
          return inflateSync(Buffer.from(match[1]!, 'latin1')).toString('latin1');
        } catch {
          return match[1]!;
        }
      })
      .join('\n');
    const contains = (text: string) => content.includes(hex(text)) || content.includes(text);
    expect(contains('alice@acme.test')).toBe(true);
    expect(seen).toHaveLength(1);
    expect(String(seen[0]!.code)).toMatch(/^[0-9A-F]{10}$/);
    expect(contains(String(seen[0]!.code))).toBe(true);

    // The viewer variant is the same stamped PDF, inline.
    const view = await f.dr.api.documents.requestView(as('alice'), {
      tenantId: TENANT,
      nodeId: document.id,
    });
    const viewed = await f.download(view.url);
    expect(viewed.response.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(viewed.response.headers.get('content-type')).toBe('application/pdf');
  });

  it('stamps images and refuses types it cannot mark', async () => {
    const f = await fixture({ plugins: [watermarkPlugin({ opacity: 0.6 })] });
    const room = await f.room();
    const png = new Uint8Array(
      await sharp({
        create: { width: 400, height: 300, channels: 3, background: { r: 255, g: 255, b: 255 } },
      })
        .png()
        .toBuffer(),
    );
    const image = await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'site.png',
      content: png,
      mimeType: 'image/png',
    });
    const ticket = await f.dr.api.documents.requestDownload(as('alice'), {
      tenantId: TENANT,
      nodeId: image.document.id,
    });
    const { body } = await f.download(ticket.url);
    const stats = await sharp(Buffer.from(body)).stats();
    // A white image with a grey watermark is no longer pure white.
    expect(stats.channels[0]!.min).toBeLessThan(255);

    const csv = await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'data.csv',
      content: new TextEncoder().encode('a,b\n1,2\n'),
      mimeType: 'text/csv',
    });
    const refused = await f.dr.api.documents.requestDownload(as('alice'), {
      tenantId: TENANT,
      nodeId: csv.document.id,
    });
    await expect(f.download(refused.url)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });
});
