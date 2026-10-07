import {
  createId,
  invalidInput,
  notFound,
  operationMatrix,
  resolvePathMasks,
  resourceTypes,
  subjectKey,
  v,
  type AccessEntry,
  type AclEntry,
  type ActivityRecord,
  type DataRoomNode,
  type NodeClosure,
  type PermissionGroup,
  type SubjectKey,
} from '@better-files/core';
import { verifyActivity } from '../activity.js';
import { documentClamps, roomClamps } from '../access.js';
import { auditSecurity, directory, type CoreContext } from '../engine.js';
import { pathTo } from '../tree.js';
import { coreEndpoint, requireNode, requireRoom } from './common.js';
import { assertCeiling } from './people.js';

const subjectSchema = v.object({
  type: v.enum(['group', 'identity'] as const),
  /** A permission group id (`grp_…`) or an identity id. */
  id: v.id(),
});

async function subjectFor(
  context: CoreContext,
  roomId: string,
  subject: { type: 'group' | 'identity'; id: string },
): Promise<{ subjectType: 'group' | 'identity'; subjectId: string; label: string }> {
  if (subject.type === 'identity')
    return { subjectType: 'identity', subjectId: subject.id, label: subject.id };
  const group = await context.db.findOne<PermissionGroup>('permissionGroups', {
    id: subject.id,
    tenantId: context.tenantId,
    roomId,
  });
  if (!group) throw notFound('Group');
  return { subjectType: 'group', subjectId: group.iamGroupId, label: group.name };
}

const entryView = (
  entry: AclEntry,
  context: CoreContext,
  groups: Map<string, PermissionGroup>,
) => ({
  id: entry.id,
  nodeId: entry.nodeId,
  subject:
    entry.subjectType === 'group'
      ? {
          type: 'group' as const,
          id: groups.get(entry.subjectId)?.id ?? entry.subjectId,
          name: groups.get(entry.subjectId)?.name ?? null,
        }
      : { type: entry.subjectType, id: entry.subjectId },
  capabilities: context.capabilities.namesOf(entry.mask),
  locked: entry.locked,
  ...(entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt }),
});

async function groupsByIamId(context: CoreContext, roomId: string) {
  const groups = await context.db.findMany<PermissionGroup>('permissionGroups', {
    where: { tenantId: context.tenantId, roomId },
  });
  return new Map(groups.map((group) => [group.iamGroupId, group]));
}

