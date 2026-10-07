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
  type DataRoomNode,
  type NodeClosure,
  type Room,
} from '@better-files/core';

export interface LegalHold {
  id: string;
  tenantId: string;
  roomId: string;
  /** A folder or document whose subtree is held; the whole room when absent. */
  nodeId?: string;
  name: string;
  reason: string;
  createdBy: string;
  releasedAt?: number;
  releasedBy?: string;
  createdAt: number;
}

/**
 * A minimum retention period: documents in the rule's scope cannot be deleted, purged from the trash or destroyed
 * with the room until `keepDays` have passed since they were added.
 */
export interface RetentionRule {
  id: string;
  tenantId: string;
  roomId: string;
  /** A folder or document whose subtree the rule covers; the whole room when absent. */
  nodeId?: string;
  name: string;
  keepDays: number;
  /** Locked rules cannot be removed (write-once records policies). */
  locked: boolean;
  createdBy: string;
  removedAt?: number;
  removedBy?: string;
  createdAt: number;
}

export interface RetentionOptions {
  /**
   * Days after a room closes before `dr.maintain()` emits `room.retention-expired` (once), so the host can export
   * and delete it under its records policy. Held rooms, and rooms with documents a retention rule still keeps, are
   * notified once that ends. Default: no retention schedule.
   */
  closedRoomRetentionDays?: number;
  /** Time source for retention rules; pass the one given to `betterFiles()` in tests. Default: `Date.now`. */
  clock?: { now(): number };
}

const DAY = 86_400_000;
const MAINTENANCE_BATCH = 100;

async function activeHolds(
  db: DatabaseAdapter,
  tenantId: string,
  roomId: string,
): Promise<LegalHold[]> {
  return db.findMany<LegalHold>('legalHolds', {
    where: { tenantId, roomId, releasedAt: { isNull: true } },
  });
}

async function activeRules(
  db: DatabaseAdapter,
  tenantId: string,
  roomId: string,
): Promise<RetentionRule[]> {
  return db.findMany<RetentionRule>('retentionRules', {
    where: { tenantId, roomId, removedAt: { isNull: true } },
  });
}

/** Why a legal hold preserves `nodeIds` (the whole room when absent), or undefined. */
async function heldReason(
  db: DatabaseAdapter,
  tenantId: string,
  roomId: string,
  nodeIds: readonly string[] | undefined,
): Promise<string | undefined> {
  const holds = await activeHolds(db, tenantId, roomId);
  if (holds.length === 0) return undefined;
  const roomWide = holds.find((hold) => !hold.nodeId);
  if (roomWide || !nodeIds)
    return `Legal hold "${(roomWide ?? holds[0]!).name}" preserves this room`;
  // A node is held when a hold's node is the node itself or one of its ancestors.
  const rows = await db.findMany<NodeClosure>('nodeClosure', {
    where: {
      tenantId,
      descendantId: { in: [...nodeIds] },
      ancestorId: { in: holds.map((hold) => hold.nodeId!) },
    },
    limit: 1,
  });
  if (rows.length === 0) return undefined;
  const hold = holds.find((candidate) => candidate.nodeId === rows[0]!.ancestorId)!;
  return `Legal hold "${hold.name}" preserves these items`;
}

/**
 * Why a retention rule still keeps a document among `nodeIds` (every document of the room when absent), or
 * undefined. Callers pass whole subtrees, so only documents need checking.
 */
