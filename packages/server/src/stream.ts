import {
  Capability,
  notFound,
  operationMatrix,
  resourceTypes,
  type ActivityRecord,
  type Credential,
  type DataRoomNode,
} from '@better-files/core';
import type { Engine } from './engine.js';
import { createContext, loadRoom } from './pipeline.js';

/** What everyone in a room may follow: changes to documents and folders they can see. */
const feedActions =
  /^(folder|document)\.(created|uploaded|renamed|moved|deleted|restored)$|^version\.(created|restored)$/;
/** Metadata a feed entry keeps: names and numbers, never people or addresses. */
const feedMetadata = ['name', 'filename', 'version', 'from', 'to', 'items', 'size'];

export interface StreamOptions {
  tenantId: string;
  roomId: string;
  /** Resume after this activity sequence (the SSE `Last-Event-ID`). Default: only new activity. */
  after?: number;
  /** Idle ping interval. Default 15 s. */
  pingMs?: number;
  signal?: AbortSignal;
}

/**
 * A room's activity as Server-Sent Events. The source is the hash-chained activity log, so every entry has a
 * stable id (its sequence) and a client resumes exactly where it left off; the event bus only wakes the stream.
 * Callers with activity access see every record; everyone else sees document and folder changes for nodes they
 * may list, with metadata trimmed to names.
 */
export function createActivityStream(engine: Engine) {
  return async function stream(credential: Credential, options: StreamOptions): Promise<Response> {
    const { tenantId } = options;
    const principal = await engine.iam.identity.authenticate(credential, tenantId);
    const room = await loadRoom(engine.db, tenantId, options.roomId);
    const decide = async (action: string) =>
      (
        await engine.iam.authz.authorize(credential, {
          tenantId,
          action,
          resource: { type: resourceTypes.room, id: room.id },
        })
      ).allowed;
    if (!(await decide(operationMatrix['rooms.get'].action))) throw notFound('Room');
    let full = await decide(operationMatrix['activity.list'].action);
    const scope = createContext(engine, { tenantId, principal, credential });
    const context = scope.make(engine.db, { room });
    let cursor = options.after ?? room.activitySequence;
    let checkedAt = Date.now();
    let closed = false;
    let wake: (() => void) | undefined;
    const unsubscribe = engine.events.subscribe('*', (event) => {
      if (event.tenantId === tenantId && event.roomId === room.id) wake?.();
    });
    const close = () => {
      closed = true;
      unsubscribe();
      wake?.();
    };
    options.signal?.addEventListener('abort', close, { once: true });
    const encoder = new TextEncoder();
    const pingMs = options.pingMs ?? 15_000;

    async function visible(records: ActivityRecord[]): Promise<ActivityRecord[]> {
      if (full) return records;
      const candidates = records.filter(
        (record) => record.nodeId && feedActions.test(record.action),
      );
      const ids = [...new Set(candidates.map((record) => record.nodeId!))];
      if (!ids.length) return [];
      const nodes = await engine.db.findMany<DataRoomNode>('nodes', {
        where: { tenantId, roomId: room.id, id: { in: ids } },
      });
      const masks = await engine.access.capabilities({
        db: engine.db,
        credential,
        principal,
        room,
        nodes,
        context,
      });
      return candidates
        .filter((record) => ((masks.get(record.nodeId!) ?? 0) & Capability.LIST) !== 0)
        .map((record) => ({
          ...record,
          metadata: Object.fromEntries(
            Object.entries(record.metadata ?? {}).filter(([key]) => feedMetadata.includes(key)),
          ),
        }));
    }

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`retry: 3000\n: connected to ${room.id}\n\n`));
      },
      async pull(controller) {
        while (!closed) {
          // Access can be withdrawn while a stream is open: check again every minute.
          if (Date.now() - checkedAt > 60_000) {
            checkedAt = Date.now();
            if (!(await decide(operationMatrix['rooms.get'].action))) {
              controller.enqueue(encoder.encode('event: revoked\ndata: {}\n\n'));
              close();
              break;
            }
            full = await decide(operationMatrix['activity.list'].action);
          }
          const records = await engine.db.findMany<ActivityRecord>('activity', {
            where: { tenantId, roomId: room.id, sequence: { gt: cursor } },
            orderBy: [{ field: 'sequence' }],
            limit: 200,
          });
          if (records.length) {
            cursor = records.at(-1)!.sequence;
            const shown = await visible(records);
            for (const record of shown) {
              const {
                tenantId: _tenant,
                hash: _hash,
                previousHash: _previous,
                ip: _ip,
                userAgent: _agent,
                ...view
              } = record as ActivityRecord & {
                previousHash?: string;
                ip?: string;
                userAgent?: string;
              };
              controller.enqueue(
                encoder.encode(
                  `id: ${record.sequence}\nevent: activity\ndata: ${JSON.stringify(full ? { ...view, ip: record.ip } : view)}\n\n`,
                ),
              );
            }
            if (shown.length) return;
            continue;
          }
          const woke = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), pingMs);
            wake = () => {
              clearTimeout(timer);
              resolve(true);
            };
          });
          wake = undefined;
          if (!woke && !closed) {
            controller.enqueue(encoder.encode(': ping\n\n'));
            return;
          }
        }
        controller.close();
      },
      cancel: close,
    });
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
        'x-content-type-options': 'nosniff',
      },
    });
  };
}
