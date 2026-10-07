import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { searchPlugin } from '@better-files/plugin-search';
import { as, fixture, TENANT } from '../fixtures.js';

const text = (value: string) => new TextEncoder().encode(value);

describe('search plugin', () => {
  it('finds names and text, and only what the caller may see', async () => {
    const f = await fixture({ plugins: [searchPlugin({ indexContent: true })] });
    const room = await f.room();
    const finance = await f.dr.api.folders.create(as('alice'), {
      tenantId: TENANT,
      parentId: room.rootNodeId,
      name: 'Finance',
    });
    const hr = await f.dr.api.folders.create(as('alice'), {
      tenantId: TENANT,
      parentId: room.rootNodeId,
      name: 'HR',
    });
    await f.upload('alice', {
      parentId: finance.id,
      filename: 'revenue-model.csv',
      mimeType: 'text/csv',
      content: text(
        'quarter,revenue\nQ1,1000\nNote: deferred revenue recognised over the contract term.',
      ),
    });
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage().drawText('Employee retention bonus schedule', { x: 50, y: 700, size: 14, font });
    await f.upload('alice', {
      parentId: hr.id,
      filename: 'bonuses.pdf',
      mimeType: 'application/pdf',
      content: new Uint8Array(await pdf.save()),
    });

    const byName = await f.dr.api.search.query(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      q: 'revenue',
    });
    expect(byName.map((r) => r.name)).toEqual(['revenue-model.csv']);
    expect(byName[0]!.snippet).toContain('deferred revenue recognised');

    const inPdf = await f.dr.api.search.query(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      q: 'retention BONUS',
    });
    expect(inPdf.map((r) => r.name)).toEqual(['bonuses.pdf']);

    // Bob sees Finance only, and names without snippets.
    const team = await f.dr.api.groups.create(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      name: 'Buyers',
      preset: 'hidden',
    });
    await f.dr.api.permissions.setEntries(as('alice'), {
      tenantId: TENANT,
      nodeId: room.rootNodeId,
      entries: [{ subject: { type: 'group', id: team.id }, capabilities: ['LIST'] }],
    });
    await f.dr.api.permissions.setEntries(as('alice'), {
      tenantId: TENANT,
      nodeId: hr.id,
      entries: [{ subject: { type: 'group', id: team.id }, preset: 'hidden' }],
    });
    await f.dr.api.members.invite(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      email: 'bob@acme.test',
      groupIds: [team.id],
    });
    expect(
      await f.dr.api.search.query(as('bob'), { tenantId: TENANT, roomId: room.id, q: 'bonus' }),
    ).toEqual([]);
    const limited = await f.dr.api.search.query(as('bob'), {
      tenantId: TENANT,
      roomId: room.id,
      q: 'deferred',
    });
    expect(limited).toEqual([expect.objectContaining({ name: 'revenue-model.csv' })]);
    expect(limited[0]).not.toHaveProperty('snippet');
  });

  it('follows renames and deletions, and indexes names only by default', async () => {
    const f = await fixture({ plugins: [searchPlugin()] });
    const room = await f.room();
    const doc = await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'draft.txt',
      content: text('secret merger codename'),
    });
    expect(
      await f.dr.api.search.query(as('alice'), {
        tenantId: TENANT,
        roomId: room.id,
        q: 'codename',
      }),
    ).toEqual([]);
    await f.dr.api.documents.rename(as('alice'), {
      tenantId: TENANT,
      nodeId: doc.document.id,
      name: 'Final agreement.txt',
    });
    expect(
      (
        await f.dr.api.search.query(as('alice'), { tenantId: TENANT, roomId: room.id, q: 'final' })
      ).map((r) => r.name),
    ).toEqual(['Final agreement.txt']);
    await f.dr.api.documents.delete(as('alice'), { tenantId: TENANT, nodeId: doc.document.id });
    expect(
      await f.dr.api.search.query(as('alice'), { tenantId: TENANT, roomId: room.id, q: 'final' }),
    ).toEqual([]);
    expect(
      await f.dr.api.search.reindex(as('alice'), { tenantId: TENANT, roomId: room.id }),
    ).toEqual({ indexed: 0 });
  });
});
