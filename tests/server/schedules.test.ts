import { describe, expect, it } from 'vitest';
import { as, fixture, TENANT } from '../fixtures.js';

describe('schedules', () => {
  it('closes rooms at their scheduled time, and reopening clears a past date', async () => {
    const f = await fixture();
    const room = await f.room();
    await f.dr.api.rooms.publish(as('alice'), { tenantId: TENANT, roomId: room.id });
    await f.dr.api.rooms.update(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      closesAt: f.clock.current + 3_600_000,
    });
    const events: string[] = [];
    f.dr.events.subscribe('room.*', (event) => void events.push(event.type));

    expect(await f.dr.maintain()).toMatchObject({ closed: 0 });
    f.clock.current += 2 * 3_600_000;
    expect(await f.dr.maintain()).toMatchObject({ closed: 1 });
    const closed = await f.dr.api.rooms.get(as('alice'), { tenantId: TENANT, roomId: room.id });
    expect(closed.status).toBe('closed');
    expect(events).toContain('room.closed');
    const activity = await f.dr.api.activity.list(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
    });
    expect(activity.find((record) => record.action === 'room.closed')).toMatchObject({
      actorId: 'system',
    });
    await expect(
      f.dr.api.folders.create(as('alice'), {
        tenantId: TENANT,
        parentId: room.rootNodeId,
        name: 'Late',
      }),
    ).rejects.toMatchObject({ code: 'ROOM_CLOSED' });

    await f.dr.api.rooms.reopen(as('alice'), { tenantId: TENANT, roomId: room.id });
    expect(
      (await f.dr.api.rooms.get(as('alice'), { tenantId: TENANT, roomId: room.id })).closesAt,
    ).toBeUndefined();
    expect(await f.dr.maintain()).toMatchObject({ closed: 0 });
  });

  it('marks members whose access window ended', async () => {
    const f = await fixture();
    const room = await f.room();
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
      accessDays: 1,
    });
    const outsider = await f.dr.api.members.invite(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      email: 'olga@partner.test',
      groupIds: [team.id],
      accessDays: 1,
    });
    expect(await f.dr.maintain()).toMatchObject({ expiredMembers: 0 });
    f.clock.current += 2 * 86_400_000;
    expect(await f.dr.maintain()).toMatchObject({ expiredMembers: 2 });
    // Not only marked: out of the room's groups in the identity system, and the unredeemed invitation withdrawn.
    expect(f.iam.state.groups.get(team.iamGroupId)!.members.has('bob')).toBe(false);
    expect(f.iam.state.invitations.find((i) => i.email === 'olga@partner.test')).toMatchObject({
      revoked: true,
    });
    expect(outsider.status).toBe('invited');
    const members = await f.dr.api.members.list(as('alice'), { tenantId: TENANT, roomId: room.id });
    expect(members.find((member) => member.email === 'bob@acme.test')).toMatchObject({
      status: 'expired',
    });
    const activity = await f.dr.api.activity.list(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
    });
    expect(
      activity.some((record) => record.action === 'member.expired' && record.actorId === 'system'),
    ).toBe(true);
    expect(await f.dr.maintain()).toMatchObject({ expiredMembers: 0 });
  });
});
