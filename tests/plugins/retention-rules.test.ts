import { describe, expect, it } from 'vitest';
import { retentionPlugin } from '@better-files/plugin-retention';
import { as, fixture, TENANT } from '../fixtures.js';

const DAY = 86_400_000;

async function setup(options: { closedRoomRetentionDays?: number } = {}) {
  const clock = { now: () => f.clock.current };
  const f = await fixture({ plugins: [retentionPlugin({ ...options, clock })] });
  const room = await f.room();
  const records = await f.dr.api.folders.create(as('alice'), {
    tenantId: TENANT,
    parentId: room.rootNodeId,
    name: 'Records',
  });
  const other = await f.dr.api.folders.create(as('alice'), {
    tenantId: TENANT,
    parentId: room.rootNodeId,
    name: 'Other',
  });
  return { f, room, records, other };
}

describe('retention rules', () => {
  it('keeps documents in scope until their retention period ends', async () => {
    const { f, room, records, other } = await setup();
    const kept = await f.upload('alice', {
      parentId: records.id,
      filename: 'ledger.pdf',
      content: f.bytes(10),
    });
    const free = await f.upload('alice', {
      parentId: other.id,
      filename: 'draft.txt',
      content: f.bytes(10),
    });
    const rule = await f.dr.api.retention.addRule(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      nodeId: records.id,
      name: 'Books and records',
      keepDays: 30,
    });
    expect(rule).toMatchObject({ keepDays: 30, locked: false, nodeId: records.id });

    await expect(
      f.dr.api.documents.delete(as('alice'), { tenantId: TENANT, nodeId: kept.document.id }),
    ).rejects.toMatchObject({ code: 'LEGAL_HOLD', message: expect.stringContaining('ledger.pdf') });
    // Deleting the folder would take the document with it.
    await expect(
      f.dr.api.folders.delete(as('alice'), { tenantId: TENANT, nodeId: records.id }),
    ).rejects.toMatchObject({ code: 'LEGAL_HOLD' });
    await expect(
      f.dr.api.documents.delete(as('alice'), { tenantId: TENANT, nodeId: free.document.id }),
    ).resolves.toBeDefined();

    // Bob cannot manage rules.
    await expect(
      f.dr.api.retention.addRule(as('bob'), {
        tenantId: TENANT,
        roomId: room.id,
        name: 'x',
        keepDays: 1,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    f.clock.current += 31 * DAY;
    await expect(
      f.dr.api.documents.delete(as('alice'), { tenantId: TENANT, nodeId: kept.document.id }),
    ).resolves.toBeDefined();
  });

  it('blocks purging the trash and deleting the room, and removal unless locked', async () => {
    const { f, room, records } = await setup();
    const doc = await f.upload('alice', {
      parentId: records.id,
      filename: 'minutes.pdf',
      content: f.bytes(10),
    });
    // Trashed before the rule: the purge must still wait.
    await f.dr.api.documents.delete(as('alice'), { tenantId: TENANT, nodeId: doc.document.id });
    const locked = await f.dr.api.retention.addRule(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      name: 'Regulatory',
      keepDays: 60,
      locked: true,
    });
    const removable = await f.dr.api.retention.addRule(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      name: 'Short',
      keepDays: 5,
    });

    f.clock.current += 31 * DAY;
    expect((await f.dr.maintain()).purged).toBe(0);
    await f.dr.api.rooms.archive(as('alice'), { tenantId: TENANT, roomId: room.id });
    await expect(
      f.dr.api.rooms.delete(as('alice'), {
        tenantId: TENANT,
        roomId: room.id,
        confirmName: 'Project Falcon',
      }),
    ).rejects.toMatchObject({ code: 'LEGAL_HOLD', message: expect.stringContaining('Regulatory') });

    await expect(
      f.dr.api.retention.removeRule(as('alice'), { tenantId: TENANT, ruleId: locked.id }),
    ).rejects.toMatchObject({ code: 'LEGAL_HOLD' });
    await f.dr.api.retention.removeRule(as('alice'), { tenantId: TENANT, ruleId: removable.id });
    await expect(
      f.dr.api.retention.removeRule(as('alice'), { tenantId: TENANT, ruleId: removable.id }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(
      (await f.dr.api.retention.listRules(as('alice'), { tenantId: TENANT, roomId: room.id })).map(
        (rule) => rule.name,
      ),
    ).toEqual(['Regulatory']);
    expect(
      await f.dr.api.retention.listRules(as('alice'), {
        tenantId: TENANT,
        roomId: room.id,
        includeRemoved: true,
      }),
    ).toHaveLength(2);

    f.clock.current += 30 * DAY;
    expect((await f.dr.maintain()).purged).toBe(1);
    await expect(
      f.dr.api.rooms.delete(as('alice'), {
        tenantId: TENANT,
        roomId: room.id,
        confirmName: 'Project Falcon',
      }),
    ).resolves.toEqual({ deleted: true });
  });

  it('notifies closed rooms once their holds and rules no longer keep anything', async () => {
    const { f, room, records } = await setup({ closedRoomRetentionDays: 10 });
    await f.upload('alice', { parentId: records.id, filename: 'a.pdf', content: f.bytes(10) });
    await f.dr.api.retention.addRule(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      name: 'Keep',
      keepDays: 40,
    });
    await f.dr.api.rooms.archive(as('alice'), { tenantId: TENANT, roomId: room.id });

    f.clock.current += 20 * DAY;
    await f.dr.maintain();
    expect(await notified(f, room.id)).toBe(false);

    f.clock.current += 21 * DAY;
    await f.dr.maintain();
    expect(await notified(f, room.id)).toBe(true);
  });
});

describe('moving retained content', () => {
  it('refuses moves that would take items out of a hold or rule, and allows the rest', async () => {
    const { f, room, records, other } = await setup();
    const sub = await f.dr.api.folders.create(as('alice'), {
      tenantId: TENANT,
      parentId: records.id,
      name: 'Sub',
    });
    const held = await f.upload('alice', {
      parentId: records.id,
      filename: 'held.pdf',
      content: f.bytes(10),
    });
    const free = await f.upload('alice', {
      parentId: other.id,
      filename: 'free.pdf',
      content: f.bytes(10),
    });
    await f.dr.api.retention.place(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      nodeId: records.id,
      name: 'Smith v. Acme',
      reason: 'Litigation',
    });

    // Out of the held folder, then deleted: the hold would be escaped.
    await expect(
      f.dr.api.documents.move(as('alice'), {
        tenantId: TENANT,
        nodeId: held.document.id,
        destinationId: other.id,
      }),
    ).rejects.toMatchObject({ code: 'LEGAL_HOLD' });
    await expect(
      f.dr.api.folders.move(as('alice'), {
        tenantId: TENANT,
        nodeId: sub.id,
        destinationId: room.rootNodeId,
      }),
    ).rejects.toMatchObject({ code: 'LEGAL_HOLD' });
    // The refused move left the document where it was.
    await expect(
      f.dr.api.documents.delete(as('alice'), { tenantId: TENANT, nodeId: held.document.id }),
    ).rejects.toMatchObject({ code: 'LEGAL_HOLD' });

    // Moves within the held folder, and into it, are fine.
    await expect(
      f.dr.api.documents.move(as('alice'), {
        tenantId: TENANT,
        nodeId: held.document.id,
        destinationId: sub.id,
      }),
    ).resolves.toBeDefined();
    await expect(
      f.dr.api.documents.move(as('alice'), {
        tenantId: TENANT,
        nodeId: free.document.id,
        destinationId: records.id,
      }),
    ).resolves.toBeDefined();

    // Rules work the same way.
    const kept = await f.upload('alice', {
      parentId: other.id,
      filename: 'kept.pdf',
      content: f.bytes(10),
    });
    await f.dr.api.retention.addRule(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      nodeId: other.id,
      name: 'Keep',
      keepDays: 30,
    });
    await expect(
      f.dr.api.documents.move(as('alice'), {
        tenantId: TENANT,
        nodeId: kept.document.id,
        destinationId: room.rootNodeId,
      }),
    ).rejects.toMatchObject({ code: 'LEGAL_HOLD', message: expect.stringContaining('Keep') });
  });
});

async function notified(f: Awaited<ReturnType<typeof setup>>['f'], roomId: string) {
  const row = await f.database.findOne<{ retentionNotifiedAt?: number }>('rooms', {
    id: roomId,
    tenantId: TENANT,
  });
  return row?.retentionNotifiedAt !== undefined && row.retentionNotifiedAt !== null;
}
