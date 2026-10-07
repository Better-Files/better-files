import {
  conflict,
  createId,
  BetterFilesError,
  invalidInput,
  notFound,
  operationMatrix,
  resourceTypes,
  roomRelations,
  v,
  type AclEntry,
  type DataRoomNode,
  type Member,
  type PermissionGroup,
} from '@better-files/core';
import { auditSecurity, directory, type CoreContext } from '../engine.js';
import { coreEndpoint, requireAction, requireRoom } from './common.js';

const emailSchema = v.string({
  min: 3,
  max: 320,
  trim: true,
  pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
});
const relationSchema = v.enum(roomRelations);
/** Relations a permission group may hold; room ownership and administration are granted to people. */
const groupRelations = ['viewer', 'contributor', 'editor', 'publisher', 'auditor'] as const;

const memberView = (member: Member) => {
  const { tenantId: _tenant, relationshipId: _relationship, ...view } = member;
  return view;
};
const groupView = (group: PermissionGroup, memberCount?: number) => {
  const { tenantId: _tenant, nameKey: _key, relationshipId: _relationship, ...view } = group;
  return { ...view, ...(memberCount === undefined ? {} : { memberCount }) };
};

/** Identity-system errors for "already a member" are fine when adding people: the goal state holds. */
async function ignoreConflict(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code !== 'CONFLICT') throw error;
  }
}

async function roomGroups(context: CoreContext, roomId: string): Promise<PermissionGroup[]> {
  return context.db.findMany<PermissionGroup>('permissionGroups', {
    where: { tenantId: context.tenantId, roomId },
    orderBy: [{ field: 'nameKey' }],
  });
}

async function findMember(context: CoreContext, roomId: string, identityId: string) {
  return context.db.findOne<Member>('members', { tenantId: context.tenantId, roomId, identityId });
}

/** Creates or updates the roster row for an identity. */
async function upsertMember(
  context: CoreContext,
  roomId: string,
  identityId: string,
  patch: Partial<Member>,
): Promise<Member> {
  const existing = await findMember(context, roomId, identityId);
  if (existing) {
    const next = { ...patch, updatedAt: context.now };
    await context.db.update('members', { id: existing.id, tenantId: context.tenantId }, next);
    return { ...existing, ...next } as Member;
  }
  const member: Member = {
    id: createId('member', context.now),
    tenantId: context.tenantId,
    roomId,
    identityId,
    status: 'active',
    groupIds: [],
    guest: false,
    createdAt: context.now,
    updatedAt: context.now,
    ...patch,
  };
  await context.db.insert('members', member);
  return member;
}

async function loadGroup(context: CoreContext, groupId: string): Promise<PermissionGroup> {
  const room = requireRoom(context);
  const group = await context.db.findOne<PermissionGroup>('permissionGroups', {
    id: groupId,
    tenantId: context.tenantId,
    roomId: room.id,
  });
  if (!group) throw notFound('Group');
  return group;
}

async function groupTarget(
  input: { groupId: string },
  lookup: { db: CoreContext['db']; tenantId: string },
) {
  const group = await lookup.db.findOne<PermissionGroup>('permissionGroups', {
    id: input.groupId,
    tenantId: lookup.tenantId,
  });
  if (!group) throw notFound('Group');
  return { roomId: group.roomId };
}

