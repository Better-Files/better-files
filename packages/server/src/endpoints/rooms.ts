import {
  conflict,
  createId,
  BetterFilesError,
  invalidInput,
  operationMatrix,
  prefixedId,
  resourceTypes,
  v,
  Capability,
  type BlobRecord,
  type DataRoomDocument,
  type DataRoomNode,
  type DocumentVersion,
  type RoomExport,
  type Member,
  type PermissionGroup,
  type Room,
  type RoomSettings,
} from '@better-files/core';
import { recordActivity } from '../activity.js';
import { assertNotRetained, auditSecurity, directory, type CoreContext } from '../engine.js';
import { createNode, numberTree } from '../tree.js';
import {
  additionalFields,
  coreEndpoint,
  fieldsSchema,
  requireRoom,
  roomView,
  settingsSchema,
  slugify,
  visibleViews,
} from './common.js';

/** The room attributes the identity system's policies see (`resource.status`, `resource.classification`, …). */
export function iamAttributes(room: Pick<Room, 'status' | 'settings'>) {
  const settings: RoomSettings = room.settings;
  return {
    status: room.status === 'provisioning' ? 'draft' : room.status,
    classification: settings.classification ?? 'none',
    requireMfa: settings.requireMfaForDownload === true,
    downloadsEnabled: settings.downloadsEnabled !== false,
  };
}

const transitions: Record<
  string,
  { from: readonly Room['status'][]; to: Room['status']; event: string }
> = {
  publish: { from: ['draft'], to: 'live', event: 'room.published' },
  close: { from: ['live'], to: 'closed', event: 'room.closed' },
  reopen: { from: ['closed'], to: 'live', event: 'room.reopened' },
  archive: { from: ['closed', 'draft'], to: 'archived', event: 'room.archived' },
};

export async function transition(context: CoreContext, name: keyof typeof transitions) {
  const rule = transitions[name]!;
  const room = requireRoom(context);
  if (!rule.from.includes(room.status))
    throw new BetterFilesError(
      'CONFLICT',
      `A ${room.status} room cannot be ${rule.to === 'live' ? 'opened' : rule.to}`,
    );
  const now = context.now;
  // Opening a room again after its scheduled close drops the past date, or maintenance would close it again.
  const clearClose = rule.to === 'live' && room.closesAt !== undefined && room.closesAt <= now;
  await context.db.update(
    'rooms',
    { id: room.id, tenantId: room.tenantId },
    { status: rule.to, updatedAt: now, ...(clearClose ? { closesAt: null } : {}) },
  );
  const { closesAt: _closesAt, ...rest } = room;
  const updated = { ...(clearClose ? rest : room), status: rule.to, updatedAt: now };
  for (const hooks of context.engine.hooks)
    await hooks.onRoomStatusChange?.({ context, room: updated, from: room.status, to: rule.to });
  await context.activity({
    roomId: room.id,
    action: rule.event,
    metadata: { from: room.status, to: rule.to },
  });
  context.emit(rule.event, { roomId: room.id, from: room.status, to: rule.to });
  auditSecurity(context, {
    action: `better-files:${rule.event}`,
    resource: { type: resourceTypes.room, id: room.id },
    metadata: { from: room.status, to: rule.to },
  });
  context.afterCommit(() =>
    directory(context).updateRoom({ roomId: room.id, attributes: iamAttributes(updated) }),
  );
  return roomView(updated);
}

/**
 * The residency region a new room gets: the requested one, or the storage's default for the tenant. Refuses regions
 * the storage does not have or the tenant may not use. Undefined when the storage is not regional.
 */
async function roomRegion(context: CoreContext, requested: string | undefined) {
  const residency = context.engine.storage.residency;
  if (!residency) {
    if (requested)
      throw new BetterFilesError(
        'UNSUPPORTED',
        'Rooms can only be placed in a region with a regional storage adapter (regionalStorage)',
      );
    return undefined;
  }
  const { tenantId } = context;
  const region =
    requested ??
    (typeof residency.defaultRegion === 'string'
      ? residency.defaultRegion
      : await residency.defaultRegion({ tenantId }));
  if (!residency.regions.includes(region))
    throw invalidInput(`Unknown region "${region}"; available: ${residency.regions.join(', ')}`);
  if (residency.allows && !(await residency.allows({ tenantId, region })))
    throw new BetterFilesError(
      'FORBIDDEN',
      `This organization may not store rooms in region "${region}"`,
    );
  return region;
}

