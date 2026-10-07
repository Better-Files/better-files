import { describe, expect, it } from 'vitest';
import type { Member, PermissionGroup } from '@better-files/core';
import { reconcileIam } from '@better-files/cli';
import { bypassBetterFilesGuard } from '@better-files/iam';
import { betterIamTenant } from './better-iam-tenant.js';

describe('reconcileIam on Better IAM', () => {
  it('finds and repairs drift between Better IAM tuples and groups and the room rosters', async () => {
    const f = await betterIamTenant();
    const room = await f.dr.api.rooms.create(f.owner, { tenantId: f.tenantId, name: 'Falcon' });
    const buyers = await f.dr.api.groups.create(f.owner, {
      tenantId: f.tenantId,
      roomId: room.id,
      name: 'Buyers',
      preset: 'view',
    });
    const dana = await f.member('dana');
    const erin = await f.member('erin');
    await f.dr.api.members.invite(f.owner, {
      tenantId: f.tenantId,
      roomId: room.id,
      email: 'dana@acme.test',
      groupIds: [buyers.id],
    });
    await f.dr.api.members.invite(f.owner, {
      tenantId: f.tenantId,
      roomId: room.id,
      email: 'erin@acme.test',
      relation: 'admin',
    });
    expect((await reconcileIam(f.dr, { tenantId: f.tenantId })).drift).toEqual([]);

    // Edits made in Better IAM directly (past the Better Files guard, as a repair script or an older release would):
    // Dana leaves the group, Erin's admin tuple goes, an extra viewer appears.
    const group = (await f.dr.options.database.findOne<PermissionGroup>('permissionGroups', {
      tenantId: f.tenantId,
      id: buyers.id,
    }))!;
    const erinRow = (await f.dr.options.database.findOne<Member>('members', {
      tenantId: f.tenantId,
      roomId: room.id,
      identityId: erin.id,
    }))!;
    const stranger = await f.member('frank');
    await bypassBetterFilesGuard(async () => {
      await f.iam.api.groups.removeMember(f.owner, {
        tenantId: f.tenantId,
        groupId: group.iamGroupId,
        identityId: dana.id,
      });
      await f.iam.api.relationships.delete(f.owner, {
        tenantId: f.tenantId,
        relationshipId: erinRow.relationshipId!,
      });
      await f.iam.api.relationships.create(f.owner, {
        tenantId: f.tenantId,
        type: 'better-files-room',
        id: room.id,
        relation: 'viewer',
        subjectType: 'identity',
        subjectId: stranger.id,
      });
    });

    const report = await reconcileIam(f.dr, { tenantId: f.tenantId });
    expect(report.drift.map((item) => [item.kind, item.subject?.id]).sort()).toEqual(
      [
        ['missing-group-membership', dana.id],
        ['missing-relation', erin.id],
        ['orphan-relation', stranger.id],
      ].sort(),
    );

    const repaired = await reconcileIam(f.dr, { tenantId: f.tenantId, repair: true });
    expect(repaired).toMatchObject({ repaired: 2, failed: 0 });
    const groups = await f.iam.api.identities.listGroups(f.owner, {
      tenantId: f.tenantId,
      identityId: dana.id,
    });
    expect(groups.map((g) => g.id)).toContain(group.iamGroupId);
    const remaining = await reconcileIam(f.dr, {
      tenantId: f.tenantId,
      repair: true,
      revokeOrphans: true,
    });
    expect(remaining).toMatchObject({ repaired: 1, failed: 0 });
    expect((await reconcileIam(f.dr, { tenantId: f.tenantId })).drift).toEqual([]);
  });
});
