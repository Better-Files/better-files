import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import {
  embedInPixels,
  extractForensicCode,
  extractFromPixels,
  watermarkPlugin,
  type WatermarkIssue,
} from '@better-files/plugin-watermark';
import { as, fixture, TENANT } from '../fixtures.js';

async function samplePdf(pages = 2) {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pages; i++)
    pdf.addPage([595, 842]).drawText(`Page ${i + 1}`, { x: 50, y: 700, size: 24 });
  return new Uint8Array(await pdf.save());
}

/** A photo-like image: smooth gradients plus noise, mid-tones and some near-white sky. */
async function samplePhoto(width = 480, height = 360) {
  const data = Buffer.alloc(width * height * 3);
  let seed = 7;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const noise = (seed % 21) - 10;
      const at = (y * width + x) * 3;
      const sky = y < height / 5;
      data[at] = Math.max(0, Math.min(255, (sky ? 245 : 60 + (x * 140) / width) + noise));
      data[at + 1] = Math.max(0, Math.min(255, (sky ? 248 : 90 + (y * 100) / height) + noise));
      data[at + 2] = Math.max(0, Math.min(255, (sky ? 252 : 120) + noise));
    }
  return new Uint8Array(
    await sharp(data, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer(),
  );
}

/** A room where bob, a buyer, may only download watermarked copies. */
async function buyerRoom(f: Awaited<ReturnType<typeof fixture>>) {
  const room = await f.room();
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
  return room;
}