/** Removes every row a room owns, in core and plugin tables. */
async function deleteRoomRows(context: CoreContext, roomId: string) {
  const tables = Object.values(context.engine.schema.tables).filter(
    (table) => table.model !== 'rooms' && table.fields.roomId,
  );
  await context.db.transaction(async (tx) => {
    for (const table of tables)
      await tx.delete(table.model, { tenantId: context.tenantId, roomId });
    await tx.delete('rooms', { tenantId: context.tenantId, id: roomId });
  });
}

export const roomEndpoints = {
  create: coreEndpoint({
    operation: operationMatrix['rooms.create'],
    transaction: 'manual',
    input: v.object({
      name: v.string({ min: 1, max: 200, trim: true }),
      slug: v.optional(v.string({ min: 2, max: 64, pattern: /^[a-z0-9][a-z0-9-]*$/ })),
      description: v.optional(v.string({ max: 2000 })),
      settings: v.optional(settingsSchema),
      closesAt: v.optional(v.number({ int: true, min: 0 })),
      /** Data residency: where the room's files are stored. Needs a regional storage adapter. */
      region: v.optional(v.string({ min: 1, max: 32, pattern: /^[a-z0-9][a-z0-9-]*$/ })),
      fields: fieldsSchema,
    }),
    async handler(context, input) {
      const { tenantId, principal, now } = context;
      const extra = additionalFields(context, 'rooms', input.fields, { requireAll: true });
      const region = await roomRegion(context, input.region);
      let slug = input.slug ?? slugify(input.name);
      if (await context.db.findOne<Room>('rooms', { tenantId, slug })) {
        if (input.slug) throw conflict('A room with this slug already exists');
        slug = `${slug}-${createId('room', now).slice(-6).toLowerCase()}`;
      }
      const roomId = createId('room', now);
      const rootNodeId = createId('node', now);
      const room: Room = {
        id: roomId,
        tenantId,
        name: input.name,
        slug,
        ...(input.description ? { description: input.description } : {}),
        status: 'provisioning',
        ownerId: principal.id,
        rootNodeId,
        settings: input.settings ?? {},
        ...(input.closesAt ? { closesAt: input.closesAt } : {}),
        ...(region ? { region } : {}),
        activitySequence: 0,
        createdAt: now,
        updatedAt: now,
        ...extra,
      };
      const dir = directory(context);
      await context.db.transaction(async (tx) => {
        await tx.insert('rooms', room);
        await createNode(tx, {
          tenantId,
          roomId,
          parent: undefined,
          kind: 'folder',
          name: 'Index',
          createdBy: principal.id,
          now,
          id: rootNodeId,
        });
      });
      // The room exists only as `provisioning` until the identity system knows it; any failure undoes both sides.
      let registered = false;
      try {
        await dir.registerRoom({
          roomId,
          ownerId: principal.id,
          attributes: iamAttributes({ ...room, status: 'draft' }),
        });
        registered = true;
        const grant = await dir.grantRoomRole({
          roomId,
          relation: 'owner',
          subjectType: 'identity',
          subjectId: principal.id,
        });
        const kmsKeyId = await context.engine.keys?.createRoomKey?.({
          tenantId,
          roomId,
          ...(region ? { region } : {}),
        });
        await context.db.transaction(async (tx) => {
          await tx.update(
            'rooms',
            { id: roomId, tenantId },
            { status: 'draft', ...(kmsKeyId ? { kmsKeyId } : {}) },
          );
          await tx.insert('members', {
            id: createId('member', now),
            tenantId,
            roomId,
            identityId: principal.id,
            ...(principal.email ? { email: principal.email.toLowerCase() } : {}),
            status: 'active',
            relation: 'owner',
            relationshipId: grant.id,
            groupIds: [],
            guest: principal.guest,
            createdAt: now,
            updatedAt: now,
          } satisfies Member);
          await recordActivity(tx, {
            tenantId,
            roomId,
            actorId: principal.id,
            action: 'room.created',
            createdAt: now,
            metadata: { name: room.name },
          });
        });
      } catch (error) {
        await deleteRoomRows(context, roomId).catch(() => undefined);
        if (registered) await dir.deleteRoom({ roomId }).catch(() => undefined);
        throw error;
      }
      const created = { ...room, status: 'draft' as const };
      context.emit('room.created', { roomId, name: room.name });
      auditSecurity(context, {
        action: 'better-files:room.created',
        resource: { type: resourceTypes.room, id: roomId },
        metadata: { name: room.name },
      });
      return roomView(created);
    },
  }),

  list: coreEndpoint({
    operation: operationMatrix['rooms.list'],
    // People without any data room role simply have no rooms.
    denied: () => [],
    input: v.object({
      status: v.optional(v.enum(['draft', 'live', 'closed', 'archived'] as const)),
    }),
    async handler(context, input) {
      const { engine, tenantId, credential } = context;
      const accessible = engine.iam.authz.listAccessible
        ? await engine.iam.authz.listAccessible(credential, {
            tenantId,
            action: 'better-files:rooms:read',
            type: resourceTypes.room,
          })
        : undefined;
      const candidates = await context.db.findMany<Room>('rooms', {
        where: {
          tenantId,
          status: input.status ?? { ne: 'provisioning' },
          ...(accessible ? { id: { in: accessible } } : {}),
        },
        orderBy: [{ field: 'name' }],
        limit: 1000,
      });
      if (accessible) return candidates.map(roomView);
      const decisions = await engine.iam.authz.authorizeMany(credential, {
        tenantId,
        checks: candidates.map((room) => ({
          action: 'better-files:rooms:read',
          resource: { type: resourceTypes.room, id: room.id },
        })),
      });
      return candidates.filter((_, index) => decisions[index]?.allowed).map(roomView);
    },
  }),

  get: coreEndpoint({
    operation: operationMatrix['rooms.get'],
    input: v.object({ roomId: v.id() }),
    target: (input) => ({ roomId: input.roomId }),
    async handler(context) {
      const room = requireRoom(context);
      const root = await context.db.findOne<DataRoomNode>('nodes', {
        id: room.rootNodeId,
        tenantId: room.tenantId,
      });
      const masks = root ? await context.capabilitiesOf([root]) : new Map<string, number>();
      return {
        ...roomView(room),
        capabilities: context.capabilities.namesOf(masks.get(room.rootNodeId) ?? 0),
      };
    },
  }),

  index: coreEndpoint({
    operation: operationMatrix['rooms.index'],
    input: v.object({ roomId: v.id() }),
    target: (input) => ({ roomId: input.roomId }),
    async handler(context) {
      const room = requireRoom(context);
      const nodes = await context.db.findMany<DataRoomNode>('nodes', {
        where: { tenantId: room.tenantId, roomId: room.id, deletedAt: { isNull: true } },
      });
      const views = await visibleViews(context, nodes);
      const visible = new Map(views.map((view) => [view.id, view]));
      // A node shows only when every ancestor shows, so hidden folders hide their subtree.
      const shown = nodes.filter((node) => visible.has(node.id) && node.id !== room.rootNodeId);
      return numberTree(shown, room.rootNodeId).map(({ node, index, depth }) => ({
        ...visible.get(node.id)!,
        index,
        depth,
      }));
    },
  }),

  update: coreEndpoint({
    operation: operationMatrix['rooms.update'],
    input: v.object({
      roomId: v.id(),
      name: v.optional(v.string({ min: 1, max: 200, trim: true })),
      description: v.optional(v.nullable(v.string({ max: 2000 }))),
      settings: v.optional(settingsSchema),
      closesAt: v.optional(v.nullable(v.number({ int: true, min: 0 }))),
      fields: fieldsSchema,
    }),
    target: (input) => ({ roomId: input.roomId }),
    async handler(context, input) {
      const room = requireRoom(context);
      const settings = input.settings ? { ...room.settings, ...input.settings } : room.settings;
      const patch: Record<string, unknown> = {
        ...additionalFields(context, 'rooms', input.fields),
        ...(input.name ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.closesAt !== undefined ? { closesAt: input.closesAt } : {}),
        ...(input.settings ? { settings } : {}),
        updatedAt: context.now,
      };
      await context.db.update('rooms', { id: room.id, tenantId: room.tenantId }, patch);
      const updated = { ...room, ...patch, settings } as Room;
      for (const key of Object.keys(updated) as (keyof Room)[])
        if (updated[key] === null) delete updated[key];
      await context.activity({
        roomId: room.id,
        action: 'room.updated',
        metadata: { fields: Object.keys(patch).filter((key) => key !== 'updatedAt') },
      });
      if (input.settings) {
        auditSecurity(context, {
          action: 'better-files:room.settings-changed',
          resource: { type: resourceTypes.room, id: room.id },
          metadata: { settings: JSON.stringify(settings) },
        });
        context.afterCommit(() =>
          directory(context).updateRoom({ roomId: room.id, attributes: iamAttributes(updated) }),
        );
      }
      context.emit('room.updated', { roomId: room.id });
      return roomView(updated);
    },
  }),

  publish: coreEndpoint({
    operation: operationMatrix['rooms.publish'],
    input: v.object({ roomId: v.id() }),
    target: (input) => ({ roomId: input.roomId }),
    handler: (context) => transition(context, 'publish'),
  }),
  close: coreEndpoint({
    operation: operationMatrix['rooms.close'],
    input: v.object({ roomId: v.id() }),
    target: (input) => ({ roomId: input.roomId }),
    handler: (context) => transition(context, 'close'),
  }),
  reopen: coreEndpoint({
    operation: operationMatrix['rooms.reopen'],
    input: v.object({ roomId: v.id() }),
    target: (input) => ({ roomId: input.roomId }),
    handler: (context) => transition(context, 'reopen'),
  }),
  archive: coreEndpoint({
    operation: operationMatrix['rooms.archive'],
    input: v.object({ roomId: v.id() }),
    target: (input) => ({ roomId: input.roomId }),
    handler: (context) => transition(context, 'archive'),
  }),

  delete: coreEndpoint({
    operation: operationMatrix['rooms.delete'],
    transaction: 'manual',
    input: v.object({ roomId: v.id(), confirmName: v.string({ max: 200 }) }),
    target: (input) => ({ roomId: input.roomId }),
    async handler(context, input) {
      const room = requireRoom(context);
      if (room.status === 'live')
        throw new BetterFilesError('CONFLICT', 'Close the room before deleting it');
      if (input.confirmName !== room.name)
        throw invalidInput('confirmName must match the room name');
      await assertNotRetained(context.engine, context.db, {
        tenantId: room.tenantId,
        roomId: room.id,
      });
      for (const hooks of context.engine.hooks)
        await hooks.onRoomStatusChange?.({ context, room, from: room.status, to: 'archived' });
      const dir = directory(context);
      const groups = await context.db.findMany<PermissionGroup>('permissionGroups', {
        where: { tenantId: room.tenantId, roomId: room.id },
      });
      // Identity-system side first: once the room is gone there, nobody can reach it even if cleanup stops midway.
      for (const group of groups) await dir.deleteGroup({ groupId: group.iamGroupId });
      await dir.deleteRoom({ roomId: room.id });
      const blobs = await context.db.findMany<BlobRecord>('blobs', {
        where: { tenantId: room.tenantId, roomId: room.id },
      });
      await deleteRoomRows(context, room.id);
      for (const blob of blobs)
        await context.storage.delete(blob.storageKey).catch((error: unknown) =>
          context.logger.warn('Could not delete a stored file', {
            key: blob.storageKey,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      if (room.kmsKeyId)
        await context.engine.keys?.retireRoomKey?.({
          tenantId: room.tenantId,
          roomId: room.id,
          keyRef: room.kmsKeyId,
        });
      context.emit('room.deleted', { roomId: room.id, name: room.name });
      auditSecurity(context, {
        action: 'better-files:room.deleted',
        resource: { type: resourceTypes.room, id: room.id },
        metadata: { name: room.name, files: blobs.length },
      });
      return { deleted: true as const };
    },
  }),

  /**
   * An archive of the room as the caller may take it: every document they may download as an original (current
   * versions, in index order), an index, a manifest with checksums, and the activity log when they may export it.
   */
  export: coreEndpoint({
    operation: operationMatrix['rooms.export'],
    input: v.object({ roomId: v.id() }),
    target: (input) => ({ roomId: input.roomId }),
    async handler(context) {
      const room = requireRoom(context);
      const nodes = await context.db.findMany<DataRoomNode>('nodes', {
        where: { tenantId: room.tenantId, roomId: room.id, deletedAt: { isNull: true } },
      });
      const masks = await context.capabilitiesOf(nodes);
      const visible = nodes.filter(
        (node) =>
          node.id !== room.rootNodeId && ((masks.get(node.id) ?? 0) & Capability.LIST) !== 0,
      );
      const numbered = numberTree(visible, room.rootNodeId);
      const byId = new Map(numbered.map((entry) => [entry.node.id, entry]));
      const safe = (name: string) => name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
      const pathOf = (node: DataRoomNode): string => {
        const own = `${byId.get(node.id)!.index} ${safe(node.name)}`;
        const parent = node.parentId ? byId.get(node.parentId) : undefined;
        return parent ? `${pathOf(parent.node)}/${own}` : own;
      };
      const documents = numbered.filter((entry) => entry.node.kind === 'document');
      const exportable = documents.filter(
        (entry) => ((masks.get(entry.node.id) ?? 0) & Capability.DOWNLOAD_ORIGINAL) !== 0,
      );
      const rows = exportable.length
        ? await context.db.findMany<DataRoomDocument>('documents', {
            where: {
              tenantId: room.tenantId,
              id: { in: exportable.map((entry) => entry.node.id) },
            },
          })
        : [];
      const versionIds = rows.flatMap((row) =>
        row.currentVersionId ? [row.currentVersionId] : [],
      );
      const versions = versionIds.length
        ? await context.db.findMany<DocumentVersion>('versions', {
            where: { tenantId: room.tenantId, id: { in: versionIds }, status: 'ready' },
          })
        : [];
      const byDocument = new Map(versions.map((version) => [version.documentId, version]));
      const items = exportable.flatMap((entry) => {
        const version = byDocument.get(entry.node.id);
        return version
          ? [
              {
                path: pathOf(entry.node),
                versionId: version.id,
                size: version.size,
                ...(version.sha256 ? { sha256: version.sha256 } : {}),
              },
            ]
          : [];
      });
      const includeActivity = await context.authorize('better-files:activity:export');
      const record: RoomExport = {
        id: prefixedId('exp', context.now),
        tenantId: room.tenantId,
        roomId: room.id,
        principalId: context.principal.id,
        items,
        excluded: documents.length - items.length,
        includeActivity,
        expiresAt: context.now + 10 * 60_000,
        createdAt: context.now,
      };
      await context.db.transaction((tx) => tx.insert('exports', record));
      const ticket = await context.engine.files.issueExportTicket(context, record);
      await context.activity({
        roomId: room.id,
        action: 'room.exported',
        metadata: { files: items.length, excluded: record.excluded, activity: includeActivity },
      });
      auditSecurity(context, {
        action: 'better-files:room.exported',
        resource: { type: resourceTypes.room, id: room.id },
        metadata: { files: items.length, excluded: record.excluded },
      });
      context.emit('room.exported', { roomId: room.id, files: items.length });
      return {
        ...ticket,
        files: items.length,
        excluded: record.excluded,
        bytes: items.reduce((sum, item) => sum + item.size, 0),
      };
    },
  }),

  trash: coreEndpoint({
    operation: operationMatrix['rooms.trash'],
    input: v.object({ roomId: v.id() }),
    target: (input) => ({ roomId: input.roomId }),
    async handler(context) {
      const room = requireRoom(context);
      const deleted = await context.db.findMany<DataRoomNode>('nodes', {
        where: { tenantId: room.tenantId, roomId: room.id, deletedAt: { isNull: false } },
        orderBy: [{ field: 'deletedAt', direction: 'desc' }],
        limit: 1000,
      });
      const tops = deleted.filter((node) => node.deletedWith === node.id);
      const views = await visibleViews(context, tops);
      return views.filter((view) => view.capabilities?.includes('DELETE'));
    },
  }),
};
