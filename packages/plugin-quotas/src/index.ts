import {
  BetterFilesError,
  defineTable,
  definePlugin,
  endpoint,
  field,
  notFound,
  prefixedId,
  v,
  type DatabaseAdapter,
  type DocumentVersion,
  type PluginContext,
  type Room,
} from '@better-files/core';

export * from './better-iam.js';

export interface QuotaLimits {
  /** Stored bytes, all versions included (files in the trash count until purged). */
  maxBytes?: number;
  maxDocuments?: number;
  /** Largest single file. */
  maxFileBytes?: number;
}

export interface QuotasOptions {
  /** Limits for every room unless an administrator sets the room's own. */
  room?: QuotaLimits;
  /** A tenant's limits, typically from its billing plan. Called on each upload; cache it if it is slow. */
  tenant?: (tenantId: string) => QuotaLimits | undefined | Promise<QuotaLimits | undefined>;
  /** Share of a limit at which `quota.warning` is published once. Default 0.8. */
  warnAt?: number;
  /** Rooms whose usage `dr.maintain()` recounts per run (usage drifts when the trash is purged). Default 25. */
  recountPerRun?: number;
}

export interface QuotaUsage {
  bytes: number;
  documents: number;
  versions: number;
}

interface UsageRecord extends QuotaUsage {
  id: string;
  tenantId: string;
  scope: 'room' | 'tenant';
  scopeId: string;
  recountedAt?: number;
  createdAt: number;
}

interface LimitRecord extends QuotaLimits {
  id: string;
  tenantId: string;
  roomId: string;
  updatedBy: string;
  createdAt: number;
}

const MANAGE = 'better-files:quotas:manage';
const empty: QuotaUsage = { bytes: 0, documents: 0, versions: 0 };
const limitSchema = v.optional(v.nullable(v.number({ int: true, min: 0 })));

async function usageOf(
  db: DatabaseAdapter,
  tenantId: string,
  scope: 'room' | 'tenant',
  scopeId: string,
): Promise<QuotaUsage> {
  const row = await db.findOne<UsageRecord>('quotaUsage', { tenantId, scope, scopeId });
  return row
    ? { bytes: row.bytes, documents: row.documents, versions: row.versions }
    : { ...empty };
}

/** Adds to a usage counter, creating it on first use. Runs inside the caller's transaction. */
async function add(
  db: DatabaseAdapter,
  tenantId: string,
  scope: 'room' | 'tenant',
  scopeId: string,
  delta: QuotaUsage,
) {
  const where = { tenantId, scope, scopeId };
  if (!(await db.findOne('quotaUsage', where)))
    await db.insert('quotaUsage', {
      id: prefixedId('quse'),
      ...where,
      ...empty,
      createdAt: Date.now(),
    });
  if (delta.bytes) await db.increment('quotaUsage', where, 'bytes', delta.bytes);
  if (delta.documents) await db.increment('quotaUsage', where, 'documents', delta.documents);
  if (delta.versions) await db.increment('quotaUsage', where, 'versions', delta.versions);
}

async function loadRoom(context: PluginContext, roomId: string): Promise<Room> {
  const room = await context.db.findOne<Room>('rooms', { id: roomId, tenantId: context.tenantId });
  if (!room) throw notFound('Room');
  return room;
}

const exceeds = (
  usage: QuotaUsage,
  limits: QuotaLimits,
  extra: { bytes: number; documents: number },
) =>
  (limits.maxBytes !== undefined && usage.bytes + extra.bytes > limits.maxBytes) ||
  (limits.maxDocuments !== undefined && usage.documents + extra.documents > limits.maxDocuments);

const clean = (limits: QuotaLimits | undefined): QuotaLimits =>
  Object.fromEntries(
    Object.entries(limits ?? {}).filter(([, value]) => value !== undefined && value !== null),
  ) as QuotaLimits;

/**
 * Storage quotas: bytes, documents and file size per room (a default, or set per room by tenant administrators)
 * and per tenant (from your plan). Uploads are refused with `QUOTA_EXCEEDED` when their session is created, before
 * any bytes move. Usage counters move with each stored version in the same transaction, and `dr.maintain()`
 * recounts rooms so purged trash is given back.
 */
