import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { extractText } from 'unpdf';
import { libreOffice, processingPlugin, type Converter } from '@better-files/plugin-processing';
import { viewerPlugin } from '@better-files/viewer/server';
import { watermarkPlugin } from '@better-files/plugin-watermark';
import { as, fixture, TENANT } from '../fixtures.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Stands in for LibreOffice: "converts" a .docx by printing its text into a two-page PDF. */
function fakeWord(options: { failFirst?: boolean } = {}): Converter & { calls: number } {
  let calls = 0;
  return {
    id: 'fake-word',
    get calls() {
      return calls;
    },
    accepts: ({ filename }) => filename.endsWith('.docx'),
    async toPdf({ bytes }) {
      calls++;
      if (options.failFirst && calls === 1) throw new Error('converter crashed');
      const pdf = await PDFDocument.create();
      pdf
        .addPage([595, 842])
        .drawText(new TextDecoder().decode(bytes), { x: 50, y: 780, size: 14 });
      pdf.addPage([595, 842]).drawText('Page two', { x: 50, y: 780, size: 14 });
      return new Uint8Array(await pdf.save());
    },
  };
}

async function setup(converter: Converter) {
  const f = await fixture({
    plugins: [
      processingPlugin({ converters: [converter], mode: 'inline' }),
      viewerPlugin(),
      watermarkPlugin(),
    ],
  });
  const room = await f.room();
  const upload = (filename: string, content: Uint8Array, mimeType?: string) =>
    f.upload('alice', {
      parentId: room.rootNodeId,
      filename,
      content,
      ...(mimeType ? { mimeType } : {}),
    });
  return { f, room, upload };
}

describe('processing plugin', () => {
  it('converts Office files to PDF so they can be viewed and watermarked, with thumbnails', async () => {
    const converter = fakeWord();
    const { f, room, upload } = await setup(converter);
    const { document } = await upload(
      'minutes.docx',
      new TextEncoder().encode('Board minutes, 12 March'),
      DOCX,
    );
    expect(converter.calls).toBe(1);
    expect(
      await f.dr.api.processing.status(as('alice'), { tenantId: TENANT, nodeId: document.id }),
    ).toMatchObject({
      status: 'done',
      pdf: true,
      thumbnail: true,
    });

    const thumbs = await f.dr.api.processing.thumbnails(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      nodeIds: [document.id],
    });
    expect(thumbs[document.id]).toMatchObject({
      url: expect.stringMatching(/^data:image\/webp;base64,/),
      width: 320,
    });

    // The viewer shows the converted pages.
    const opened = await f.dr.api.viewer.open(as('alice'), {
      tenantId: TENANT,
      nodeId: document.id,
    });
    expect(opened).toMatchObject({ supported: true, pages: [{ width: 595, height: 842 }, {}] });
    const page = await f.download(opened.tickets[0]!.url);
    expect(page.response.headers.get('content-type')).toBe('image/webp');

    // A watermarked download of a Word file is a stamped PDF.
    const ticket = await f.dr.api.documents.requestDownload(as('alice'), {
      tenantId: TENANT,
      nodeId: document.id,
    });
    const stamped = await f.download(ticket.url);
    expect(stamped.response.headers.get('content-disposition')).toContain('minutes.pdf');
    const { text } = await extractText(new Uint8Array(stamped.body), { mergePages: true });
    expect(text).toContain('Board minutes, 12 March');
    expect(text).toContain('alice@acme.test');
  });

  it('thumbnails PDFs and images, skips what it cannot handle, and keeps thumbnails private', async () => {
    const { f, room, upload } = await setup(fakeWord());
    const pdf = await PDFDocument.create();
    pdf.addPage([300, 400]).drawText('Deck', { x: 20, y: 350, size: 20 });
    const { document: deck } = await upload(
      'deck.pdf',
      new Uint8Array(await pdf.save()),
      'application/pdf',
    );
    const { document: blob } = await upload('data.bin', f.bytes(100), 'application/octet-stream');
    const status = (nodeId: string) =>
      f.dr.api.processing.status(as('alice'), { tenantId: TENANT, nodeId });
    expect(await status(deck.id)).toMatchObject({ status: 'done', pdf: false, thumbnail: true });
    expect(await status(blob.id)).toMatchObject({ status: 'skipped', thumbnail: false });

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
    await f.dr.api.permissions.setEntries(as('alice'), {
      tenantId: TENANT,
      nodeId: deck.id,
      entries: [{ subject: { type: 'group', id: team.id }, preset: 'hidden' }],
    });
    expect(
      await f.dr.api.processing.thumbnails(as('bob'), {
        tenantId: TENANT,
        roomId: room.id,
        nodeIds: [deck.id],
      }),
    ).toEqual({});
  });

  it('records failures and reprocesses on request', async () => {
    const converter = fakeWord({ failFirst: true });
    const { f, upload } = await setup(converter);
    const { document } = await upload('draft.docx', new TextEncoder().encode('Draft'), DOCX);
    expect(
      await f.dr.api.processing.status(as('alice'), { tenantId: TENANT, nodeId: document.id }),
    ).toMatchObject({
      status: 'failed',
      error: 'converter crashed',
    });
    expect(
      await f.dr.api.processing.reprocess(as('alice'), { tenantId: TENANT, nodeId: document.id }),
    ).toMatchObject({
      status: 'done',
      pdf: true,
    });
  });

  it('LibreOffice takes Office and OpenDocument formats', () => {
    const converter = libreOffice();
    expect(
      ['a.docx', 'b.XLSX', 'c.pptx', 'd.odt', 'e.rtf'].every((filename) =>
        converter.accepts({ filename }),
      ),
    ).toBe(true);
    expect(converter.accepts({ filename: 'f.pdf' })).toBe(false);
  });
});
