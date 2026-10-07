import {
  Capability,
  definePlugin,
  endpoint,
  v,
  type ActivityRecord,
  type DataRoomDocument,
  type DataRoomNode,
  type DocumentVersion,
  type NodeClosure,
  type PluginContext,
  type Room,
} from '@better-files/core';

/** A folder or document as a sync client mirrors it. */
export interface SyncEntry {
  id: string;
  parentId: string | null;
  kind: 'folder' | 'document';
  name: string;
  updatedAt: number;
  /** The current version, for documents with content: compare `sha256` to decide whether to download. */
  version?: {
    id: string;
    number: number;
    sha256: string | null;
    size: number;
    mimeType: string | null;
  };
}

export type SyncChange = { type: 'upsert'; entry: SyncEntry } | { type: 'remove'; id: string };

export interface SyncOptions {
  /** Activity records examined per `changes` call. Default 500. */
  pageSize?: number;
}

/** Activity that changes the tree or a node's content. Anything else (views, searches, Q&A) is not a change. */
const structural =
  /^(folder|document)\.(created|uploaded|renamed|moved|deleted|restored|flags-changed)$|^version\.|^permissions\.changed$/;
/** Changes that can alter what a whole subtree looks like to the caller. */
const subtreeWide = /^(folder\.(moved|deleted|restored)|permissions\.changed)$/;
/** Membership changes can alter visibility anywhere in the room: clients start over from a snapshot. */
const roomWide = /^(group\.|member\.)/;

async function entries(
  context: PluginContext,
  room: Room,
  nodes: readonly DataRoomNode[],
): Promise<Map<string, SyncEntry>> {
  const live = nodes.filter((node) => node.deletedAt === undefined || node.deletedAt === null);
  if (live.length === 0) return new Map();
  // A node is visible when the caller may list it and every ancestor below the root.
  const closure = await context.db.findMany<NodeClosure>('nodeClosure', {
    where: {
      tenantId: context.tenantId,
      descendantId: { in: live.map((node) => node.id) },
      depth: { gt: 0 },
    },
  });
  const known = new Map(live.map((node) => [node.id, node]));
  const missing = [...new Set(closure.map((pair) => pair.ancestorId))].filter(
    (id) => !known.has(id),
  );
  if (missing.length)
    for (const node of await context.db.findMany<DataRoomNode>('nodes', {
      where: { tenantId: context.tenantId, id: { in: missing } },
    }))
      known.set(node.id, node);
  const masks = await context.capabilitiesOf([...known.values()]);
  const listable = (id: string) => {
    const node = known.get(id);
    return !!node && !node.deletedAt && ((masks.get(id) ?? 0) & Capability.LIST) !== 0;
  };
  const ancestors = new Map<string, string[]>();
  for (const pair of closure)
    ancestors.set(pair.descendantId, [
      ...(ancestors.get(pair.descendantId) ?? []),
      pair.ancestorId,
    ]);
  const visible = live.filter(
    (node) =>
      node.id !== room.rootNodeId &&
      listable(node.id) &&
      (ancestors.get(node.id) ?? []).every((id) => id === room.rootNodeId || listable(id)),
  );

  const documentIds = visible.filter((node) => node.kind === 'document').map((node) => node.id);
  const documents = documentIds.length
    ? await context.db.findMany<DataRoomDocument>('documents', {
        where: { tenantId: context.tenantId, id: { in: documentIds } },
      })
    : [];
  const versionIds = documents.flatMap((document) =>
    document.currentVersionId ? [document.currentVersionId] : [],
  );
  const versions = new Map(
    (versionIds.length
      ? await context.db.findMany<DocumentVersion>('versions', {
          where: { tenantId: context.tenantId, id: { in: versionIds } },
        })
      : []
    ).map((version) => [version.id, version]),
  );
  const current = new Map(
    documents.map((document) => [
      document.id,
      document.currentVersionId && versions.get(document.currentVersionId),
    ]),
  );

  return new Map(
    visible.map((node) => {
      const version = current.get(node.id);
      const entry: SyncEntry = {
        id: node.id,
        parentId: node.parentId === room.rootNodeId ? null : (node.parentId ?? null),
        kind: node.kind,
        name: node.name,
        updatedAt: node.updatedAt,
        ...(version
          ? {
              version: {
                id: version.id,
                number: version.number,
                sha256: version.sha256 ?? null,
                size: version.size,
                mimeType: version.mimeType ?? null,
              },
            }
          : {}),
      };
      return [node.id, entry];
    }),
  );
}