async function retainedReason(
  db: DatabaseAdapter,
  tenantId: string,
  roomId: string,
  nodeIds: readonly string[] | undefined,
  now: number,
): Promise<string | undefined> {
  const rules = await activeRules(db, tenantId, roomId);
  if (rules.length === 0) return undefined;
  // Only documents younger than the longest rule can still be kept.
  const youngest = now - Math.max(...rules.map((rule) => rule.keepDays)) * DAY;
  const documents = await db.findMany<DataRoomNode>('nodes', {
    where: {
      tenantId,
      roomId,
      kind: 'document',
      createdAt: { gt: youngest },
      ...(nodeIds ? { id: { in: [...nodeIds] } } : {}),
    },
  });
  if (documents.length === 0) return undefined;
  const scoped = rules.filter((rule) => rule.nodeId);
  const ancestors = new Map<string, Set<string>>();
  if (scoped.length) {
    const rows = await db.findMany<NodeClosure>('nodeClosure', {
      where: {
        tenantId,
        descendantId: { in: documents.map((document) => document.id) },
        ancestorId: { in: scoped.map((rule) => rule.nodeId!) },
      },
    });
    for (const row of rows) {
      const set = ancestors.get(row.descendantId) ?? new Set<string>();
      set.add(row.ancestorId);
      ancestors.set(row.descendantId, set);
    }
  }
  let found: { rule: RetentionRule; document: DataRoomNode; until: number } | undefined;
  for (const document of documents)
    for (const rule of rules) {
      if (rule.nodeId && !ancestors.get(document.id)?.has(rule.nodeId)) continue;
      const until = document.createdAt + rule.keepDays * DAY;
      if (until > now && (!found || until > found.until)) found = { rule, document, until };
    }
  if (!found) return undefined;
  return `Retention rule "${found.rule.name}" keeps "${found.document.name}" until ${new Date(found.until).toISOString().slice(0, 10)}`;
}

/**
 * Legal holds and retention rules. A hold preserves a whole room or a folder's subtree indefinitely; a rule keeps
 * documents for a minimum number of days after they were added. Either way nothing covered can be deleted, purged
 * from the trash, or destroyed with the room — Better Files asks this plugin before every destructive step.
 * Placing and releasing holds, and adding and removing rules, is recorded in the room's activity log and the
 * identity system's audit log.
 */
