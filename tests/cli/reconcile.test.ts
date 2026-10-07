import { describe, expect, it } from 'vitest';
import type { Member, PermissionGroup } from '@better-files/core';
import { main, reconcileIam } from '@better-files/cli';
import { as, fixture, TENANT } from '../fixtures.js';

/** A room with bob in the Buyers group, carol as a direct admin and dave removed again. */
async function setup() {
  const f = await fixture();
  const room = await f.room();
  const buyers = await f.dr.api.groups.create(as('alice'), {
    tenantId: TENANT,
    roomId: room.id,
    name: 'Buyers',
    preset: 'view',
  });
  await f.dr.api.members.invite(as('alice'), {
    tenantId: TENANT,
    roomId: room.id,
    email: 'bob@acme.test',
    groupIds: [buyers.id],
  });
  await f.dr.api.members.invite(as('alice'), {
    tenantId: TENANT,
    roomId: room.id,
    email: 'carol@acme.test',
    relation: 'admin',
  });
  await f.dr.api.members.invite(as('alice'), {
    tenantId: TENANT,
    roomId: room.id,
    email: 'dave@acme.test',
    groupIds: [buyers.id],
  });
  const members = await f.dr.api.members.list(as('alice'), { tenantId: TENANT, roomId: room.id });
  await f.dr.api.members.remove(as('alice'), {
    tenantId: TENANT,
    roomId: room.id,
    memberId: members.find((m) => m.identityId === 'dave')!.id,
  });
  const group = (await f.database.findOne<PermissionGroup>('permissionGroups', {
    tenantId: TENANT,
    id: buyers.id,
  }))!;
  const member = async (identityId: string) =>
    (await f.database.findOne<Member>('members', {
      tenantId: TENANT,
      roomId: room.id,
      identityId,
    }))!;
  return { f, room, group, member, state: f.iam.state };
}

