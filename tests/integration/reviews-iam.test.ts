import { afterEach, describe, expect, it } from 'vitest';
import { betterIamAccess } from '@better-files/plugin-reviews';
import { closeStores, fixture } from './iam-fixture.js';

afterEach(closeStores);

describe('access reviews on Better IAM', () => {
  it('finds who Better IAM lets into a room, including access granted outside the roster', async () => {
    const f = await fixture();
    const room = await f.dr.api.rooms.create(f.owner, { tenantId: f.tenantId, name: 'Falcon' });
    const dana = await f.member('dana');
    const buyers = await f.dr.api.groups.create(f.owner, {
      tenantId: f.tenantId,
      roomId: room.id,
      name: 'Buyers',
      preset: 'view',
    });
    await f.dr.api.members.invite(f.owner, {
      tenantId: f.tenantId,
      roomId: room.id,
      email: 'dana@acme.test',
      groupIds: [buyers.id],
    });
    // Erin is in no room, but a tenant policy opens every data room to her.
    const erin = await f.member('erin');
    const role = await f.iam.api.roles.create(f.owner, {
      tenantId: f.tenantId,
      name: 'Deal desk',
      document: {
        version: 1,
        statements: [
          {
            sid: 'AllRooms',
            effect: 'allow',
            actions: ['better-files:rooms:read'],
            resources: ['better-files-room/*'],
          },
        ],
      },
    });
    await f.iam.api.bindings.create(f.owner, {
      tenantId: f.tenantId,
      roleId: role.id,
      subjectType: 'identity',
      subjectId: erin.id,
    });

    const lookup = betterIamAccess(f.iam, { credential: () => f.owner });
    const people = await lookup({ tenantId: f.tenantId, roomId: room.id });
    const ids = people.map((person) => person.identityId);
    expect(ids).toEqual(expect.arrayContaining([dana.id, erin.id]));
    expect(people.find((person) => person.identityId === erin.id)).toMatchObject({
      email: 'erin@acme.test',
      reason: expect.stringContaining('better-files:rooms:read'),
    });

    // Someone with no route into the room is not listed.
    const frank = await f.member('frank');
    expect(
      (await lookup({ tenantId: f.tenantId, roomId: room.id })).map((p) => p.identityId),
    ).not.toContain(frank.id);
  });
});