export function retentionPlugin(options: RetentionOptions = {}) {
  const now = () => (options.clock ?? Date).now();
  return definePlugin({
    id: 'retention',
    actions: ['better-files:holds:manage'],
    accessModel: [{ relations: ['owner', 'admin'], actions: ['better-files:holds:manage'] }],
    extendSchema: {
      rooms: { additionalFields: { retentionNotifiedAt: field.timestamp({ required: false }) } },
    },
    schema: {
      legalHolds: defineTable({
        fields: {
          roomId: field.string(),
          nodeId: field.string({ required: false }),
          name: field.string(),
          reason: field.string(),
          createdBy: field.string(),
          releasedAt: field.timestamp({ required: false }),
          releasedBy: field.string({ required: false }),
        },
        indexes: [{ fields: ['tenantId', 'roomId'] }],
      }),
      retentionRules: defineTable({
        fields: {
          roomId: field.string(),
          nodeId: field.string({ required: false }),
          name: field.string(),
          keepDays: field.number(),
          locked: field.boolean(),
          createdBy: field.string(),
          removedAt: field.timestamp({ required: false }),
          removedBy: field.string({ required: false }),
        },
        indexes: [{ fields: ['tenantId', 'roomId'] }],
      }),
    },
    hooks: {
      async retains({ db, tenantId, roomId, nodeIds }) {
        return (
          (await heldReason(db, tenantId, roomId, nodeIds)) ??
          (await retainedReason(db, tenantId, roomId, nodeIds, now()))
        );
      },
    },
    async maintain(context) {
      if (!options.closedRoomRetentionDays) return;
      const cutoff = context.now - options.closedRoomRetentionDays * DAY;
      // Rooms still held or retained stay unnotified and come back each run, so page through every candidate
      // rather than re-reading the first batch (which held rooms alone could fill).
      let after: string | undefined;
      for (;;) {
        const rooms = await context.db.findMany<Room & { retentionNotifiedAt?: number }>('rooms', {
          where: {
            status: { in: ['closed', 'archived'] },
            updatedAt: { lt: cutoff },
            retentionNotifiedAt: { isNull: true },
            ...(after ? { id: { gt: after } } : {}),
          },
          orderBy: [{ field: 'id' }],
          limit: MAINTENANCE_BATCH,
        });
        for (const room of rooms) {
          if (
            (await heldReason(context.db, room.tenantId, room.id, undefined)) ||
            (await retainedReason(context.db, room.tenantId, room.id, undefined, context.now))
          )
            continue;
          await context.db.transaction((tx) =>
            tx.update(
              'rooms',
              { id: room.id, tenantId: room.tenantId },
              { retentionNotifiedAt: context.now },
            ),
          );
          await context.emit({
            type: 'room.retention-expired',
            tenantId: room.tenantId,
            roomId: room.id,
            data: { roomId: room.id, name: room.name, closedAt: room.updatedAt },
          });
        }
        if (rooms.length < MAINTENANCE_BATCH) break;
        after = rooms[rooms.length - 1]!.id;
      }
    },
    endpoints: {
      place: endpoint({
        operation: {
          action: 'better-files:holds:manage',
          target: 'room',
          mutates: true,
          allowClosed: true,
        },
        input: v.object({
          roomId: v.id(),
          nodeId: v.optional(v.id()),
          name: v.string({ min: 1, max: 200 }),
          reason: v.string({ min: 1, max: 2000 }),
        }),
        target: (input) => ({ roomId: input.roomId }),
        async handler(context, input) {
          const room = context.room!;
          if (
            input.nodeId &&
            !(await context.db.findOne('nodes', {
              id: input.nodeId,
              tenantId: context.tenantId,
              roomId: room.id,
            }))
          )
            throw notFound('Item');
          const hold: LegalHold = {
            id: prefixedId('hold', context.now),
            tenantId: context.tenantId,
            roomId: room.id,
            ...(input.nodeId ? { nodeId: input.nodeId } : {}),
            name: input.name,
            reason: input.reason,
            createdBy: context.principal.id,
            createdAt: context.now,
          };
          await context.db.insert('legalHolds', hold);
          await context.activity({
            roomId: room.id,
            action: 'hold.placed',
            ...(input.nodeId ? { nodeId: input.nodeId } : {}),
            metadata: { holdId: hold.id, name: hold.name },
          });
          context.emit('hold.placed', { holdId: hold.id, name: hold.name });
          return hold;
        },
      }),
      release: endpoint({
        operation: {
          action: 'better-files:holds:manage',
          target: 'room',
          mutates: true,
          allowClosed: true,
        },
        input: v.object({ holdId: v.id() }),
        async target(input, lookup) {
          const hold = await lookup.db.findOne<LegalHold>('legalHolds', {
            id: input.holdId,
            tenantId: lookup.tenantId,
          });
          if (!hold) throw notFound('Hold');
          return { roomId: hold.roomId };
        },
        async handler(context, input) {
          const hold = await context.db.findOne<LegalHold>('legalHolds', {
            id: input.holdId,
            tenantId: context.tenantId,
          });
          if (!hold) throw notFound('Hold');
          if (hold.releasedAt !== undefined)
            throw new BetterFilesError('CONFLICT', 'The hold was already released');
          await context.db.update(
            'legalHolds',
            { id: hold.id, tenantId: context.tenantId },
            { releasedAt: context.now, releasedBy: context.principal.id },
          );
          await context.activity({
            roomId: hold.roomId,
            action: 'hold.released',
            metadata: { holdId: hold.id, name: hold.name },
          });
          context.emit('hold.released', { holdId: hold.id });
          return { ...hold, releasedAt: context.now, releasedBy: context.principal.id };
        },
      }),
      list: endpoint({
        operation: {
          action: 'better-files:holds:manage',
          target: 'room',
          mutates: false,
          allowClosed: true,
        },
        input: v.object({ roomId: v.id(), includeReleased: v.optional(v.boolean()) }),
        target: (input) => ({ roomId: input.roomId }),
        async handler(context, input) {
          return context.db.findMany<LegalHold>('legalHolds', {
            where: {
              tenantId: context.tenantId,
              roomId: context.room!.id,
              ...(input.includeReleased ? {} : { releasedAt: { isNull: true } }),
            },
            orderBy: [{ field: 'createdAt' }],
          });
        },
      }),
      addRule: endpoint({
        operation: {
          action: 'better-files:holds:manage',
          target: 'room',
          mutates: true,
          allowClosed: true,
        },
        input: v.object({
          roomId: v.id(),
          nodeId: v.optional(v.id()),
          name: v.string({ min: 1, max: 200 }),
          keepDays: v.number({ min: 1, max: 36_500, int: true }),
          locked: v.optional(v.boolean()),
        }),
        target: (input) => ({ roomId: input.roomId }),
        async handler(context, input) {
          const room = context.room!;
          if (
            input.nodeId &&
            !(await context.db.findOne('nodes', {
              id: input.nodeId,
              tenantId: context.tenantId,
              roomId: room.id,
            }))
          )
            throw notFound('Item');
          const rule: RetentionRule = {
            id: prefixedId('rrule', context.now),
            tenantId: context.tenantId,
            roomId: room.id,
            ...(input.nodeId ? { nodeId: input.nodeId } : {}),
            name: input.name,
            keepDays: input.keepDays,
            locked: input.locked ?? false,
            createdBy: context.principal.id,
            createdAt: context.now,
          };
          await context.db.insert('retentionRules', rule);
          await context.activity({
            roomId: room.id,
            action: 'retention.rule-added',
            ...(input.nodeId ? { nodeId: input.nodeId } : {}),
            metadata: {
              ruleId: rule.id,
              name: rule.name,
              keepDays: rule.keepDays,
              locked: rule.locked,
            },
          });
          context.emit('retention.rule-added', { ruleId: rule.id, name: rule.name });
          return rule;
        },
      }),
      removeRule: endpoint({
        operation: {
          action: 'better-files:holds:manage',
          target: 'room',
          mutates: true,
          allowClosed: true,
        },
        input: v.object({ ruleId: v.id() }),
        async target(input, lookup) {
          const rule = await lookup.db.findOne<RetentionRule>('retentionRules', {
            id: input.ruleId,
            tenantId: lookup.tenantId,
          });
          if (!rule) throw notFound('Rule');
          return { roomId: rule.roomId };
        },
        async handler(context, input) {
          const rule = await context.db.findOne<RetentionRule>('retentionRules', {
            id: input.ruleId,
            tenantId: context.tenantId,
          });
          if (!rule) throw notFound('Rule');
          if (rule.removedAt !== undefined)
            throw new BetterFilesError('CONFLICT', 'The rule was already removed');
          if (rule.locked)
            throw new BetterFilesError('LEGAL_HOLD', `Retention rule "${rule.name}" is locked`);
          await context.db.update(
            'retentionRules',
            { id: rule.id, tenantId: context.tenantId },
            { removedAt: context.now, removedBy: context.principal.id },
          );
          await context.activity({
            roomId: rule.roomId,
            action: 'retention.rule-removed',
            metadata: { ruleId: rule.id, name: rule.name },
          });
          context.emit('retention.rule-removed', { ruleId: rule.id });
          return { ...rule, removedAt: context.now, removedBy: context.principal.id };
        },
      }),
      listRules: endpoint({
        operation: {
          action: 'better-files:holds:manage',
          target: 'room',
          mutates: false,
          allowClosed: true,
        },
        input: v.object({ roomId: v.id(), includeRemoved: v.optional(v.boolean()) }),
        target: (input) => ({ roomId: input.roomId }),
        async handler(context, input) {
          return context.db.findMany<RetentionRule>('retentionRules', {
            where: {
              tenantId: context.tenantId,
              roomId: context.room!.id,
              ...(input.includeRemoved ? {} : { removedAt: { isNull: true } }),
            },
            orderBy: [{ field: 'createdAt' }],
          });
        },
      }),
    },
  });
}