export const permissionEndpoints = {
  getMatrix: coreEndpoint({
    operation: operationMatrix['permissions.getMatrix'],
    input: v.object({ nodeId: v.id() }),
    target: (input) => ({ nodeId: input.nodeId }),
    async handler(context) {
      const node = requireNode(context);
      const room = requireRoom(context);
      // The node's ancestors and its subtree: everything that shapes access at or below it.
      const [path, below] = await Promise.all([
        pathTo(context.db, context.tenantId, node.id),
        context.db.findMany<NodeClosure>('nodeClosure', {
          where: { tenantId: context.tenantId, ancestorId: node.id },
        }),
      ]);
      const nodeIds = [...new Set([...path, ...below.map((row) => row.descendantId)])];
      const [entries, groups] = await Promise.all([
        context.db.findMany<AclEntry>('aclEntries', {
          where: { tenantId: context.tenantId, roomId: room.id, nodeId: { in: nodeIds } },
        }),
        groupsByIamId(context, room.id),
      ]);
      return {
        nodeId: node.id,
        path,
        groups: [...groups.values()].map((group) => ({
          id: group.id,
          name: group.name,
          kind: group.kind,
          relation: group.relation,
        })),
        entries: entries.map((entry) => entryView(entry, context, groups)),
        capabilities: [...context.capabilities.names],
        presets: Object.fromEntries(
          Object.entries(context.capabilities.presets).map(([name, mask]) => [
            name,
            context.capabilities.namesOf(mask),
          ]),
        ),
      };
    },
  }),

  setEntries: coreEndpoint({
    operation: operationMatrix['permissions.setEntries'],
    input: v.object({
      nodeId: v.id(),
      entries: v.array(
        v.object({
          subject: subjectSchema,
          /** A preset name (`view`, `download`, …) or an explicit capability list; neither with `remove`. */
          preset: v.optional(v.string({ max: 48 })),
          capabilities: v.optional(v.array(v.string({ max: 48 }), { max: 32 })),
          locked: v.optional(v.boolean()),
          expiresAt: v.optional(v.nullable(v.number({ int: true, min: 0 }))),
          remove: v.optional(v.boolean()),
        }),
        { min: 1, max: 100 },
      ),
    }),
    target: (input) => ({ nodeId: input.nodeId }),
    async handler(context, input) {
      const node = requireNode(context);
      const room = requireRoom(context);
      for (const hooks of context.engine.hooks)
        await hooks.beforePermissionChange?.({ context, room, node, changes: input.entries });
      const changes: Record<string, unknown>[] = [];
      for (const change of input.entries) {
        const subject = await subjectFor(context, room.id, change.subject);
        const where = {
          tenantId: context.tenantId,
          nodeId: node.id,
          subjectType: subject.subjectType,
          subjectId: subject.subjectId,
        };
        const existing = await context.db.findOne<AclEntry>('aclEntries', where);
        if (change.remove) {
          if (existing)
            await context.db.delete('aclEntries', { id: existing.id, tenantId: context.tenantId });
          changes.push({ subject: subject.label, removed: true });
          continue;
        }
        if ((change.preset === undefined) === (change.capabilities === undefined))
          throw invalidInput('Give either a preset or a capability list for each entry');
        const mask =
          change.preset !== undefined
            ? context.capabilities.preset(change.preset)
            : context.capabilities.mask(change.capabilities!);
        await assertCeiling(context, node.id, mask);
        const values = {
          mask,
          locked: change.locked ?? existing?.locked ?? false,
          expiresAt:
            change.expiresAt === undefined ? (existing?.expiresAt ?? null) : change.expiresAt,
          grantedBy: context.principal.id,
        };
        if (existing)
          await context.db.update(
            'aclEntries',
            { id: existing.id, tenantId: context.tenantId },
            values,
          );
        else
          await context.db.insert('aclEntries', {
            id: createId('acl', context.now),
            ...where,
            roomId: room.id,
            createdAt: context.now,
            mask,
            locked: values.locked,
            grantedBy: values.grantedBy,
            ...(values.expiresAt === null ? {} : { expiresAt: values.expiresAt }),
          } satisfies AclEntry);
        changes.push({
          subject: subject.label,
          capabilities: context.capabilities.namesOf(mask),
          locked: values.locked,
        });
      }
      await context.activity({
        roomId: room.id,
        action: 'permissions.changed',
        nodeId: node.id,
        metadata: { changes },
      });
      auditSecurity(context, {
        action: 'better-files:permissions.changed',
        resource: {
          type: node.kind === 'folder' ? resourceTypes.folder : resourceTypes.document,
          id: node.id,
        },
        metadata: { roomId: room.id, changes: JSON.stringify(changes).slice(0, 2000) },
      });
      context.emit('permissions.changed', { nodeId: node.id, changes });
      return { changed: changes.length };
    },
  }),

  explain: coreEndpoint({
    operation: operationMatrix['permissions.explain'],
    input: v.object({ nodeId: v.id(), identityId: v.optional(v.id()) }),
    target: (input) => ({ nodeId: input.nodeId }),
    async handler(context, input) {
      const node = requireNode(context);
      const room = requireRoom(context);
      const forCaller = input.identityId === undefined || input.identityId === context.principal.id;
      const identityId = input.identityId ?? context.principal.id;
      const groupIds = forCaller
        ? [...context.principal.groups]
        : await directory(context).groupsOf({ identityId });
      const subjects: SubjectKey[] = [
        subjectKey('identity', identityId),
        ...groupIds.map((id) => subjectKey('group', id)),
      ];
      const path = await pathTo(context.db, context.tenantId, node.id);
      const [nodes, entries, groups] = await Promise.all([
        context.db.findMany<DataRoomNode>('nodes', {
          where: { tenantId: context.tenantId, id: { in: path } },
        }),
        context.db.findMany<AclEntry>('aclEntries', {
          where: { tenantId: context.tenantId, roomId: room.id, nodeId: { in: path } },
        }),
        groupsByIamId(context, room.id),
      ]);
      const relevant = entries.filter((entry) =>
        subjects.includes(subjectKey(entry.subjectType, entry.subjectId)),
      );
      const accessEntries: AccessEntry[] = relevant.map((entry) => ({
        nodeId: entry.nodeId,
        subject: subjectKey(entry.subjectType, entry.subjectId),
        mask: entry.mask,
        locked: entry.locked,
        ...(entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt }),
      }));
      const masks = resolvePathMasks({ path, entries: accessEntries, subjects, now: context.now });
      const names = new Map(nodes.map((n) => [n.id, n.name]));
      const document =
        node.kind === 'document'
          ? await context.db.findOne<import('@better-files/core').DataRoomDocument>('documents', {
              id: node.id,
              tenantId: context.tenantId,
            })
          : null;
      const clamps = [...roomClamps(room), ...documentClamps(document ?? undefined)];
      const effective = forCaller
        ? ((await context.capabilitiesOf([node])).get(node.id) ?? 0)
        : undefined;
      return {
        identityId,
        groups: groupIds.map((id) => ({ iamGroupId: id, group: groups.get(id)?.name ?? null })),
        path: path.map((id, depth) => ({
          nodeId: id,
          name: names.get(id) ?? null,
          matrix: context.capabilities.namesOf(masks[depth] ?? 0),
          entries: relevant
            .filter((entry) => entry.nodeId === id)
            .map((entry) => entryView(entry, context, groups)),
        })),
        clamps: clamps.map((clamp) => ({
          reason: clamp.reason,
          removes: context.capabilities.namesOf(clamp.remove),
        })),
        /** The caller's effective capabilities, including room-role floors and plugin clamps (not computed for others). */
        ...(effective === undefined ? {} : { effective: context.capabilities.namesOf(effective) }),
      };
    },
  }),

  capabilities: coreEndpoint({
    operation: operationMatrix['permissions.capabilities'],
    input: v.object({ roomId: v.id(), nodeIds: v.array(v.id(), { min: 1, max: 500 }) }),
    target: (input) => ({ roomId: input.roomId }),
    async handler(context, input) {
      const room = requireRoom(context);
      const nodes = await context.db.findMany<DataRoomNode>('nodes', {
        where: {
          tenantId: context.tenantId,
          roomId: room.id,
          id: { in: input.nodeIds },
          deletedAt: { isNull: true },
        },
      });
      const masks = await context.capabilitiesOf(nodes);
      return Object.fromEntries(
        nodes.map((n) => [n.id, context.capabilities.namesOf(masks.get(n.id) ?? 0)]),
      );
    },
  }),
};