/** Parents before children, so clients can apply a snapshot or a batch of upserts in order. */
function ordered(list: Iterable<SyncEntry>): SyncEntry[] {
  const all = [...list];
  const byId = new Map(all.map((entry) => [entry.id, entry]));
  const depth = (entry: SyncEntry): number => {
    let d = 0;
    for (
      let parent = entry.parentId;
      parent && byId.has(parent) && d < 1000;
      parent = byId.get(parent)!.parentId
    )
      d++;
    return d;
  };
  return all.sort((a, b) => depth(a) - depth(b) || a.name.localeCompare(b.name));
}

/**
 * Delta sync over a room's activity log: `sync.snapshot` returns what the caller can see now with a cursor, and
 * `sync.changes` returns what changed since a cursor. The cursor is the room's activity sequence, so every change
 * the core records is covered, and results pass the same permission checks as the room index: when access is
 * withdrawn, the affected entries arrive as removals.
 */
export function syncPlugin(options: SyncOptions = {}) {
  const pageSize = options.pageSize ?? 500;
  const operation = {
    action: 'better-files:documents:list',
    target: 'room',
    mutates: false,
    allowClosed: true,
  } as const;

  return definePlugin({
    id: 'sync',
    endpoints: {
      snapshot: endpoint({
        operation,
        input: v.object({ roomId: v.id() }),
        target: (input) => ({ roomId: input.roomId }),
        async handler(context) {
          const room = context.room!;
          // Read the cursor first: anything recorded while the snapshot is built is replayed by the next `changes`.
          const cursor = room.activitySequence;
          const nodes = await context.db.findMany<DataRoomNode>('nodes', {
            where: { tenantId: context.tenantId, roomId: room.id, deletedAt: { isNull: true } },
          });
          return {
            cursor: String(cursor),
            entries: ordered((await entries(context, room, nodes)).values()),
          };
        },
      }),
      changes: endpoint({
        operation,
        input: v.object({ roomId: v.id(), cursor: v.string({ min: 1, max: 20 }) }),
        target: (input) => ({ roomId: input.roomId }),
        async handler(context, input) {
          const room = context.room!;
          const after = Number(input.cursor);
          if (!Number.isSafeInteger(after) || after < 0 || after > room.activitySequence)
            return {
              reset: true as const,
              cursor: String(room.activitySequence),
              changes: [],
              hasMore: false,
            };
          const records = await context.db.findMany<ActivityRecord>('activity', {
            where: { tenantId: context.tenantId, roomId: room.id, sequence: { gt: after } },
            orderBy: [{ field: 'sequence' }],
            limit: pageSize + 1,
          });
          const hasMore = records.length > pageSize;
          const page = records.slice(0, pageSize);
          const cursor = String(page.at(-1)?.sequence ?? after);
          if (page.some((record) => roomWide.test(record.action)))
            return {
              reset: true as const,
              cursor: String(room.activitySequence),
              changes: [],
              hasMore: false,
            };

          const touched = new Set<string>();
          const wide: string[] = [];
          for (const record of page) {
            if (!record.nodeId || !structural.test(record.action)) continue;
            touched.add(record.nodeId);
            if (subtreeWide.test(record.action)) wide.push(record.nodeId);
          }
          if (wide.length)
            for (const pair of await context.db.findMany<NodeClosure>('nodeClosure', {
              where: { tenantId: context.tenantId, ancestorId: { in: wide } },
            }))
              touched.add(pair.descendantId);
          touched.delete(room.rootNodeId);
          if (touched.size === 0) return { reset: false as const, cursor, changes: [], hasMore };

          const nodes = await context.db.findMany<DataRoomNode>('nodes', {
            where: { tenantId: context.tenantId, roomId: room.id, id: { in: [...touched] } },
          });
          const visible = await entries(context, room, nodes);
          const changes: SyncChange[] = [
            ...ordered(visible.values()).map((entry) => ({ type: 'upsert' as const, entry })),
            ...[...touched]
              .filter((id) => !visible.has(id))
              .map((id) => ({ type: 'remove' as const, id })),
          ];
          return { reset: false as const, cursor, changes, hasMore };
        },
      }),
    },
  });
}