export const memberEndpoints = {
  list: coreEndpoint({
    operation: operationMatrix['members.list'],
    input: v.object({ roomId: v.id(), includeRemoved: v.optional(v.boolean()) }),
    target: (input) => ({ roomId: input.roomId }),
    async handler(context, input) {
      const room = requireRoom(context);
      const members = await context.db.findMany<Member>('members', {
        where: {
          tenantId: context.tenantId,
          roomId: room.id,
          ...(input.includeRemoved ? {} : { status: { ne: 'removed' } }),
        },
        orderBy: [{ field: 'createdAt' }],
      });
      return members.map(memberView);
    },
  }),

  /**
   * Invites many people at once, from a list or a CSV (`email,groups,role,days`; groups by name, separated by `;`).
   * Each row is a regular invitation with its own checks; one bad row does not stop the rest.
   */
  inviteMany: coreEndpoint({
    operation: operationMatrix['members.inviteMany'],
    transaction: 'manual',
    input: v.object({
      roomId: v.id(),
      invitations: v.optional(
        v.array(
          v.object({
            email: emailSchema,
            groups: v.optional(v.array(v.string({ min: 1, max: 120 }), { max: 20 })),
            relation: v.optional(relationSchema),
            accessDays: v.optional(v.number({ int: true, min: 1, max: 365 })),
          }),
          { max: 500 },
        ),
      ),
      csv: v.optional(v.string({ max: 200_000 })),
      message: v.optional(v.string({ max: 1000 })),
    }),
    target: (input) => ({ roomId: input.roomId }),
    async handler(context, input) {
      const room = requireRoom(context);
      const rows: { email: string; groups?: string[]; relation?: string; accessDays?: number }[] = [
        ...(input.invitations ?? []),
      ];
      if (input.csv) {
        const lines = input.csv
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        const cells = (line: string) =>
          line.split(',').map((cell) => cell.trim().replace(/^"|"$/g, ''));
        const header = cells(lines[0] ?? '').map((cell) => cell.toLowerCase());
        const hasHeader = header.includes('email');
        const column = (name: string, fallback: number) =>
          hasHeader ? header.indexOf(name) : fallback;
        const [emailAt, groupsAt, roleAt, daysAt] = [
          column('email', 0),
          column('groups', 1),
          column('role', 2),
          column('days', 3),
        ];
        for (const line of hasHeader ? lines.slice(1) : lines) {
          const row = cells(line);
          const days = daysAt >= 0 && row[daysAt] ? Number(row[daysAt]) : undefined;
          rows.push({
            email: row[emailAt] ?? '',
            ...(groupsAt >= 0 && row[groupsAt]
              ? {
                  groups: row[groupsAt]!.split(';')
                    .map((g) => g.trim())
                    .filter(Boolean),
                }
              : {}),
            ...(roleAt >= 0 && row[roleAt] ? { relation: row[roleAt] } : {}),
            ...(days && Number.isFinite(days) ? { accessDays: days } : {}),
          });
        }
      }
      if (rows.length === 0) throw invalidInput('Give invitations or a CSV');
      if (rows.length > 500) throw invalidInput('Invite at most 500 people at a time');
      const groups = await context.db.findMany<PermissionGroup>('permissionGroups', {
        where: { tenantId: context.tenantId, roomId: room.id },
      });
      const byName = new Map(groups.map((group) => [group.name.toLowerCase(), group.id]));
      const results: {
        email: string;
        ok: boolean;
        status?: string;
        error?: { code: string; message: string };
      }[] = [];
      for (const row of rows) {
        try {
          const unknown = (row.groups ?? []).filter((name) => !byName.has(name.toLowerCase()));
          if (unknown.length) throw invalidInput(`Unknown group ${unknown.join(', ')}`);
          const member = await context.call<{ status: string }>('members.invite', {
            roomId: room.id,
            email: row.email,
            ...(row.groups?.length
              ? { groupIds: row.groups.map((name) => byName.get(name.toLowerCase())!) }
              : {}),
            ...(row.relation ? { relation: row.relation } : {}),
            ...(row.accessDays ? { accessDays: row.accessDays } : {}),
            ...(input.message ? { message: input.message } : {}),
          });
          results.push({ email: row.email, ok: true, status: member.status });
        } catch (error) {
          const failure = error as { code?: string; message?: string };
          results.push({
            email: row.email,
            ok: false,
            error: {
              code: failure.code ?? 'INTERNAL_ERROR',
              message: failure.message ?? String(error),
            },
          });
        }
      }
      return {
        invited: results.filter((result) => result.ok).length,
        failed: results.filter((result) => !result.ok).length,
        results,
      };
    },
  }),
  invite: coreEndpoint({
    operation: operationMatrix['members.invite'],
    input: v.object({
      roomId: v.id(),
      email: emailSchema,
      groupIds: v.optional(v.array(v.id(), { max: 20 })),
      /** A direct room role; needs members:manage (and owner rights for `owner`). */
      relation: v.optional(relationSchema),
      message: v.optional(v.string({ max: 1000 })),
      accessDays: v.optional(v.number({ int: true, min: 1, max: 365 })),
    }),
    target: (input) => ({ roomId: input.roomId }),
    async handler(context, input) {
      const room = requireRoom(context);
      const dir = directory(context);
      const email = input.email.toLowerCase();
      if (input.relation)
        await requireAction(
          context,
          input.relation === 'owner' ? 'better-files:rooms:delete' : 'better-files:members:manage',
        );
      const groups = await Promise.all((input.groupIds ?? []).map((id) => loadGroup(context, id)));
      const expiresAt = input.accessDays ? context.now + input.accessDays * 86_400_000 : undefined;
      const identity = await dir.findIdentityByEmail({ email });
      let member: Member;
      if (identity) {
        for (const group of groups)
          await ignoreConflict(() =>
            dir.addGroupMember({
              groupId: group.iamGroupId,
              identityId: identity.id,
              ...(expiresAt ? { expiresAt } : {}),
            }),
          );
        const existing = await findMember(context, room.id, identity.id);
        let relation = existing?.status !== 'removed' ? existing?.relation : undefined;
        let relationshipId = existing?.status !== 'removed' ? existing?.relationshipId : undefined;
        // Without a group or role the person would hold nothing in the room: give them the viewer relation.
        const wanted = input.relation ?? (groups.length === 0 && !relation ? 'viewer' : undefined);
        if (wanted && wanted !== relation) {
          if (relationshipId) await dir.revokeRoomRole({ relationshipId });
          const grant = await dir.grantRoomRole({
            roomId: room.id,
            relation: wanted,
            subjectType: 'identity',
            subjectId: identity.id,
            ...(expiresAt ? { expiresAt } : {}),
          });
          relation = wanted;
          relationshipId = grant.id;
        }
        const groupIds = [
          ...new Set([
            ...(existing?.status === 'removed' ? [] : (existing?.groupIds ?? [])),
            ...groups.map((g) => g.id),
          ]),
        ];
        member = await upsertMember(context, room.id, identity.id, {
          email,
          status: 'active',
          groupIds,
          guest: identity.guest,
          invitedBy: context.principal.id,
          ...(relation ? { relation } : {}),
          ...(relationshipId ? { relationshipId } : {}),
          ...(expiresAt ? { expiresAt } : {}),
        });
      } else {
        // Someone outside the organization: a Better IAM guest, who joins the room's groups on redemption.
        if (groups.length === 0)
          throw invalidInput('Invite people from outside the organization into at least one group');
        if (input.relation) throw invalidInput('Grant a room role after the guest has joined');
        const pending = await context.db.findOne<Member>('members', {
          tenantId: context.tenantId,
          roomId: room.id,
          email,
        });
        if (pending && pending.status === 'invited')
          throw conflict('This person has already been invited');
        const { invitationId } = await dir.inviteGuest({
          email,
          groupIds: groups.map((group) => group.iamGroupId),
          ...(input.accessDays ? { accessDays: input.accessDays } : {}),
          ...(input.message ? { message: input.message } : {}),
          sponsorId: context.principal.id,
        });
        const fields = {
          status: 'invited' as const,
          groupIds: groups.map((group) => group.id),
          guest: true,
          invitationId,
          invitedBy: context.principal.id,
          ...(expiresAt ? { expiresAt } : {}),
          updatedAt: context.now,
        };
        if (pending) {
          await context.db.update(
            'members',
            { id: pending.id, tenantId: context.tenantId },
            fields,
          );
          member = { ...pending, ...fields };
        } else {
          member = {
            id: createId('member', context.now),
            tenantId: context.tenantId,
            roomId: room.id,
            email,
            createdAt: context.now,
            ...fields,
          };
          await context.db.insert('members', member);
        }
      }
      await context.activity({
        roomId: room.id,
        action: 'member.invited',
        metadata: {
          email,
          groups: groups.map((g) => g.name),
          ...(input.relation ? { relation: input.relation } : {}),
        },
      });
      context.emit('member.invited', {
        roomId: room.id,
        memberId: member.id,
        email,
        guest: member.guest,
      });
      auditSecurity(context, {
        action: 'better-files:member.invited',
        resource: { type: resourceTypes.room, id: room.id },
        metadata: { email, ...(input.relation ? { relation: input.relation } : {}) },
      });
      return memberView(member);
    },
  }),

  remove: coreEndpoint({
    operation: operationMatrix['members.remove'],
    input: v.object({ roomId: v.id(), memberId: v.id() }),
    target: (input) => ({ roomId: input.roomId }),
    async handler(context, input) {
      const room = requireRoom(context);
      const member = await context.db.findOne<Member>('members', {
        id: input.memberId,
        tenantId: context.tenantId,
        roomId: room.id,
      });
      if (!member || member.status === 'removed') throw notFound('Member');
      if (member.relation === 'owner') {
        const owners = await context.db.count('members', {
          tenantId: context.tenantId,
          roomId: room.id,
          relation: 'owner',
          status: 'active',
        });
        if (owners <= 1) throw new BetterFilesError('CONFLICT', 'A room keeps at least one owner');
      }
      await detach(context, member);
      await context.db.update(
        'members',
        { id: member.id, tenantId: context.tenantId },
        {
          status: 'removed',
          relation: null,
          relationshipId: null,
          groupIds: [],
          updatedAt: context.now,
        },
      );
      await context.activity({
        roomId: room.id,
        action: 'member.removed',
        metadata: { memberId: member.id, email: member.email ?? null },
      });
      context.emit('member.removed', { roomId: room.id, memberId: member.id });
      auditSecurity(context, {
        action: 'better-files:member.removed',
        resource: { type: resourceTypes.room, id: room.id },
        metadata: { memberId: member.id, identityId: member.identityId ?? null },
      });
      return { removed: true as const };
    },
  }),

  setRole: coreEndpoint({
    operation: operationMatrix['members.setRole'],
    input: v.object({ roomId: v.id(), memberId: v.id(), relation: v.nullable(relationSchema) }),
    target: (input) => ({ roomId: input.roomId }),
    async handler(context, input) {
      const room = requireRoom(context);
      const member = await context.db.findOne<Member>('members', {
        id: input.memberId,
        tenantId: context.tenantId,
        roomId: room.id,
      });
      if (!member || member.status !== 'active' || !member.identityId) throw notFound('Member');
      if (input.relation === 'owner' || member.relation === 'owner')
        await requireAction(context, 'better-files:rooms:delete');
      if (member.relation === 'owner' && input.relation !== 'owner') {
        const owners = await context.db.count('members', {
          tenantId: context.tenantId,
          roomId: room.id,
          relation: 'owner',
          status: 'active',
        });
        if (owners <= 1) throw new BetterFilesError('CONFLICT', 'A room keeps at least one owner');
      }
      const dir = directory(context);
      if (member.relationshipId)
        await dir.revokeRoomRole({ relationshipId: member.relationshipId });
      let relationshipId: string | null = null;
      if (input.relation)
        relationshipId = (
          await dir.grantRoomRole({
            roomId: room.id,
            relation: input.relation,
            subjectType: 'identity',
            subjectId: member.identityId,
          })
        ).id;
      await context.db.update(
        'members',
        { id: member.id, tenantId: context.tenantId },
        {
          relation: input.relation,
          relationshipId,
          updatedAt: context.now,
        },
      );
      await context.activity({
        roomId: room.id,
        action: 'member.role-changed',
        metadata: { memberId: member.id, from: member.relation ?? null, to: input.relation },
      });
      auditSecurity(context, {
        action: 'better-files:member.role-changed',
        resource: { type: resourceTypes.room, id: room.id },
        metadata: { memberId: member.id, from: member.relation ?? null, to: input.relation },
      });
      context.emit('member.role-changed', {
        roomId: room.id,
        memberId: member.id,
        relation: input.relation,
      });
      const updated = { ...member, updatedAt: context.now } as Member;
      if (input.relation) updated.relation = input.relation;
      else delete updated.relation;
      return memberView(updated);
    },
  }),

  suspend: coreEndpoint({
    operation: operationMatrix['members.suspend'],
    input: v.object({ roomId: v.id(), memberId: v.id() }),
    target: (input) => ({ roomId: input.roomId }),
    async handler(context, input) {
      const room = requireRoom(context);
      const member = await context.db.findOne<Member>('members', {
        id: input.memberId,
        tenantId: context.tenantId,
        roomId: room.id,
      });
      if (!member || member.status !== 'active') throw notFound('Member');
      if (member.relation === 'owner')
        throw new BetterFilesError('CONFLICT', 'Owners cannot be suspended');
      // Suspension keeps the roster entry (groups and role) so `resume` can restore exactly what was there.
      await detach(context, member);
      await context.db.update(
        'members',
        { id: member.id, tenantId: context.tenantId },
        { status: 'suspended', relationshipId: null, updatedAt: context.now },
      );
      await context.activity({
        roomId: room.id,
        action: 'member.suspended',
        metadata: { memberId: member.id },
      });
      auditSecurity(context, {
        action: 'better-files:member.suspended',
        resource: { type: resourceTypes.room, id: room.id },
        metadata: { memberId: member.id },
      });
      context.emit('member.suspended', { roomId: room.id, memberId: member.id });
      return { suspended: true as const };
    },
  }),

  resume: coreEndpoint({
    operation: operationMatrix['members.resume'],
    input: v.object({ roomId: v.id(), memberId: v.id() }),
    target: (input) => ({ roomId: input.roomId }),
    async handler(context, input) {
      const room = requireRoom(context);
      const member = await context.db.findOne<Member>('members', {
        id: input.memberId,
        tenantId: context.tenantId,
        roomId: room.id,
      });
      if (!member || member.status !== 'suspended' || !member.identityId) throw notFound('Member');
      const dir = directory(context);
      const groups = await roomGroups(context, room.id);
      for (const group of groups.filter((g) => member.groupIds.includes(g.id)))
        await ignoreConflict(() =>
          dir.addGroupMember({ groupId: group.iamGroupId, identityId: member.identityId! }),
        );
      let relationshipId: string | undefined;
      if (member.relation)
        relationshipId = (
          await dir.grantRoomRole({
            roomId: room.id,
            relation: member.relation,
            subjectType: 'identity',
            subjectId: member.identityId,
          })
        ).id;
      await context.db.update(
        'members',
        { id: member.id, tenantId: context.tenantId },
        {
          status: 'active',
          ...(relationshipId ? { relationshipId } : {}),
          updatedAt: context.now,
        },
      );
      await context.activity({
        roomId: room.id,
        action: 'member.resumed',
        metadata: { memberId: member.id },
      });
      context.emit('member.resumed', { roomId: room.id, memberId: member.id });
      return { resumed: true as const };
    },
  }),
};

