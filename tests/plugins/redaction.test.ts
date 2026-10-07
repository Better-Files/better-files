import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { extractText } from 'unpdf';
import { redactionPlugin } from '@better-files/plugin-redaction';
import { as, fixture, TENANT } from '../fixtures.js';

async function contract() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.setTitle('Employee census – Alice Example');
  const first = pdf.addPage([595, 842]);
  first.drawText('Employee census', { x: 50, y: 780, size: 20, font });
  first.drawText('Contact alice@example.com for questions.', { x: 50, y: 740, size: 12, font });
  first.drawText('SSN 123-45-6789 on file.', { x: 50, y: 720, size: 12, font });
  first.drawText('Codename FALCON is confidential.', { x: 50, y: 700, size: 12, font });
  pdf
    .addPage([595, 842])
    .drawText('Appendix: no personal data here.', { x: 50, y: 780, size: 12, font });
  return new Uint8Array(await pdf.save());
}

async function setup() {
  const f = await fixture({ plugins: [redactionPlugin()] });
  const room = await f.room();
  const { document } = await f.upload('alice', {
    parentId: room.rootNodeId,
    filename: 'census.pdf',
    content: await contract(),
    mimeType: 'application/pdf',
  });
  return { f, room, document };
}

const textOf = async (f: Awaited<ReturnType<typeof setup>>['f'], nodeId: string) => {
  const ticket = await f.dr.api.documents.requestOriginal(as('alice'), {
    tenantId: TENANT,
    nodeId,
  });
  const { body } = await f.download(ticket.url);
  const { text } = await extractText(new Uint8Array(body), { mergePages: false });
  return { body, pages: text };
};

describe('redaction plugin', () => {
  it('finds sensitive text and burns it out as a new version', async () => {
    const { f, room, document } = await setup();
    const found = await f.dr.api.redaction.find(as('alice'), {
      tenantId: TENANT,
      nodeId: document.id,
      patterns: ['email', 'ssn'],
      terms: ['falcon'],
    });
    expect(found.matches.map((m) => [m.rule, m.text, m.page])).toEqual([
      ['email', 'alice@example.com', 1],
      ['ssn', '123-45-6789', 1],
      ['term:falcon', 'FALCON', 1],
    ]);
    expect(found.matches[0]).toMatchObject({ x: expect.any(Number), width: expect.any(Number) });

    const applied = await f.dr.api.redaction.apply(as('alice'), {
      tenantId: TENANT,
      nodeId: document.id,
      patterns: ['email', 'ssn'],
      terms: ['falcon'],
    });
    expect(applied).toMatchObject({ nodeId: document.id, mode: 'version', areas: 3, pages: [1] });

    const { body, pages } = await textOf(f, document.id);
    const all = pages.join('\n');
    for (const secret of ['alice@example.com', '123-45-6789', 'FALCON'])
      expect(all).not.toContain(secret);
    // Untouched pages keep their text layer; metadata is dropped.
    expect(pages[1]).toContain('Appendix: no personal data here.');
    const result = await PDFDocument.load(body);
    expect(result.getPageCount()).toBe(2);
    expect(result.getTitle()).toBeUndefined();

    const versions = await f.dr.api.versions.list(as('alice'), {
      tenantId: TENANT,
      nodeId: document.id,
    });
    expect(versions).toHaveLength(2);
    const activity = await f.dr.api.activity.list(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      nodeId: document.id,
    });
    const record = activity.find((r) => r.action === 'document.redacted')!;
    expect(record.metadata).toMatchObject({
      mode: 'version',
      areas: 3,
      rules: ['email', 'ssn', 'term'],
    });
    expect(JSON.stringify(record.metadata)).not.toContain('123-45-6789');
  });

  it('makes redacted copies from marked areas and checks access', async () => {
    const { f, room, document } = await setup();
    const copy = await f.dr.api.redaction.apply(as('alice'), {
      tenantId: TENANT,
      nodeId: document.id,
      areas: [{ page: 2, x: 40, y: 770, width: 400, height: 30 }],
      mode: 'copy',
    });
    expect(copy.nodeId).not.toBe(document.id);
    const index = await f.dr.api.rooms.index(as('alice'), { tenantId: TENANT, roomId: room.id });
    expect(index.map((n) => n.name)).toEqual(['census.pdf', 'census (redacted).pdf']);
    const { pages } = await textOf(f, copy.nodeId);
    expect(pages[1]).not.toContain('Appendix');
    expect(pages[0]).toContain('Employee census');

    await expect(
      f.dr.api.redaction.apply(as('alice'), {
        tenantId: TENANT,
        nodeId: document.id,
        areas: [{ page: 9, x: 0, y: 0, width: 1, height: 1 }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      f.dr.api.redaction.find(as('alice'), {
        tenantId: TENANT,
        nodeId: document.id,
        patterns: ['(a+)+$'],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      f.dr.api.redaction.apply(as('alice'), { tenantId: TENANT, nodeId: document.id }),
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
      f.dr.api.redaction.find(as('bob'), {
        tenantId: TENANT,
        nodeId: document.id,
        patterns: ['email'],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