export function quotasPlugin(options: QuotasOptions = {}) {
  const warnAt = options.warnAt ?? 0.8;

  async function roomLimits(
    db: DatabaseAdapter,
    tenantId: string,
    roomId: string,
  ): Promise<QuotaLimits> {
    const own = await db.findOne<LimitRecord>('quotaLimits', { tenantId, roomId });
    return { ...clean(options.room), ...clean(own ?? undefined) };
  }

  async function recount(
    db: DatabaseAdapter,
    tenantId: string,
    roomId: string,
  ): Promise<QuotaUsage> {
    const versions = await db.findMany<DocumentVersion>('versions', {
      where: { tenantId, roomId },
    });
    const documents = await db.count('documents', { tenantId, roomId });
    const usage = {
      bytes: versions.reduce((sum, version) => sum + version.size, 0),
      documents,
      versions: versions.length,
    };
    await db.transaction(async (tx) => {
      const where = { tenantId, scope: 'room' as const, scopeId: roomId };
      const row = await tx.findOne<UsageRecord>('quotaUsage', where);
      if (row)
        await tx.update(
          'quotaUsage',
          { id: row.id, tenantId },
          { ...usage, recountedAt: Date.now() },
        );
      else
        await tx.insert('quotaUsage', {
          id: prefixedId('quse'),
          ...where,
          ...usage,
          recountedAt: Date.now(),
          createdAt: Date.now(),
        });
      // The tenant total is the sum of its rooms.
      const rooms = await tx.findMany<UsageRecord>('quotaUsage', {
        where: { tenantId, scope: 'room' },
      });
      const total = rooms.reduce(
        (sum, room) => ({
          bytes: sum.bytes + room.bytes,
          documents: sum.documents + room.documents,
          versions: sum.versions + room.versions,
        }),
        { ...empty },
      );
      const tenantWhere = { tenantId, scope: 'tenant' as const, scopeId: tenantId };
      const tenantRow = await tx.findOne<UsageRecord>('quotaUsage', tenantWhere);
      if (tenantRow)
        await tx.update(
          'quotaUsage',
          { id: tenantRow.id, tenantId },
          { ...total, recountedAt: Date.now() },
        );
      else
        await tx.insert('quotaUsage', {
          id: prefixedId('quse'),
          ...tenantWhere,
          ...total,
          recountedAt: Date.now(),
          createdAt: Date.now(),
        });
    });
    return usage;
  }

  const report = (usage: QuotaUsage, limits: QuotaLimits) => ({
    ...usage,
    limits,
    ratio: {
      ...(limits.maxBytes ? { bytes: usage.bytes / limits.maxBytes } : {}),
      ...(limits.maxDocuments ? { documents: usage.documents / limits.maxDocuments } : {}),
    },
  });

  function warn(
    context: PluginContext,
    room: Room,
    scope: 'room' | 'tenant',
    before: QuotaUsage,
    after: QuotaUsage,
    limits: QuotaLimits,
  ) {
    for (const [kind, limit] of [
      ['bytes', limits.maxBytes],
      ['documents', limits.maxDocuments],
    ] as const)
      if (limit && before[kind] < limit * warnAt && after[kind] >= limit * warnAt)
        context.emit('quota.warning', { scope, roomId: room.id, kind, used: after[kind], limit });
  }

  return definePlugin({
    id: 'quotas',
    actions: [MANAGE],
    schema: {
      quotaUsage: defineTable({
        fields: {
          scope: field.enum(['room', 'tenant'] as const),
          scopeId: field.string(),
          bytes: field.number(),
          documents: field.number(),
          versions: field.number(),
          recountedAt: field.timestamp({ required: false }),
        },
        indexes: [{ fields: ['tenantId', 'scope', 'scopeId'], unique: true }],
      }),
      quotaLimits: defineTable({
        fields: {
          roomId: field.string(),
          maxBytes: field.number({ required: false }),
          maxDocuments: field.number({ required: false }),
          maxFileBytes: field.number({ required: false }),
          updatedBy: field.string(),
        },
        indexes: [{ fields: ['tenantId', 'roomId'], unique: true }],
      }),
    },
    hooks: {
      async beforeUpload({ context, room, node, size }) {
        const newDocument = node?.kind !== 'document';
        const extra = { bytes: size, documents: newDocument ? 1 : 0 };
        const limits = await roomLimits(context.db, context.tenantId, room.id);
        const tenantLimits = clean(await options.tenant?.(context.tenantId));
        const maxFile = Math.min(
          limits.maxFileBytes ?? Infinity,
          tenantLimits.maxFileBytes ?? Infinity,
        );
        const refuse = (message: string, details: Record<string, unknown>) => {
          context.emit('quota.exceeded', { roomId: room.id, ...details }, { immediate: true });
          throw new BetterFilesError('QUOTA_EXCEEDED', message, { details });
        };
        if (size > maxFile)
          refuse(`Files in this room are limited to ${maxFile} bytes`, {
            scope: 'file',
            limit: maxFile,
            size,
          });
        if (exceeds(await usageOf(context.db, context.tenantId, 'room', room.id), limits, extra))
          refuse('This room is out of storage', { scope: 'room', limits });
        if (
          exceeds(
            await usageOf(context.db, context.tenantId, 'tenant', context.tenantId),
            tenantLimits,
            extra,
          )
        )
          refuse('Your organization is out of storage', { scope: 'tenant', limits: tenantLimits });
      },
      async afterUpload({ context, room, versionId }) {
        const version = await context.db.findOne<DocumentVersion>('versions', {
          id: versionId,
          tenantId: context.tenantId,
        });
        if (!version) return;
        const delta = { bytes: version.size, documents: version.number === 1 ? 1 : 0, versions: 1 };
        const beforeRoom = await usageOf(context.db, context.tenantId, 'room', room.id);
        const beforeTenant = await usageOf(
          context.db,
          context.tenantId,
          'tenant',
          context.tenantId,
        );
        await add(context.db, context.tenantId, 'room', room.id, delta);
        await add(context.db, context.tenantId, 'tenant', context.tenantId, delta);
        const plus = (usage: QuotaUsage) => ({
          bytes: usage.bytes + delta.bytes,
          documents: usage.documents + delta.documents,
          versions: usage.versions + delta.versions,
        });
        warn(
          context,
          room,
          'room',
          beforeRoom,
          plus(beforeRoom),
          await roomLimits(context.db, context.tenantId, room.id),
        );
        warn(
          context,
          room,
          'tenant',
          beforeTenant,
          plus(beforeTenant),
          clean(await options.tenant?.(context.tenantId)),
        );
      },
    },
    async maintain(context) {
      // Recount the rooms counted longest ago: purged trash and deleted rooms give their space back.
      const stale = await context.db.findMany<UsageRecord>('quotaUsage', {
        where: { scope: 'room' },
        orderBy: [{ field: 'recountedAt' }],
        limit: options.recountPerRun ?? 25,
      });
      for (const row of stale) {
        const room = await context.db.findOne<Room>('rooms', {
          id: row.scopeId,
          tenantId: row.tenantId,
        });
        if (room) await recount(context.db, row.tenantId, room.id);
        else
          await context.db.transaction(async (tx) => {
            await tx.delete('quotaUsage', { id: row.id, tenantId: row.tenantId });
            await tx.delete('quotaLimits', { tenantId: row.tenantId, roomId: row.scopeId });
          });
      }
    },
    endpoints: {
      /** A room's usage against its limits; any member may see it. */
      room: endpoint({
        operation: {
          action: 'better-files:rooms:read',
          target: 'room',
          mutates: false,
          allowClosed: true,
        },
        input: v.object({ roomId: v.id() }),
        target: (input) => ({ roomId: input.roomId }),
        async handler(context) {
          const room = context.room!;
          return report(
            await usageOf(context.db, context.tenantId, 'room', room.id),
            await roomLimits(context.db, context.tenantId, room.id),
          );
        },
      }),
      tenant: endpoint({
        operation: { action: MANAGE, target: 'tenant', mutates: false },
        input: v.object({}),
        async handler(context) {
          return report(
            await usageOf(context.db, context.tenantId, 'tenant', context.tenantId),
            clean(await options.tenant?.(context.tenantId)),
          );
        },
      }),
      /**
       * Sets a room's own limits (`null` clears one, falling back to the default). Authorized on the tenant: room
       * administrators do not raise their own limits.
       */
      setRoom: endpoint({
        operation: { action: MANAGE, target: 'tenant', mutates: true },
        input: v.object({
          roomId: v.id(),
          maxBytes: limitSchema,
          maxDocuments: limitSchema,
          maxFileBytes: limitSchema,
        }),
        async handler(context, input) {
          const room = await loadRoom(context, input.roomId);
          const existing = await context.db.findOne<LimitRecord>('quotaLimits', {
            tenantId: context.tenantId,
            roomId: room.id,
          });
          const patch: Record<string, number | null> = {};
          for (const name of ['maxBytes', 'maxDocuments', 'maxFileBytes'] as const)
            if (input[name] !== undefined) patch[name] = input[name];
          if (existing)
            await context.db.update(
              'quotaLimits',
              { id: existing.id, tenantId: context.tenantId },
              { ...patch, updatedBy: context.principal.id },
            );
          else
            await context.db.insert('quotaLimits', {
              id: prefixedId('qlim', context.now),
              tenantId: context.tenantId,
              roomId: room.id,
              ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== null)),
              updatedBy: context.principal.id,
              createdAt: context.now,
            });
          await context.activity({ roomId: room.id, action: 'quota.changed', metadata: patch });
          return report(
            await usageOf(context.db, context.tenantId, 'room', room.id),
            await roomLimits(context.db, context.tenantId, room.id),
          );
        },
      }),
      recount: endpoint({
        operation: { action: MANAGE, target: 'tenant', mutates: false },
        input: v.object({ roomId: v.id() }),
        async handler(context, input) {
          const room = await loadRoom(context, input.roomId);
          return report(
            await recount(context.db, context.tenantId, room.id),
            await roomLimits(context.db, context.tenantId, room.id),
          );
        },
      }),
    },
  });
}