/**
 * Takes a member out of the room in the identity system: its groups and its direct relation, or, for someone who has
 * not accepted yet, the invitation (which would otherwise still add them to the room's groups when redeemed).
 */
export async function detach(context: CoreContext, member: Member) {
  const dir = directory(context);
  const room = requireRoom(context);
  if (member.status === 'invited' || !member.identityId) {
    if (member.invitationId && context.engine.iam.directory?.revokeInvitation)
      await dir.revokeInvitation({ invitationId: member.invitationId });
    return;
  }
  const groups = await roomGroups(context, room.id);
  for (const group of groups.filter((g) => member.groupIds.includes(g.id)))
    await dir.removeGroupMember({ groupId: group.iamGroupId, identityId: member.identityId });
  if (member.relationshipId) await dir.revokeRoomRole({ relationshipId: member.relationshipId });
}

export const groupEndpoints = {
  list: coreEndpoint({
    operation: operationMatrix['groups.list'],
    input: v.object({ roomId: v.id() }),
    target: (input) => ({ roomId: input.roomId }),
    async handler(context) {
      const room = requireRoom(context);
      const [groups, members] = await Promise.all([
        roomGroups(context, room.id),
        context.db.findMany<Member>('members', {
          where: { tenantId: context.tenantId, roomId: room.id, status: { ne: 'removed' } },
        }),
      ]);
      return groups.map((group) =>
        groupView(group, members.filter((m) => m.groupIds.includes(group.id)).length),
      );
    },
  }),

  create: coreEndpoint({
    operation: operationMatrix['groups.create'],
    transaction: 'manual',
    input: v.object({
      roomId: v.id(),
      name: v.string({ min: 1, max: 120, trim: true }),
      description: v.optional(v.string({ max: 500 })),
      kind: v.optional(v.enum(['internal', 'external', 'auditor'] as const)),
      relation: v.optional(v.enum(groupRelations)),
      /** Grant a preset on the whole room right away (for example `view`). */
      preset: v.optional(v.string({ max: 48 })),
      expiresAt: v.optional(v.number({ int: true, min: 0 })),
    }),
    target: (input) => ({ roomId: input.roomId }),
    async handler(context, input) {
      const room = requireRoom(context);
      const nameKey = input.name.toLocaleLowerCase('en-US');
      if (
        await context.db.findOne('permissionGroups', {
          tenantId: context.tenantId,
          roomId: room.id,
          nameKey,
        })
      )
        throw conflict('A group with this name already exists in the room');
      const mask =
        input.preset === undefined ? undefined : context.capabilities.preset(input.preset);
      if (mask !== undefined) await assertCeiling(context, room.rootNodeId, mask);
      const dir = directory(context);
      const relation = input.relation ?? (input.kind === 'auditor' ? 'auditor' : 'viewer');
      const iamGroup = await dir.createGroup({
        name: `${room.name} · ${input.name}`.slice(0, 250),
        description: `Data room group for ${room.name}`,
      });
      try {
        const grant = await dir.grantRoomRole({
          roomId: room.id,
          relation,
          subjectType: 'group',
          subjectId: iamGroup.id,
          ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
        });
        const group: PermissionGroup = {
          id: createId('group', context.now),
          tenantId: context.tenantId,
          roomId: room.id,
          name: input.name,
          nameKey,
          ...(input.description ? { description: input.description } : {}),
          iamGroupId: iamGroup.id,
          relation,
          relationshipId: grant.id,
          kind: input.kind ?? 'internal',
          ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
          createdAt: context.now,
        };
        await context.db.transaction(async (tx) => {
          const scoped = context.rebind(tx);
          await tx.insert('permissionGroups', group);
          if (mask !== undefined)
            await tx.insert('aclEntries', {
              id: createId('acl', context.now),
              tenantId: context.tenantId,
              roomId: room.id,
              nodeId: room.rootNodeId,
              subjectType: 'group',
              subjectId: iamGroup.id,
              mask,
              locked: false,
              grantedBy: context.principal.id,
              createdAt: context.now,
            } satisfies AclEntry);
          await scoped.activity({
            roomId: room.id,
            action: 'group.created',
            metadata: { name: group.name, relation, preset: input.preset ?? null },
          });
        });
        context.emit('group.created', { roomId: room.id, groupId: group.id, name: group.name });
        return groupView(group, 0);
      } catch (error) {
        await dir.deleteGroup({ groupId: iamGroup.id }).catch(() => undefined);
        throw error;
      }
    },
  }),

  update: coreEndpoint({
    operation: operationMatrix['groups.update'],
    input: v.object({
      groupId: v.id(),
      name: v.optional(v.string({ min: 1, max: 120, trim: true })),
      description: v.optional(v.nullable(v.string({ max: 500 }))),
      relation: v.optional(v.enum(groupRelations)),
    }),
    target: groupTarget,
    async handler(context, input) {
      const room = requireRoom(context);
      const group = await loadGroup(context, input.groupId);
      const patch: Record<string, unknown> = {};
      if (input.name && input.name !== group.name) {
        const nameKey = input.name.toLocaleLowerCase('en-US');
        if (
          await context.db.findOne('permissionGroups', {
            tenantId: context.tenantId,
            roomId: room.id,
            nameKey,
            id: { ne: group.id },
          })
        )
          throw conflict('A group with this name already exists in the room');
        Object.assign(patch, { name: input.name, nameKey });
      }
      if (input.description !== undefined) patch.description = input.description;
      if (input.relation && input.relation !== group.relation) {
        const dir = directory(context);
        if (group.relationshipId)
          await dir.revokeRoomRole({ relationshipId: group.relationshipId });
        const grant = await dir.grantRoomRole({
          roomId: room.id,
          relation: input.relation,
          subjectType: 'group',
          subjectId: group.iamGroupId,
        });
        Object.assign(patch, { relation: input.relation, relationshipId: grant.id });
      }
      if (Object.keys(patch).length) {
        await context.db.update(
          'permissionGroups',
          { id: group.id, tenantId: context.tenantId },
          patch,
        );
        await context.activity({
          roomId: room.id,
          action: 'group.updated',
          metadata: { groupId: group.id, fields: Object.keys(patch) },
        });
      }
      const updated = { ...group, ...patch } as PermissionGroup;
      if (updated.description === null) delete updated.description;
      return groupView(updated);
    },
  }),

  delete: coreEndpoint({
    operation: operationMatrix['groups.delete'],
    transaction: 'manual',
    input: v.object({ groupId: v.id() }),
    target: groupTarget,
    async handler(context, input) {
      const room = requireRoom(context);
      const group = await loadGroup(context, input.groupId);
      // Deleting the identity-system group removes its memberships and its relation on the room.
      await directory(context).deleteGroup({ groupId: group.iamGroupId });
      await context.db.transaction(async (tx) => {
        await tx.delete('aclEntries', {
          tenantId: context.tenantId,
          roomId: room.id,
          subjectType: 'group',
          subjectId: group.iamGroupId,
        });
        for (const member of await tx.findMany<Member>('members', {
          where: { tenantId: context.tenantId, roomId: room.id },
        }))
          if (member.groupIds.includes(group.id))
            await tx.update(
              'members',
              { id: member.id, tenantId: context.tenantId },
              { groupIds: member.groupIds.filter((id) => id !== group.id) },
            );
        await tx.delete('permissionGroups', { tenantId: context.tenantId, id: group.id });
        await context
          .rebind(tx)
          .activity({ roomId: room.id, action: 'group.deleted', metadata: { name: group.name } });
      });
      context.emit('group.deleted', { roomId: room.id, groupId: group.id });
      return { deleted: true as const };
    },
  }),

  addMembers: coreEndpoint({
    operation: operationMatrix['groups.addMembers'],
    input: v.object({
      groupId: v.id(),
      identityIds: v.array(v.id(), { min: 1, max: 100 }),
      expiresAt: v.optional(v.number({ int: true, min: 0 })),
    }),
    target: groupTarget,
    async handler(context, input) {
      const room = requireRoom(context);
      const group = await loadGroup(context, input.groupId);
      const dir = directory(context);
      const added: string[] = [];
      for (const identityId of new Set(input.identityIds)) {
        await ignoreConflict(() =>
          dir.addGroupMember({
            groupId: group.iamGroupId,
            identityId,
            ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
          }),
        );
        const existing = await findMember(context, room.id, identityId);
        const groupIds = [
          ...new Set([
            ...(existing?.status === 'removed' ? [] : (existing?.groupIds ?? [])),
            group.id,
          ]),
        ];
        await upsertMember(context, room.id, identityId, {
          status: 'active',
          groupIds,
          invitedBy: context.principal.id,
        });
        added.push(identityId);
      }
      await context.activity({
        roomId: room.id,
        action: 'group.members-added',
        metadata: { groupId: group.id, identityIds: added },
      });
      context.emit('group.members-added', {
        roomId: room.id,
        groupId: group.id,
        identityIds: added,
      });
      return { added };
    },
  }),

  removeMembers: coreEndpoint({
    operation: operationMatrix['groups.removeMembers'],
    input: v.object({ groupId: v.id(), identityIds: v.array(v.id(), { min: 1, max: 100 }) }),
    target: groupTarget,
    async handler(context, input) {
      const room = requireRoom(context);
      const group = await loadGroup(context, input.groupId);
      const dir = directory(context);
      for (const identityId of new Set(input.identityIds)) {
        await dir.removeGroupMember({ groupId: group.iamGroupId, identityId });
        const member = await findMember(context, room.id, identityId);
        if (member)
          await context.db.update(
            'members',
            { id: member.id, tenantId: context.tenantId },
            {
              groupIds: member.groupIds.filter((id) => id !== group.id),
              updatedAt: context.now,
            },
          );
      }
      await context.activity({
        roomId: room.id,
        action: 'group.members-removed',
        metadata: { groupId: group.id, identityIds: input.identityIds },
      });
      context.emit('group.members-removed', {
        roomId: room.id,
        groupId: group.id,
        identityIds: input.identityIds,
      });
      return { removed: input.identityIds.length };
    },
  }),
};

/** A manager may grant at most what they hold on that node. */
export async function assertCeiling(context: CoreContext, nodeId: string, mask: number) {
  const node = await context.db.findOne<DataRoomNode>('nodes', {
    id: nodeId,
    tenantId: context.tenantId,
  });
  if (!node) throw notFound('Node');
  const held = (await context.capabilitiesOf([node])).get(node.id) ?? 0;
  if ((mask & ~held) !== 0)
    throw new BetterFilesError(
      'FORBIDDEN',
      'You cannot grant capabilities you do not hold yourself',
    );
}
