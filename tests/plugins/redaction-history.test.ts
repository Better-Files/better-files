import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { extractText } from 'unpdf';
import { redactionPlugin } from '@better-files/plugin-redaction';
import { viewerPlugin } from '@better-files/viewer/server';
import { as, fixture, TENANT } from '../fixtures.js';

async function census() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([595, 842]).drawText('SSN 123-45-6789 on file.', { x: 50, y: 780, size: 12, font });
  return new Uint8Array(await pdf.save());
}

/** A redacted document, and a buyer allowed to download originals of it. */
async function setup() {
  const f = await fixture({ plugins: [redactionPlugin()] });
  const room = await f.room();
  const call = { tenantId: TENANT };
  const { document, version: unredacted } = await f.upload('alice', {
    parentId: room.rootNodeId,
    filename: 'census.pdf',
    content: await census(),
    mimeType: 'application/pdf',
  });
  await f.dr.api.redaction.apply(as('alice'), { ...call, nodeId: document.id, patterns: ['ssn'] });
  const buyers = await f.dr.api.groups.create(as('alice'), {
    ...call,
    roomId: room.id,
    name: 'Buyers',
    preset: 'view',
  });
  await f.dr.api.members.invite(as('alice'), {
    ...call,
    roomId: room.id,
    email: 'bob@acme.test',
    groupIds: [buyers.id],
  });
  await f.dr.api.permissions.setEntries(as('alice'), {
    ...call,
    nodeId: document.id,
    entries: [{ subject: { type: 'group', id: buyers.id }, preset: 'downloadOriginal' }],
  });
  return { f, room, document, unredacted, call };
}

const textOf = async (f: Awaited<ReturnType<typeof setup>>['f'], url: string) => {
  const { body } = await f.download(url);
  return (await extractText(new Uint8Array(body), { mergePages: true })).text;
};

describe('version history and redaction', () => {
  it('keeps the unredacted version from people who may only read the document', async () => {
    const { f, document, unredacted, call } = await setup();
    // The buyer gets the redacted current version.
    const current = await f.dr.api.documents.requestOriginal(as('bob'), {
      ...call,
      nodeId: document.id,
    });
    expect(await textOf(f, current.url)).not.toContain('123-45-6789');

    // Neither the history nor an earlier version id leads back to the original.
    const versions = await f.dr.api.versions.list(as('bob'), { ...call, nodeId: document.id });
    expect(versions.map((version) => version.id)).not.toContain(unredacted.id);
    for (const request of ['requestOriginal', 'requestDownload', 'requestView'] as const)
      await expect(
        f.dr.api.documents[request](as('bob'), {
          ...call,
          nodeId: document.id,
          versionId: unredacted.id,
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('keeps earlier versions out of the secure viewer for readers', async () => {
    const f = await fixture({ plugins: [viewerPlugin()] });
    const room = await f.room();
    const call = { tenantId: TENANT };
    const first = await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'cim.pdf',
      content: await census(),
      mimeType: 'application/pdf',
    });
    await f.upload('alice', {
      documentId: first.document.id,
      filename: 'cim.pdf',
      content: await census(),
      mimeType: 'application/pdf',
    });
    const team = await f.dr.api.groups.create(as('alice'), {
      ...call,
      roomId: room.id,
      name: 'Buyers',
      preset: 'view',
    });
    await f.dr.api.members.invite(as('alice'), {
      ...call,
      roomId: room.id,
      email: 'bob@acme.test',
      groupIds: [team.id],
    });
    const viewer = (f.dr.api as unknown as Record<string, Record<string, Function>>).viewer!;
    const earlier = { ...call, nodeId: first.document.id, versionId: first.version.id };
    await expect(viewer.open!(as('bob'), earlier)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(viewer.pages!(as('bob'), { ...earlier, from: 1, to: 1 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    // The current version opens; editors may open the earlier one.
    await expect(
      viewer.open!(as('bob'), { ...call, nodeId: first.document.id }),
    ).resolves.toMatchObject({ supported: true });
    await expect(viewer.open!(as('alice'), earlier)).resolves.toMatchObject({
      versionId: first.version.id,
    });
  });

  it('still gives editors the whole history', async () => {
    const { f, document, unredacted, call } = await setup();
    const versions = await f.dr.api.versions.list(as('alice'), { ...call, nodeId: document.id });
    expect(versions).toHaveLength(2);
    const earlier = await f.dr.api.documents.requestOriginal(as('alice'), {
      ...call,
      nodeId: document.id,
      versionId: unredacted.id,
    });
    expect(await textOf(f, earlier.url)).toContain('123-45-6789');
  });
});
