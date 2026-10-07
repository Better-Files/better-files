import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { extractText } from 'unpdf';
import { auditPlugin, type AuditReport } from '@better-files/plugin-audit';
import { as, fixture, TENANT } from '../fixtures.js';

async function setup() {
  const f = await fixture({ plugins: [auditPlugin()] });
  const room = await f.room();
  const legal = await f.dr.api.folders.create(as('alice'), {
    tenantId: TENANT,
    parentId: room.rootNodeId,
    name: 'Legal',
  });
  const hr = await f.dr.api.folders.create(as('alice'), {
    tenantId: TENANT,
    parentId: room.rootNodeId,
    name: 'HR',
  });
  const { document } = await f.upload('alice', {
    parentId: legal.id,
    filename: 'spa.pdf',
    content: f.bytes(100),
  });
  const buyers = await f.dr.api.groups.create(as('alice'), {
    tenantId: TENANT,
    roomId: room.id,
    name: 'Buyers',
    preset: 'download',
  });
  await f.dr.api.permissions.setEntries(as('alice'), {
    tenantId: TENANT,
    nodeId: hr.id,
    entries: [{ subject: { type: 'group', id: buyers.id }, preset: 'hidden' }],
  });
  await f.dr.api.members.invite(as('alice'), {
    tenantId: TENANT,
    roomId: room.id,
    email: 'bob@acme.test',
    groupIds: [buyers.id],
  });
  // Bob looks at and takes the SPA.
  await f.dr.api.documents.requestDownload(as('bob'), { tenantId: TENANT, nodeId: document.id });
  await f.dr.api.documents.requestDownload(as('bob'), { tenantId: TENANT, nodeId: document.id });
  return { f, room, legal };
}

describe('audit reports', () => {
  it('reports participants, access by group and folder, engagement and chain integrity', async () => {
    const { f, room } = await setup();
    const result = await f.dr.api.audit.report(as('alice'), { tenantId: TENANT, roomId: room.id });
    const report = result.report as AuditReport;
    expect(report.room).toMatchObject({ name: 'Project Falcon', documents: 1, folders: 2 });
    expect(report.chain.valid).toBe(true);
    expect(report.groups).toEqual([
      { name: 'Buyers', kind: expect.any(String), relation: 'viewer', members: 1 },
    ]);
    expect(report.participants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ email: 'bob@acme.test', groups: ['Buyers'] }),
      ]),
    );
    const byPath = Object.fromEntries(report.access.map((row) => [row.path, row.groups.Buyers]));
    expect(byPath['/Legal']).toEqual(expect.arrayContaining(['VIEW', 'DOWNLOAD_WATERMARKED']));
    expect(byPath['/HR']).toEqual([]);
    const bob = report.engagement.find((person) => person.identityId === 'bob')!;
    expect(bob).toMatchObject({ downloads: 2, email: 'bob@acme.test' });
    expect(result.sha256).toBe(
      createHash('sha256')
        .update(JSON.stringify(report, null, 2))
        .digest('hex'),
    );
  });

  it('renders a PDF and files it in the room', async () => {
    const { f, room, legal } = await setup();
    const result = await f.dr.api.audit.report(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      format: 'pdf',
      saveTo: legal.id,
    });
    const bytes = Buffer.from(result.content!, 'base64');
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    const { text } = await extractText(new Uint8Array(bytes), { mergePages: true });
    expect(text).toContain('Audit report: Project Falcon');
    expect(text).toContain('Activity chain: intact');
    expect(text).toContain('bob@acme.test');
    const index = await f.dr.api.rooms.index(as('alice'), { tenantId: TENANT, roomId: room.id });
    expect(index.map((node) => node.name)).toContain(result.filename);

    // Buyers cannot pull audit reports.
    await expect(
      f.dr.api.audit.report(as('bob'), { tenantId: TENANT, roomId: room.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
