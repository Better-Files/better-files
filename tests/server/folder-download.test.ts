import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { extractText } from 'unpdf';
import { watermarkPlugin } from '@better-files/plugin-watermark';
import { as, fixture, TENANT } from '../fixtures.js';
import { unzip } from '../helpers.js';

async function pdf(text: string) {
  const document = await PDFDocument.create();
  document.addPage([595, 842]).drawText(text, { x: 50, y: 780, size: 16 });
  return new Uint8Array(await document.save());
}

async function setup() {
  const f = await fixture({ plugins: [watermarkPlugin()] });
  const room = await f.room();
  const legal = await f.dr.api.folders.create(as('alice'), {
    tenantId: TENANT,
    parentId: room.rootNodeId,
    name: 'Legal',
  });
  const contracts = await f.dr.api.folders.create(as('alice'), {
    tenantId: TENANT,
    parentId: legal.id,
    name: 'Contracts',
  });
  const hidden = await f.dr.api.folders.create(as('alice'), {
    tenantId: TENANT,
    parentId: legal.id,
    name: 'Board only',
  });
  await f.upload('alice', {
    parentId: legal.id,
    filename: 'nda.pdf',
    content: await pdf('Mutual NDA'),
    mimeType: 'application/pdf',
  });
  await f.upload('alice', {
    parentId: contracts.id,
    filename: 'spa.pdf',
    content: await pdf('Share purchase'),
    mimeType: 'application/pdf',
  });
  await f.upload('alice', {
    parentId: contracts.id,
    filename: 'notes.txt',
    content: new TextEncoder().encode('plain notes'),
  });
  await f.upload('alice', {
    parentId: hidden.id,
    filename: 'minutes.pdf',
    content: await pdf('Minutes'),
    mimeType: 'application/pdf',
  });
  const team = await f.dr.api.groups.create(as('alice'), {
    tenantId: TENANT,
    roomId: room.id,
    name: 'Buyers',
    preset: 'download',
  });
  await f.dr.api.permissions.setEntries(as('alice'), {
    tenantId: TENANT,
    nodeId: hidden.id,
    entries: [{ subject: { type: 'group', id: team.id }, preset: 'hidden' }],
  });
  await f.dr.api.members.invite(as('alice'), {
    tenantId: TENANT,
    roomId: room.id,
    email: 'bob@acme.test',
    groupIds: [team.id],
  });
  return { f, room, legal };
}

describe('folder downloads', () => {
  it('zips what the requester may take, watermarked for them, and says what was left out', async () => {
    const { f, room, legal } = await setup();
    const ticket = await f.dr.api.folders.requestDownload(as('bob'), {
      tenantId: TENANT,
      nodeId: legal.id,
    });
    expect(ticket).toMatchObject({ files: 3, excluded: 0 });
    const { response, body } = await f.download(ticket.url);
    expect(response.headers.get('content-disposition')).toContain('Legal.zip');
    const files = unzip(body);
    expect([...files.keys()].sort()).toEqual([
      'Contracts/spa.pdf',
      'NOT-INCLUDED.txt',
      'index.csv',
      'nda.pdf',
    ]);
    // Stamped for Bob; the text file cannot be watermarked, so it is listed rather than sent as an original.
    const { text } = await extractText(new Uint8Array(files.get('nda.pdf')!), { mergePages: true });
    expect(text).toContain('bob@acme.test');
    expect(new TextDecoder().decode(files.get('NOT-INCLUDED.txt'))).toContain(
      'Contracts/notes.txt (cannot be watermarked)',
    );

    // Bob may not take originals: nothing is included, and everything is counted.
    const originals = await f.dr.api.folders.requestDownload(as('bob'), {
      tenantId: TENANT,
      nodeId: legal.id,
      variant: 'original',
    });
    expect(originals).toMatchObject({ files: 0, excluded: 3 });

    // The owner takes originals, hidden folder included.
    const owner = await f.dr.api.folders.requestDownload(as('alice'), {
      tenantId: TENANT,
      nodeId: legal.id,
      variant: 'original',
    });
    const all = unzip((await f.download(owner.url)).body);
    expect([...all.keys()].filter((name) => name !== 'index.csv').sort()).toEqual([
      'Board only/minutes.pdf',
      'Contracts/notes.txt',
      'Contracts/spa.pdf',
      'nda.pdf',
    ]);
    expect(new TextDecoder().decode(all.get('Contracts/notes.txt'))).toBe('plain notes');

    const activity = await f.dr.api.activity.list(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
    });
    expect(activity.filter((record) => record.action === 'folder.downloaded')).toHaveLength(3);
    // Outsiders see nothing.
    await expect(
      f.dr.api.folders.requestDownload(as('dave'), { tenantId: TENANT, nodeId: legal.id }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('requires a second factor for every ZIP variant when the room asks for it', async () => {
    const { f, room, legal } = await setup();
    await f.dr.api.rooms.update(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      settings: { requireMfaForDownload: true },
    });
    for (const variant of ['watermarked', 'original'] as const) {
      await expect(
        f.dr.api.folders.requestDownload(as('bob'), {
          tenantId: TENANT,
          nodeId: legal.id,
          variant,
        }),
        variant,
      ).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
    }
    f.principals.bob = { ...f.principals.bob!, mfa: true };
    await expect(
      f.dr.api.folders.requestDownload(as('bob'), { tenantId: TENANT, nodeId: legal.id }),
    ).resolves.toMatchObject({ files: 3 });
  });
});
