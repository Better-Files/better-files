import { describe, expect, it } from 'vitest';
import { pgliteAdapter } from '@better-files/adapter-pglite';
import { searchPlugin } from '@better-files/plugin-search';
import { syncPlugin } from '@better-files/plugin-sync';
import { as, fixture, TENANT } from '../fixtures.js';

describe('the engine on PostgreSQL (PGlite)', () => {
  it('runs rooms, uploads, permissions, trash, plugins and the activity chain', async () => {
    const f = await fixture({
      database: pgliteAdapter(),
      plugins: [searchPlugin({ indexContent: true }), syncPlugin()],
    });
    try {
      const room = await f.room();
      const legal = await f.dr.api.folders.create(as('alice'), {
        tenantId: TENANT,
        parentId: room.rootNodeId,
        name: 'Legal',
      });
      const content = new TextEncoder().encode('Change of control clause: consent required.');
      const { document } = await f.upload('alice', {
        parentId: legal.id,
        filename: 'spa.txt',
        content,
      });
      await f.upload('alice', {
        documentId: document.id,
        filename: 'spa.txt',
        content: f.bytes(150_000, 7),
      });
      expect(
        await f.dr.api.versions.list(as('alice'), { tenantId: TENANT, nodeId: document.id }),
      ).toHaveLength(2);

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
        nodeId: legal.id,
        entries: [{ subject: { type: 'group', id: team.id }, preset: 'hidden' }],
      });
      expect(await f.dr.api.rooms.index(as('bob'), { tenantId: TENANT, roomId: room.id })).toEqual(
        [],
      );

      const snapshot = await f.dr.api.sync.snapshot(as('alice'), {
        tenantId: TENANT,
        roomId: room.id,
      });
      expect(snapshot.entries.map((e) => e.name)).toEqual(['Legal', 'spa.txt']);
      await f.dr.api.documents.delete(as('alice'), { tenantId: TENANT, nodeId: document.id });
      const changes = await f.dr.api.sync.changes(as('alice'), {
        tenantId: TENANT,
        roomId: room.id,
        cursor: snapshot.cursor,
      });
      expect(changes.changes).toEqual([{ type: 'remove', id: document.id }]);
      await f.dr.api.documents.restore(as('alice'), { tenantId: TENANT, nodeId: document.id });

      const ticket = await f.dr.api.documents.requestOriginal(as('alice'), {
        tenantId: TENANT,
        nodeId: document.id,
      });
      const downloaded = await f.download(ticket.url);
      expect(f.sha256(downloaded.body)).toBe(f.sha256(f.bytes(150_000, 7)));
      expect(await f.dr.verifyActivity({ tenantId: TENANT, roomId: room.id })).toMatchObject({
        valid: true,
      });
    } finally {
      await f.dr.close();
    }
  }, 60_000);
});
