import { afterEach, describe, expect, it } from 'vitest';
import {
  bypassBetterFilesGuard,
  outsiderBoundary,
  OUTSIDERS_GROUP_NAME,
  PARTICIPANT_ROLE_NAME,
} from '@better-files/iam';
import { closeStores, fixture, type Fixture } from './iam-fixture.js';

afterEach(closeStores);

/** A room with a view group holding Dana, plus the IAM records Better Files made for it. */
async function room(f: Fixture, name = 'Falcon') {
  const created = await f.dr.api.rooms.create(f.owner, { tenantId: f.tenantId, name });
  const buyers = await f.dr.api.groups.create(f.owner, {
    tenantId: f.tenantId,
    roomId: created.id,
    name: 'Buyers',
    preset: 'view',
  });
  const tuples = await f.iam.api.relationships.list(f.owner, {
    tenantId: f.tenantId,
    type: 'better-files-room',
    id: created.id,
  });
  const groupTuple = tuples.find((tuple) => tuple.subjectType === 'group')!;
  const role = (await f.iam.api.roles.list(f.owner, { tenantId: f.tenantId })).find(
    (r) => r.name === PARTICIPANT_ROLE_NAME,
  )!;
  return { room: created, buyers, groupTuple, iamGroupId: groupTuple.subjectId, roleId: role.id };
}

const roomIds = async (f: Fixture, credential: { token: string }) =>
  (await f.dr.api.rooms.list(credential, { tenantId: f.tenantId })).map((r) => r.id);