describe('forensic watermarks', () => {
  it('hides the code in PDFs, records the copy, and traces a leak back to its recipient', async () => {
    const f = await fixture({ plugins: [watermarkPlugin()] });
    const seen: Record<string, unknown>[] = [];
    f.dr.events.subscribe('document.watermarked', (event) => void seen.push(event.data));
    const room = await buyerRoom(f);
    const { document } = await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'cim.pdf',
      content: await samplePdf(),
      mimeType: 'application/pdf',
    });

    const ticket = await f.dr.api.documents.requestDownload(as('bob'), {
      tenantId: TENANT,
      nodeId: document.id,
    });
    const leaked = (await f.download(ticket.url)).body;
    expect(seen).toHaveLength(1);
    const code = String(seen[0]!.code);
    expect(code).toMatch(/^[0-9A-F]{10}$/);
    expect(seen[0]!.hidden).toBe(true);

    expect(await extractForensicCode(leaked)).toEqual({ code, method: 'pdf-metadata' });
    // Stripping the metadata leaves the invisible text.
    const stripped = await PDFDocument.load(leaked);
    stripped.setKeywords([]);
    stripped.setProducer('Someone Else');
    expect(await extractForensicCode(new Uint8Array(await stripped.save()))).toEqual({
      code,
      method: 'pdf-text',
    });
    // An unmarked PDF yields nothing.
    expect(await extractForensicCode(await samplePdf())).toBeUndefined();

    const traced = await f.dr.api.watermark.trace(as('alice'), {
      tenantId: TENANT,
      code: code.toLowerCase(),
    });
    expect(traced).toMatchObject({
      roomId: room.id,
      nodeId: document.id,
      identityId: 'bob',
      email: 'bob@acme.test',
      variant: 'watermarked',
      hidden: true,
    });
    // Tenant-wide tracing is for tenant administrators; room members cannot look codes up.
    await expect(
      f.dr.api.watermark.trace(as('bob'), { tenantId: TENANT, code }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      f.dr.api.watermark.trace(as('alice'), { tenantId: TENANT, code: 'ABCDEF0123' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // The leaked copy turns up; an administrator uploads it to the room and identifies it.
    const evidence = await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'found-online.pdf',
      content: leaked,
      mimeType: 'application/pdf',
    });
    const identified = await f.dr.api.watermark.identify(as('alice'), {
      tenantId: TENANT,
      nodeId: evidence.document.id,
    });
    expect(identified).toMatchObject({
      code,
      method: 'pdf-metadata',
      otherRoom: false,
      issue: { identityId: 'bob', nodeId: document.id },
    });
    await expect(
      f.dr.api.watermark.identify(as('bob'), { tenantId: TENANT, nodeId: evidence.document.id }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/FORBIDDEN|NOT_FOUND/) });

    // An original carries no mark.
    const clean = await f.dr.api.watermark.identify(as('alice'), {
      tenantId: TENANT,
      nodeId: document.id,
    });
    expect(clean).toMatchObject({ code: null, issue: null, otherRoom: false });
  });

  it('lists the copies handed out in a room', async () => {
    const f = await fixture({ plugins: [watermarkPlugin()] });
    const room = await buyerRoom(f);
    const { document } = await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'model.pdf',
      content: await samplePdf(1),
      mimeType: 'application/pdf',
    });
    // Bob downloads twice; alice, who could have the original, opens the watermarked viewer copy.
    for (const who of ['bob', 'bob', 'alice']) {
      f.clock.current += 1000;
      const request =
        who === 'bob' ? f.dr.api.documents.requestDownload : f.dr.api.documents.requestView;
      const ticket = await request(as(who), { tenantId: TENANT, nodeId: document.id });
      await f.download(ticket.url);
    }
    const all = await f.dr.api.watermark.issues(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      nodeId: document.id,
    });
    expect(all.map((issue: WatermarkIssue) => [issue.identityId, issue.variant])).toEqual([
      ['alice', 'view'],
      ['bob', 'watermarked'],
      ['bob', 'watermarked'],
    ]);
    expect(new Set(all.map((issue: WatermarkIssue) => issue.code)).size).toBe(3);
    const bobs = await f.dr.api.watermark.issues(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      identityId: 'bob',
    });
    expect(bobs).toHaveLength(2);
    await expect(
      f.dr.api.watermark.issues(as('bob'), { tenantId: TENANT, roomId: room.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('hides the code in image pixels, surviving re-compression and resizing', async () => {
    const f = await fixture({ plugins: [watermarkPlugin()] });
    const seen: Record<string, unknown>[] = [];
    f.dr.events.subscribe('document.watermarked', (event) => void seen.push(event.data));
    const room = await buyerRoom(f);
    const image = await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'site.png',
      content: await samplePhoto(),
      mimeType: 'image/png',
    });
    const ticket = await f.dr.api.documents.requestDownload(as('bob'), {
      tenantId: TENANT,
      nodeId: image.document.id,
    });
    const { body } = await f.download(ticket.url);
    const code = String(seen[0]!.code);
    expect(await extractForensicCode(body)).toEqual({ code, method: 'image-pixels' });

    const jpeg = await sharp(Buffer.from(body)).jpeg({ quality: 75 }).toBuffer();
    expect((await extractForensicCode(new Uint8Array(jpeg)))?.code).toBe(code);
    const smaller = await sharp(Buffer.from(body)).resize(300).jpeg({ quality: 85 }).toBuffer();
    expect((await extractForensicCode(new Uint8Array(smaller)))?.code).toBe(code);
    const webp = await sharp(Buffer.from(body)).webp({ quality: 80 }).toBuffer();
    expect((await extractForensicCode(new Uint8Array(webp)))?.code).toBe(code);

    // The original photo has no mark.
    expect(await extractForensicCode(await samplePhoto())).toBeUndefined();
  });

  it('marks pixels within a few luma levels and leaves tiny images to the visible stamp', () => {
    const width = 256;
    const height = 224;
    const original = new Uint8Array(width * height * 3);
    for (let i = 0; i < original.length; i++) original[i] = 40 + ((i * 7919) % 170);
    const data = original.slice();
    expect(embedInPixels({ data, width, height, channels: 3 }, '0123456789')).toBe(true);
    let worst = 0;
    for (let i = 0; i < data.length; i++)
      worst = Math.max(worst, Math.abs(data[i]! - original[i]!));
    expect(worst).toBeLessThanOrEqual(6);
    expect(extractFromPixels({ data, width, height, channels: 3 })).toBe('0123456789');
    expect(extractFromPixels({ data: original, width, height, channels: 3 })).toBeUndefined();

    const tiny = new Uint8Array(40 * 40 * 3).fill(128);
    expect(embedInPixels({ data: tiny, width: 40, height: 40, channels: 3 }, '0123456789')).toBe(
      false,
    );
  });

  it('fits the whole stamp, identity first, on narrow pages', async () => {
    const f = await fixture({ plugins: [watermarkPlugin()] });
    const room = await buyerRoom(f);
    const pdf = await PDFDocument.create();
    pdf.addPage([400, 600]).drawText('Small page', { x: 40, y: 500, size: 18 });
    const { document } = await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'memo.pdf',
      content: new Uint8Array(await pdf.save()),
      mimeType: 'application/pdf',
    });
    const ticket = await f.dr.api.documents.requestDownload(as('bob'), {
      tenantId: TENANT,
      nodeId: document.id,
    });
    const { body } = await f.download(ticket.url);
    const { code } = (await extractForensicCode(body))!;
    const { extractText } = await import('unpdf');
    const { text } = await extractText(body, { mergePages: true });
    // At least one complete line: who, then the code at its end.
    expect(text).toMatch(new RegExp(`bob@acme\\.test.*${code}`));
  });

  it('lays tiles out so a full line fits and the middle copy is whole', async () => {
    const { tileStamp } = await import('@better-files/plugin-watermark');
    for (const [width, height] of [
      [400, 600],
      [595, 842],
      [1600, 300],
    ] as const) {
      const unit = 40; // a 40-em line
      const layout = tileStamp({ width, height, angle: 35, size: 28, widthAt: (s) => unit * s });
      const length = unit * layout.size;
      const rad = (35 * Math.PI) / 180;
      expect(length * Math.cos(rad)).toBeLessThanOrEqual(width * 0.9 + 1e-6);
      expect(length * Math.sin(rad)).toBeLessThanOrEqual(height * 0.9 + 1e-6);
      const whole = layout.positions.filter(
        ([x, y]) =>
          x >= 0 &&
          y >= 0 &&
          x + length * Math.cos(rad) <= width &&
          y + length * Math.sin(rad) <= height,
      );
      expect(whole.length).toBeGreaterThanOrEqual(1);
      expect(layout.positions.length).toBeGreaterThan(whole.length);
    }
  });

  it('can stamp visibly only, without records', async () => {
    const f = await fixture({ plugins: [watermarkPlugin({ forensic: false, record: false })] });
    const room = await buyerRoom(f);
    const { document } = await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'teaser.pdf',
      content: await samplePdf(1),
      mimeType: 'application/pdf',
    });
    const ticket = await f.dr.api.documents.requestDownload(as('bob'), {
      tenantId: TENANT,
      nodeId: document.id,
    });
    expect(await extractForensicCode((await f.download(ticket.url)).body)).toBeUndefined();
    expect(
      await f.dr.api.watermark.issues(as('alice'), { tenantId: TENANT, roomId: room.id }),
    ).toEqual([]);
    expect(() => watermarkPlugin({ forensic: { strength: 1 } })).toThrow(/strength/);
  });
});