describe('reconcileIam', () => {
  it('finds nothing when the identity system and the rosters agree', async () => {
    const { f } = await setup();
    const report = await reconcileIam(f.dr, { tenantId: TENANT });
    expect(report).toMatchObject({ rooms: 1, drift: [], repaired: 0, failed: 0 });
  });

  it('reports each kind of drift, repairs it, and leaves orphans unless asked', async () => {
    const { f, room, group, member, state } = await setup();
    const carol = await member('carol');
    // A crash between the two writes, edits made in the identity system, a lost relationship id.
    state.groups.get(group.iamGroupId)!.members.delete('bob');
    state.relationships.delete(carol.relationshipId!);
    state.groups.get(group.iamGroupId)!.members.set('dave', undefined);
    const danglingId = 'rel_dangling';
    const groupTuple = state.relationships.get(group.relationshipId!)!;
    state.relationships.delete(groupTuple.id);
    state.relationships.set(danglingId, { ...groupTuple, id: danglingId });
    const orphan = await f.iam.directory!.grantRoomRole(
      { tenantId: TENANT, credential: {}, actorId: 'test' },
      { roomId: room.id, relation: 'viewer', subjectType: 'identity', subjectId: 'mallory' },
    );
    await f.iam.directory!.grantRoomRole(
      { tenantId: TENANT, credential: {}, actorId: 'test' },
      { roomId: room.id, relation: 'viewer', subjectType: 'identity', subjectId: 'dave' },
    );

    const report = await reconcileIam(f.dr, { tenantId: TENANT });
    expect(report.drift.map((item) => [item.kind, item.subject?.id])).toEqual(
      expect.arrayContaining([
        ['stale-relation-id', group.iamGroupId],
        ['missing-relation', 'carol'],
        ['missing-group-membership', 'bob'],
        ['lingering-relation', 'dave'],
        ['lingering-group-membership', 'dave'],
        ['orphan-relation', 'mallory'],
      ]),
    );
    expect(report.drift).toHaveLength(6);
    expect(report.drift.every((item) => item.repaired === undefined)).toBe(true);
    // Reporting changes nothing.
    expect(state.groups.get(group.iamGroupId)!.members.has('bob')).toBe(false);

    const repaired = await reconcileIam(f.dr, { tenantId: TENANT, repair: true });
    expect(repaired).toMatchObject({ repaired: 5, failed: 0 });
    expect(repaired.drift.find((item) => item.kind === 'orphan-relation')?.repaired).toBe(
      undefined,
    );
    expect(state.groups.get(group.iamGroupId)!.members.has('bob')).toBe(true);
    expect(state.groups.get(group.iamGroupId)!.members.has('dave')).toBe(false);
    expect(
      (await f.database.findOne<PermissionGroup>('permissionGroups', { id: group.id }))!
        .relationshipId,
    ).toBe(danglingId);
    const carolNow = await member('carol');
    expect(state.relationships.get(carolNow.relationshipId!)).toMatchObject({
      relation: 'admin',
      subjectId: 'carol',
    });
    // Carol can administer the room again.
    await expect(
      f.dr.api.members.list(as('carol'), { tenantId: TENANT, roomId: room.id }),
    ).resolves.toBeDefined();

    const remaining = await reconcileIam(f.dr, { tenantId: TENANT });
    expect(remaining.drift.map((item) => item.kind)).toEqual(['orphan-relation']);
    await reconcileIam(f.dr, { tenantId: TENANT, repair: true, revokeOrphans: true });
    expect(state.relationships.has(orphan.id)).toBe(false);
    expect((await reconcileIam(f.dr, { tenantId: TENANT })).drift).toEqual([]);
  });

  it('reports rooms the identity system does not know and rooms stuck provisioning', async () => {
    const { f, room } = await setup();
    const stuck = await f.dr.api.rooms.create(as('alice'), { tenantId: TENANT, name: 'Half made' });
    await f.database.transaction((tx) =>
      tx.update('rooms', { id: stuck.id, tenantId: TENANT }, { status: 'provisioning' }),
    );
    const directory = f.iam.directory!;
    const report = await reconcileIam(
      {
        options: {
          database: f.database,
          iam: {
            directory: {
              ...directory,
              async listRoomRoles(call, input) {
                if (input.roomId === room.id)
                  throw Object.assign(new Error('Resource not found'), { code: 'NOT_FOUND' });
                return directory.listRoomRoles(call, input);
              },
            },
          },
        },
      },
      { tenantId: TENANT, now: f.clock.current + 2 * 3_600_000 },
    );
    const found = report.drift.map((item) => [item.kind, item.roomId]);
    expect(found).toHaveLength(2);
    expect(found).toEqual(
      expect.arrayContaining([
        ['unregistered-room', room.id],
        ['stuck-provisioning', stuck.id],
      ]),
    );
  });

  it('runs as `better-files reconcile` with exit codes for drift', async () => {
    const { f, group, state } = await setup();
    state.groups.get(group.iamGroupId)!.members.delete('bob');
    const lines: string[] = [];
    const run = (...args: string[]) =>
      main(['reconcile', '--tenant', TENANT, ...args], {
        out: (line) => lines.push(line),
        err: (line) => lines.push(line),
        env: {},
        cwd: '.',
        load: async () => ({ ...f.dr, close: async () => {} }),
      });
    expect(await run()).toBe(2);
    expect(lines.join('\n')).toMatch(/missing-group-membership[\s\S]*run with --repair to fix/);
    lines.length = 0;
    expect(await run('--repair')).toBe(0);
    expect(lines.at(-1)).toBe('1 difference in 1 room, 1 repaired, 0 failed');
    lines.length = 0;
    expect(await run('--json')).toBe(0);
    expect(JSON.parse(lines.join('\n'))).toMatchObject({ tenantId: TENANT, rooms: 1, drift: [] });
    lines.length = 0;
    expect(
      await main(['reconcile'], { out: () => {}, err: (l) => lines.push(l), env: {}, cwd: '.' }),
    ).toBe(1);
    expect(lines[0]).toMatch(/needs --tenant/);
  });
});