describe('Better IAM plugin hooks', () => {
  it('refuses changes to Better Files-managed records made outside Better Files', async () => {
    const f = await fixture();
    const { room: falcon, groupTuple, iamGroupId, roleId } = await room(f);
    const erin = await f.member('erin');
    const managed = { code: 'BETTER_FILES_MANAGED' };

    // Room resources and their relations.
    await expect(
      f.iam.api.resources.update(f.owner, {
        tenantId: f.tenantId,
        type: 'better-files-room',
        id: falcon.id,
        attributes: { requireMfa: false },
      }),
    ).rejects.toMatchObject(managed);
    await expect(
      f.iam.api.relationships.create(f.owner, {
        tenantId: f.tenantId,
        type: 'better-files-room',
        id: falcon.id,
        relation: 'viewer',
        subjectType: 'identity',
        subjectId: erin.id,
      }),
    ).rejects.toMatchObject(managed);
    await expect(
      f.iam.api.relationships.delete(f.owner, {
        tenantId: f.tenantId,
        relationshipId: groupTuple.id,
      }),
    ).rejects.toMatchObject(managed);
    await expect(
      f.iam.api.resources.delete(f.owner, {
        tenantId: f.tenantId,
        type: 'better-files-room',
        id: falcon.id,
      }),
    ).rejects.toMatchObject(managed);
    expect(await roomIds(f, erin.credential)).toEqual([]);

    // The participant role, its bindings, and the room's groups.
    await expect(
      f.iam.api.roles.delete(f.owner, { tenantId: f.tenantId, roleId }),
    ).rejects.toMatchObject(managed);
    const [binding] = (await f.iam.api.bindings.list(f.owner, { tenantId: f.tenantId })).filter(
      (b) => b.roleId === roleId,
    );
    await expect(
      f.iam.api.bindings.delete(f.owner, { tenantId: f.tenantId, bindingId: binding!.id }),
    ).rejects.toMatchObject(managed);
    await expect(
      f.iam.api.groups.delete(f.owner, { tenantId: f.tenantId, groupId: iamGroupId }),
    ).rejects.toMatchObject(managed);

    // Reads, and records Better Files does not manage, are untouched.
    const other = await f.iam.api.groups.create(f.owner, { tenantId: f.tenantId, name: 'Staff' });
    await f.iam.api.groups.delete(f.owner, { tenantId: f.tenantId, groupId: other.id });

    // Better Files' own writes pass: inviting, removing, and deleting the room with its groups.
    const dana = await f.member('dana');
    const invited = await f.dr.api.members.invite(f.owner, {
      tenantId: f.tenantId,
      roomId: falcon.id,
      email: 'dana@acme.test',
      relation: 'viewer',
    });
    expect(await roomIds(f, dana.credential)).toEqual([falcon.id]);
    await f.dr.api.members.remove(f.owner, {
      tenantId: f.tenantId,
      roomId: falcon.id,
      memberId: invited.id,
    });
    expect(await roomIds(f, dana.credential)).toEqual([]);
    await f.dr.api.rooms.delete(f.owner, {
      tenantId: f.tenantId,
      roomId: falcon.id,
      confirmName: 'Falcon',
    });
    await expect(
      f.iam.api.resources.get(f.owner, {
        tenantId: f.tenantId,
        type: 'better-files-room',
        id: falcon.id,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('lets repairs through with bypassBetterFilesGuard, and can be turned off', async () => {
    const f = await fixture();
    const { room: falcon } = await room(f);
    const erin = await f.member('erin');
    const grant = {
      tenantId: f.tenantId,
      type: 'better-files-room',
      id: falcon.id,
      relation: 'viewer',
    };
    await bypassBetterFilesGuard(() =>
      f.iam.api.relationships.create(f.owner, {
        ...grant,
        subjectType: 'identity',
        subjectId: erin.id,
      }),
    );
    expect(
      (await f.iam.api.relationships.list(f.owner, grant)).some((t) => t.subjectId === erin.id),
    ).toBe(true);

    const open = await fixture({ plugin: { guard: false } });
    const { roleId } = await room(open);
    await expect(
      open.iam.api.roles.delete(open.owner, { tenantId: open.tenantId, roleId }),
    ).resolves.toBeDefined();
  });

  it('holds outsiders to outsiderBoundary() and keeps the outsiders group from being renamed', async () => {
    const f = await fixture({ integration: { externalInvites: 'members' } });
    const { room: falcon, buyers } = await room(f, 'Diligence');
    await f.dr.api.members.invite(f.owner, {
      tenantId: f.tenantId,
      roomId: falcon.id,
      email: 'gina@partner.test',
      groupIds: [buyers.id],
    });
    await f.iam.auth.dispatchOutbox();
    const email = f.inbox.find(
      (m) => m.template === 'member-invitation' && m.to === 'gina@partner.test',
    )!;
    const accepted = await f.iam.api.identities.acceptInvitation({
      tenantId: f.tenantId,
      token: email.payload.token!,
      name: 'Gina',
      password: 'a strong outsider password',
    });
    if (!('token' in accepted)) throw new Error('Unexpected MFA');
    const gina = { token: accepted.token };
    const ginaId = (await f.dr.api.probe.whoami(gina, { tenantId: f.tenantId })).id;
    const dana = await f.member('dana');

    // A host role that lets members read the directory, except people from outside.
    const role = await f.iam.api.roles.create(f.owner, {
      tenantId: f.tenantId,
      name: 'Directory readers',
      document: {
        version: 1,
        statements: [
          { effect: 'allow', actions: ['iam:identities:read'], resources: ['iam/*'] },
          outsiderBoundary({ actions: ['iam:identities:read'], resources: ['iam/*'] }),
        ],
      },
    });
    for (const subjectId of [ginaId, dana.id])
      await f.iam.api.bindings.create(f.owner, {
        tenantId: f.tenantId,
        roleId: role.id,
        subjectType: 'identity',
        subjectId,
      });
    await expect(
      f.iam.api.identities.list(dana.credential, { tenantId: f.tenantId }),
    ).resolves.toBeDefined();
    await expect(f.iam.api.identities.list(gina, { tenantId: f.tenantId })).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    });

    // Renaming the outsiders group would turn them into members on the next lookup; taking one person out is fine.
    const [outsiders] = await f.store.find('groups', {
      tenantId: f.tenantId,
      name: OUTSIDERS_GROUP_NAME,
    });
    await expect(
      f.iam.api.groups.update(f.owner, {
        tenantId: f.tenantId,
        groupId: outsiders!.id,
        name: 'Partners',
      }),
    ).rejects.toMatchObject({ code: 'BETTER_FILES_MANAGED' });
    await f.iam.api.groups.removeMember(f.owner, {
      tenantId: f.tenantId,
      groupId: outsiders!.id,
      identityId: ginaId,
    });
    await expect(f.iam.api.identities.list(gina, { tenantId: f.tenantId })).resolves.toBeDefined();
  });

  it('recovers when the participant role is deleted behind its back', async () => {
    const f = await fixture({ plugin: { guard: false } });
    const first = await room(f, 'First');
    await f.iam.api.roles.delete(f.owner, { tenantId: f.tenantId, roleId: first.roleId });

    // Without the audit event yet: the stale role id fails, and Better Files finds or creates the role again.
    const dana = await f.member('dana');
    const second = await room(f, 'Second');
    expect(second.roleId).not.toBe(first.roleId);
    await f.dr.api.members.invite(f.owner, {
      tenantId: f.tenantId,
      roomId: second.room.id,
      email: 'dana@acme.test',
      groupIds: [second.buyers.id],
    });
    expect(await roomIds(f, dana.credential)).toEqual([second.room.id]);

    // With the audit event dispatched, cached bindings are forgotten too, so a subject bound before binds again.
    const erin = await f.member('erin');
    const direct = (roomId: string) =>
      f.dr.api.members.invite(f.owner, {
        tenantId: f.tenantId,
        roomId,
        email: 'erin@acme.test',
        relation: 'viewer',
      });
    await direct(second.room.id);
    expect(await roomIds(f, erin.credential)).toEqual([second.room.id]);
    await f.iam.api.roles.delete(f.owner, { tenantId: f.tenantId, roleId: second.roleId });
    expect(await roomIds(f, erin.credential)).toEqual([]);
    await f.iam.events.dispatch();
    const third = await room(f, 'Third');
    await direct(third.room.id);
    expect((await roomIds(f, erin.credential)).sort()).toEqual(
      [second.room.id, third.room.id].sort(),
    );
  });
});
