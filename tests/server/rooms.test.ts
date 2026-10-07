import { describe, expect, it } from 'vitest';
import { field } from '@better-files/core';
import { as, fixture, TENANT } from '../fixtures.js';

describe('rooms', () => {
  it('creates a room, registers it with the identity system and makes the creator its owner', async () => {
    const f = await fixture();
    const room = await f.room();
    expect(room).toMatchObject({
      name: 'Project Falcon',
      slug: 'project-falcon',
      status: 'draft',
      ownerId: 'alice',
    });
    expect(room).not.toHaveProperty('kmsKeyId');
    expect(f.iam.state.rooms.get(room.id)).toMatchObject({
      ownerId: 'alice',
      attributes: { status: 'draft' },
    });
    expect([...f.iam.state.relationships.values()]).toContainEqual(
      expect.objectContaining({
        roomId: room.id,
        relation: 'owner',
        subjectType: 'identity',
        subjectId: 'alice',
      }),
    );
    const members = await f.dr.api.members.list(as('alice'), { tenantId: TENANT, roomId: room.id });
    expect(members).toEqual([
      expect.objectContaining({ identityId: 'alice', relation: 'owner', status: 'active' }),
    ]);
    // Slugs stay unique; a second room with the same name gets a suffix.
    const second = await f.room();
    expect(second.slug).toMatch(/^project-falcon-[0-9a-z]{6}$/);
  });

  it('only lets permitted people create rooms, and lists rooms by access', async () => {
    const f = await fixture();
    await expect(
      f.dr.api.rooms.create(as('bob'), { tenantId: TENANT, name: 'Nope' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const room = await f.room();
    expect((await f.dr.api.rooms.list(as('alice'), { tenantId: TENANT })).map((r) => r.id)).toEqual(
      [room.id],
    );
    expect(await f.dr.api.rooms.list(as('bob'), { tenantId: TENANT })).toEqual([]);
    await expect(
      f.dr.api.rooms.get(as('bob'), { tenantId: TENANT, roomId: room.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      f.dr.api.rooms.get(as('mallory'), { tenantId: TENANT, roomId: room.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const got = await f.dr.api.rooms.get(as('alice'), { tenantId: TENANT, roomId: room.id });
    expect(got.capabilities).toContain('MANAGE');
  });

  it('rolls the room back when the identity system refuses it', async () => {
    const f = await fixture();
    const register = f.iam.directory!.registerRoom;
    f.iam.directory!.registerRoom = async () => {
      throw new Error('identity system unavailable');
    };
    await expect(f.room()).rejects.toThrow('identity system unavailable');
    f.iam.directory!.registerRoom = register;
    expect(await f.database.count('rooms')).toBe(0);
    expect(await f.database.count('nodes')).toBe(0);
  });

  it('manages the folder tree with index numbers, moves, trash and restore', async () => {
    const f = await fixture();
    const room = await f.room();
    const root = room.rootNodeId;
    const finance = await f.dr.api.folders.create(as('alice'), {
      tenantId: TENANT,
      parentId: root,
      name: 'Finance',
    });
    const legal = await f.dr.api.folders.create(as('alice'), {
      tenantId: TENANT,
      parentId: root,
      name: 'Legal',
    });
    const tax = await f.dr.api.folders.create(as('alice'), {
      tenantId: TENANT,
      parentId: finance.id,
      name: 'Tax',
    });
    await expect(
      f.dr.api.folders.create(as('alice'), { tenantId: TENANT, parentId: root, name: 'finance' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      f.dr.api.folders.create(as('alice'), { tenantId: TENANT, parentId: root, name: 'a/b' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await f.upload('alice', { parentId: tax.id, filename: 'return.pdf', content: f.bytes(10) });

    const index = await f.dr.api.rooms.index(as('alice'), { tenantId: TENANT, roomId: room.id });
    expect(index.map((n) => [n.index, n.name])).toEqual([
      ['1', 'Finance'],
      ['1.1', 'Tax'],
      ['1.1.1', 'return.pdf'],
      ['2', 'Legal'],
    ]);

    await expect(
      f.dr.api.folders.move(as('alice'), {
        tenantId: TENANT,
        nodeId: finance.id,
        destinationId: tax.id,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await f.dr.api.folders.move(as('alice'), {
      tenantId: TENANT,
      nodeId: tax.id,
      destinationId: legal.id,
    });
    const moved = await f.dr.api.rooms.index(as('alice'), { tenantId: TENANT, roomId: room.id });
    expect(moved.map((n) => [n.index, n.name])).toEqual([
      ['1', 'Finance'],
      ['2', 'Legal'],
      ['2.1', 'Tax'],
      ['2.1.1', 'return.pdf'],
    ]);

    const renamed = await f.dr.api.folders.rename(as('alice'), {
      tenantId: TENANT,
      nodeId: legal.id,
      name: 'Legal & Compliance',
    });
    expect(renamed.name).toBe('Legal & Compliance');

    expect(
      await f.dr.api.folders.delete(as('alice'), { tenantId: TENANT, nodeId: legal.id }),
    ).toEqual({ deleted: 3 });
    expect(
      (await f.dr.api.rooms.index(as('alice'), { tenantId: TENANT, roomId: room.id })).map(
        (n) => n.name,
      ),
    ).toEqual(['Finance']);
    const trash = await f.dr.api.rooms.trash(as('alice'), { tenantId: TENANT, roomId: room.id });
    expect(trash.map((n) => n.name)).toEqual(['Legal & Compliance']);
    await expect(
      f.dr.api.folders.list(as('alice'), { tenantId: TENANT, nodeId: legal.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(
      await f.dr.api.documents.restore(as('alice'), { tenantId: TENANT, nodeId: legal.id }),
    ).toEqual({ restored: 3 });
    expect(
      await f.dr.api.rooms.index(as('alice'), { tenantId: TENANT, roomId: room.id }),
    ).toHaveLength(4);
  });

  it('follows the room lifecycle and refuses changes to closed rooms', async () => {
    const f = await fixture();
    const room = await f.room();
    const call = { tenantId: TENANT, roomId: room.id };
    await expect(f.dr.api.rooms.close(as('alice'), call)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect((await f.dr.api.rooms.publish(as('alice'), call)).status).toBe('live');
    await expect(
      f.dr.api.rooms.delete(as('alice'), { ...call, confirmName: 'Project Falcon' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await f.dr.api.rooms.close(as('alice'), call)).status).toBe('closed');
    expect(f.iam.state.rooms.get(room.id)?.attributes.status).toBe('closed');
    await expect(
      f.dr.api.folders.create(as('alice'), {
        tenantId: TENANT,
        parentId: room.rootNodeId,
        name: 'Late',
      }),
    ).rejects.toMatchObject({ code: 'ROOM_CLOSED' });
    expect((await f.dr.api.rooms.reopen(as('alice'), call)).status).toBe('live');
    await f.dr.api.rooms.close(as('alice'), call);
    expect((await f.dr.api.rooms.archive(as('alice'), call)).status).toBe('archived');
    await expect(
      f.dr.api.rooms.delete(as('alice'), { ...call, confirmName: 'wrong' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(
      await f.dr.api.rooms.delete(as('alice'), { ...call, confirmName: 'Project Falcon' }),
    ).toEqual({ deleted: true });
    expect(f.iam.state.rooms.has(room.id)).toBe(false);
    expect(await f.database.count('nodes')).toBe(0);
    expect(await f.database.count('activity')).toBe(0);
    expect(f.iam.state.audit.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        'better-files:room.created',
        'better-files:room.closed',
        'better-files:room.deleted',
      ]),
    );
  });

  it('records a verifiable activity chain and detects tampering', async () => {
    const f = await fixture();
    const room = await f.room();
    await f.dr.api.folders.create(as('alice'), {
      tenantId: TENANT,
      parentId: room.rootNodeId,
      name: 'A',
    });
    await f.dr.api.rooms.update(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      description: 'Sell-side',
    });
    const records = await f.dr.api.activity.list(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
    });
    expect(records.map((r) => [r.sequence, r.action])).toEqual([
      [3, 'room.updated'],
      [2, 'folder.created'],
      [1, 'room.created'],
    ]);
    expect(
      await f.dr.api.activity.verify(as('alice'), { tenantId: TENANT, roomId: room.id }),
    ).toMatchObject({ valid: true, records: 3 });
    await f.database.transaction((tx) =>
      tx.update('activity', { roomId: room.id, sequence: 2 }, { action: 'folder.renamed' }),
    );
    expect(await f.dr.verifyActivity({ tenantId: TENANT, roomId: room.id })).toMatchObject({
      valid: false,
      brokenAt: 2,
    });
  });

  it('accepts host-defined fields and settings, and refuses unknown ones', async () => {
    const f = await fixture({
      schema: {
        rooms: {
          additionalFields: {
            dealCode: field.string(),
            sector: field.enum(['tech', 'health'] as const, { required: false }),
          },
        },
      },
    });
    await expect(
      f.dr.api.rooms.create(as('alice'), { tenantId: TENANT, name: 'Deal' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const room = await f.dr.api.rooms.create(as('alice'), {
      tenantId: TENANT,
      name: 'Deal',
      fields: { dealCode: 'D-42', sector: 'tech' },
      settings: { downloadsEnabled: false, classification: 'restricted' },
    });
    expect(room).toMatchObject({
      dealCode: 'D-42',
      sector: 'tech',
      settings: { downloadsEnabled: false },
    });
    expect(f.iam.state.rooms.get(room.id)?.attributes).toMatchObject({
      classification: 'restricted',
      downloadsEnabled: false,
    });
    await expect(
      f.dr.api.rooms.update(as('alice'), {
        tenantId: TENANT,
        roomId: room.id,
        fields: { sector: 'energy' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      f.dr.api.rooms.update(as('alice'), {
        tenantId: TENANT,
        roomId: room.id,
        fields: { activityHash: 'x' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      f.dr.api.rooms.create(as('alice'), {
        tenantId: TENANT,
        name: 'X',
        settings: { unknown: true },
      } as never),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const updated = await f.dr.api.rooms.update(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      fields: { sector: 'health' },
    });
    expect(updated.sector).toBe('health');
  });

  it('emits events after commit', async () => {
    const f = await fixture();
    const seen: string[] = [];
    f.dr.events.subscribe(['room.*', 'folder.created'], (event) => void seen.push(event.type));
    const room = await f.room();
    await f.dr.api.folders.create(as('alice'), {
      tenantId: TENANT,
      parentId: room.rootNodeId,
      name: 'A',
    });
    await expect(
      f.dr.api.folders.create(as('alice'), {
        tenantId: TENANT,
        parentId: room.rootNodeId,
        name: 'A',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(seen).toEqual(['room.created', 'folder.created']);
  });
});