export const activityEndpoints = {
  list: coreEndpoint({
    operation: operationMatrix['activity.list'],
    input: v.object({
      roomId: v.id(),
      /** Only records before this sequence number (paging backwards from the newest). */
      before: v.optional(v.number({ int: true, min: 1 })),
      limit: v.optional(v.number({ int: true, min: 1, max: 500 })),
      nodeId: v.optional(v.id()),
      actorId: v.optional(v.id()),
    }),
    target: (input) => ({ roomId: input.roomId }),
    async handler(context, input) {
      const room = requireRoom(context);
      const records = await context.db.findMany<ActivityRecord>('activity', {
        where: {
          tenantId: context.tenantId,
          roomId: room.id,
          ...(input.before ? { sequence: { lt: input.before } } : {}),
          ...(input.nodeId ? { nodeId: input.nodeId } : {}),
          ...(input.actorId ? { actorId: input.actorId } : {}),
        },
        orderBy: [{ field: 'sequence', direction: 'desc' }],
        limit: input.limit ?? 100,
      });
      return records.map(({ tenantId: _tenant, ...record }) => record);
    },
  }),
  verify: coreEndpoint({
    operation: operationMatrix['activity.verify'],
    input: v.object({ roomId: v.id() }),
    target: (input) => ({ roomId: input.roomId }),
    handler: (context) => verifyActivity(context.db, context.tenantId, requireRoom(context).id),
  }),
};
