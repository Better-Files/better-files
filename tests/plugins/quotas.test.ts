import { describe, expect, it } from 'vitest';
import { quotasPlugin } from '@better-files/plugin-quotas';
import { as, fixture, TENANT } from '../fixtures.js';

async function setup() {
  const f = await fixture({
    plugins: [
      quotasPlugin({
        room: { maxBytes: 10_000, maxFileBytes: 6_000 },
        tenant: () => ({ maxDocuments: 5 }),
      }),
    ],
  });
  const events: { type: string; data: Record<string, unknown> }[] = [];
  f.dr.events.subscribe('quota.*', (event) => void events.push(event));
  const room = await f.room();
  const upload = (
    size: number,
    name = `f-${Math.random().toString(36).slice(2)}.bin`,
    target = room.rootNodeId,
  ) => f.upload('alice', { parentId: target, filename: name, content: f.bytes(size) });
  const usage = () => f.dr.api.quotas.room(as('alice'), { tenantId: TENANT, roomId: room.id });
  return { f, room, events, upload, usage };
}

describe('quotas plugin', () => {
  it('enforces file size and room storage before upload, warns once, and counts versions', async () => {
    const { f, room, events, upload, usage } = await setup();
    const { document } = await upload(4_000, 'a.bin');
    expect(await usage()).toMatchObject({
      bytes: 4_000,
      documents: 1,
      versions: 1,
      ratio: { bytes: 0.4 },
    });

    await expect(upload(7_000)).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      message: expect.stringContaining('6000 bytes'),
    });
    await upload(4_500, 'b.bin');
    expect(events.filter((event) => event.type === 'quota.warning')).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ scope: 'room', kind: 'bytes', used: 8_500, limit: 10_000 }),
      }),
    ]);
    await expect(upload(2_000)).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      message: 'This room is out of storage',
    });
    expect(events.some((event) => event.type === 'quota.exceeded')).toBe(true);

    // A new version adds bytes but not a document.
    await f.dr.api.quotas.setRoom(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      maxBytes: 100_000,
    });
    await f.upload('alice', {
      documentId: document.id,
      filename: 'a.bin',
      content: f.bytes(1_000),
    });
    expect(await usage()).toMatchObject({
      bytes: 9_500,
      documents: 2,
      versions: 3,
      limits: { maxBytes: 100_000, maxFileBytes: 6_000 },
    });

    // Trash still counts until it is purged; maintenance then gives the space back.
    await f.dr.api.documents.delete(as('alice'), { tenantId: TENANT, nodeId: document.id });
    expect((await usage()).bytes).toBe(9_500);
    f.clock.current += 400 * 86_400_000;
    await f.dr.maintain();
    expect(await usage()).toMatchObject({ bytes: 4_500, documents: 1, versions: 1 });
  });

  it('applies tenant limits across rooms and keeps limits to administrators', async () => {
    const { f, room, upload } = await setup();
    for (let i = 0; i < 3; i++) await upload(100);
    const second = await f.dr.api.rooms.create(as('alice'), { tenantId: TENANT, name: 'Second' });
    await upload(100, 'x.bin', second.rootNodeId);
    await upload(100, 'y.bin', second.rootNodeId);
    await expect(upload(100, 'z.bin', second.rootNodeId)).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      message: 'Your organization is out of storage',
    });
    expect(await f.dr.api.quotas.tenant(as('alice'), { tenantId: TENANT })).toMatchObject({
      documents: 5,
      limits: { maxDocuments: 5 },
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
    expect(
      await f.dr.api.quotas.room(as('bob'), { tenantId: TENANT, roomId: room.id }),
    ).toMatchObject({ documents: 3 });
    await expect(
      f.dr.api.quotas.setRoom(as('bob'), { tenantId: TENANT, roomId: room.id, maxBytes: 1 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
