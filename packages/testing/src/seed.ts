import {
  createId,
  type AclEntry,
  type DatabaseAdapter,
  type DataRoomDocument,
  type DataRoomNode,
  type Room,
  type RoomSettings,
} from '@better-files/core';

export interface SeedNode {
  name: string;
  kind?: 'folder' | 'document';
  children?: readonly SeedNode[];
}

export interface SeededRoom {
  room: Room;
  /** Node ids by name; the root folder is `root`. Names must be unique within the seed. */
  nodes: Record<string, string>;
  /** Adds one permission-matrix cell. */
  grant(
    nodeName: string,
    subject: { type: AclEntry['subjectType']; id: string },
    mask: number,
    options?: { locked?: boolean; expiresAt?: number },
  ): Promise<void>;
}

/**
 * Writes a room, its folder tree and the closure rows straight to the database, for tests of access resolution
 * that do not go through the room services (and so need no identity-system directory).
 */
export async function seedRoom(
  db: DatabaseAdapter,
  input: {
    tenantId: string;
    ownerId?: string;
    status?: Room['status'];
    settings?: RoomSettings;
    tree?: readonly SeedNode[];
    now?: number;
  },
): Promise<SeededRoom> {
  const now = input.now ?? Date.now();
  const tenantId = input.tenantId;
  const roomId = createId('room', now);
  const rootId = createId('node', now);
  const nodes: Record<string, string> = { root: rootId };
  const room: Room = {
    id: roomId,
    tenantId,
    createdAt: now,
    updatedAt: now,
    name: 'Seeded room',
    slug: roomId.toLowerCase(),
    status: input.status ?? 'live',
    ownerId: input.ownerId ?? 'owner',
    rootNodeId: rootId,
    settings: input.settings ?? {},
    activitySequence: 0,
  };
  await db.transaction(async (tx) => {
    await tx.insert('rooms', room);
    const insertNode = async (
      id: string,
      name: string,
      kind: 'folder' | 'document',
      ancestors: readonly string[],
      sortKey: number,
    ) => {
      const node: DataRoomNode = {
        id,
        tenantId,
        roomId,
        name,
        nameKey: name.toLowerCase(),
        kind,
        sortKey,
        createdBy: room.ownerId,
        createdAt: now,
        updatedAt: now,
        ...(ancestors.length ? { parentId: ancestors[ancestors.length - 1]! } : {}),
      };
      await tx.insert('nodes', node);
      if (kind === 'document')
        await tx.insert('documents', {
          id,
          tenantId,
          roomId,
          latestVersion: 0,
          size: 0,
          flags: {},
          createdAt: now,
        } satisfies DataRoomDocument);
      const chain = [...ancestors, id];
      for (let i = 0; i < chain.length; i++)
        await tx.insert('nodeClosure', {
          id: `${chain[i]}:${id}`,
          tenantId,
          roomId,
          ancestorId: chain[i]!,
          descendantId: id,
          depth: chain.length - 1 - i,
          createdAt: now,
        });
    };
    await insertNode(rootId, 'Index', 'folder', [], 0);
    const walk = async (children: readonly SeedNode[], ancestors: readonly string[]) => {
      let position = 0;
      for (const child of children) {
        if (nodes[child.name]) throw new Error(`Seed node name ${child.name} is used twice`);
        const id = createId('node', now);
        nodes[child.name] = id;
        const kind = child.kind ?? (child.children ? 'folder' : 'document');
        await insertNode(id, child.name, kind, ancestors, ++position);
        if (child.children) await walk(child.children, [...ancestors, id]);
      }
    };
    await walk(input.tree ?? [], [rootId]);
  });
  return {
    room,
    nodes,
    async grant(nodeName, subject, mask, options = {}) {
      const nodeId = nodes[nodeName];
      if (!nodeId) throw new Error(`Unknown seed node ${nodeName}`);
      await db.transaction((tx) =>
        tx.insert('aclEntries', {
          id: createId('acl'),
          tenantId,
          roomId,
          nodeId,
          subjectType: subject.type,
          subjectId: subject.id,
          mask,
          locked: options.locked ?? false,
          grantedBy: room.ownerId,
          createdAt: now,
          ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
        }),
      );
    },
  };
}
