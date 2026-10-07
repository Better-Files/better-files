import { createHash } from 'node:crypto';
import {
  createId,
  notFound,
  type ActivityRecord,
  type DatabaseAdapter,
  type Room,
} from '@better-files/core';

export interface ActivityEntry {
  tenantId: string;
  roomId: string;
  actorId: string;
  action: string;
  nodeId?: string;
  metadata?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
  createdAt: number;
}

/** Deterministic JSON: object keys sorted at every level, so a record hashes the same everywhere. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    )
    .join(',')}}`;
}

export function activityHash(
  record: Omit<ActivityRecord, 'hash' | 'id'> & { id?: string },
): string {
  const { id: _id, hash: _hash, ...content } = record as ActivityRecord;
  return createHash('sha256').update(canonicalJson(content)).digest('hex');
}

/**
 * Appends to a room's activity chain inside `tx`. The room's sequence counter is incremented first; that row lock
 * serializes concurrent writers, so sequences are gap-free and each record hashes over its predecessor.
 */
export async function recordActivity(
  tx: DatabaseAdapter,
  entry: ActivityEntry,
): Promise<ActivityRecord> {
  const sequence = await tx.increment(
    'rooms',
    { id: entry.roomId, tenantId: entry.tenantId },
    'activitySequence',
  );
  if (sequence === null) throw notFound('Room');
  const room = await tx.findOne<Room>('rooms', { id: entry.roomId, tenantId: entry.tenantId });
  const base = {
    tenantId: entry.tenantId,
    roomId: entry.roomId,
    sequence,
    actorId: entry.actorId,
    action: entry.action,
    createdAt: entry.createdAt,
    ...(entry.nodeId ? { nodeId: entry.nodeId } : {}),
    ...(entry.metadata ? { metadata: entry.metadata } : {}),
    ...(entry.ip ? { ip: entry.ip } : {}),
    ...(entry.userAgent ? { userAgent: entry.userAgent } : {}),
    ...(room?.activityHash ? { previousHash: room.activityHash } : {}),
  };
  const record: ActivityRecord = {
    ...base,
    id: createId('activity', entry.createdAt),
    hash: activityHash(base),
  };
  await tx.insert('activity', record);
  await tx.update(
    'rooms',
    { id: entry.roomId, tenantId: entry.tenantId },
    { activityHash: record.hash },
  );
  return record;
}

export interface ChainVerification {
  valid: boolean;
  records: number;
  head?: string;
  /** The first sequence whose record or link does not verify. */
  brokenAt?: number;
}

/** Recomputes every hash and link of a room's chain. */
export async function verifyActivity(
  db: DatabaseAdapter,
  tenantId: string,
  roomId: string,
): Promise<ChainVerification> {
  const pageSize = 500;
  let previous: string | undefined;
  let expected = 1;
  let count = 0;
  for (let offset = 0; ; offset += pageSize) {
    const page = await db.findMany<ActivityRecord>('activity', {
      where: { tenantId, roomId },
      orderBy: [{ field: 'sequence' }],
      limit: pageSize,
      offset,
    });
    for (const record of page) {
      const { id: _id, hash, ...content } = record;
      if (
        record.sequence !== expected ||
        record.previousHash !== previous ||
        activityHash(content) !== hash
      )
        return {
          valid: false,
          records: count,
          brokenAt: record.sequence,
          ...(previous ? { head: previous } : {}),
        };
      previous = hash;
      expected++;
      count++;
    }
    if (page.length < pageSize) break;
  }
  const room = await db.findOne<Room>('rooms', { id: roomId, tenantId });
  // The room's head must be the last record: a deleted tail shows up here.
  if (room && (room.activityHash ?? undefined) !== previous)
    return {
      valid: false,
      records: count,
      brokenAt: expected,
      ...(previous ? { head: previous } : {}),
    };
  return { valid: true, records: count, ...(previous ? { head: previous } : {}) };
}
