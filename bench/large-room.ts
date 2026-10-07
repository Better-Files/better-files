import { createId, type DatabaseAdapter } from '@better-files/core';
import { as, fixture, TENANT, users } from '../tests/fixtures.js';

export interface LargeRoomOptions {
  database: DatabaseAdapter;
  /** Total folders and documents under the root. Default 100,000 (PLAN §9.3). */
  nodes?: number;
  /** Groups the measured guest belongs to, each with entries in the matrix. Default 50. */
  groups?: number;
  /** Items in each leaf folder; the measured listing is one of them. Default 500. */
  folderSize?: number;
  /** Subfolders under each top-level folder. Default 10. */
  fanout?: number;
}

export interface LargeRoom {
  dr: Awaited<ReturnType<typeof fixture>>['dr'];
  roomId: string;
  /** A leaf folder holding `folderSize` items, every ancestor carrying matrix entries for the guest's groups. */
  folderId: string;
  /** `bob`, a guest in `groups` groups. */
  guest: string;
  nodes: number;
  close(): Promise<void>;
}

/**
 * A room shaped like a large deal: top-level folders, subfolders, and leaf folders of `folderSize` documents, written
 * straight to the database in one transaction. `bob` is invited through the API (so the identity system knows him)
 * and then placed in `groups` groups whose entries vary by folder, so a listing resolves a real matrix.
 */
export async function largeRoom(options: LargeRoomOptions): Promise<LargeRoom> {
  const total = options.nodes ?? 100_000;
  const groupCount = options.groups ?? 50;
  const folderSize = options.folderSize ?? 500;
  const fanout = options.fanout ?? 10;
  const f = await fixture({ database: options.database });
  const room = await f.room('Bench room');
  const buyers = await f.dr.api.groups.create(as('alice'), {
    tenantId: TENANT,
    roomId: room.id,
    name: 'Buyers',
    preset: 'view',
  });
  await f.dr.api.members.invite(as('alice'), {
    tenantId: TENANT,
    roomId: room.id,
    email: users.bob.email,
    groupIds: [buyers.id],
  });
  // The extra groups exist only as matrix subjects; the fake identity system reports them on bob's principal.
  const groupIds = Array.from({ length: groupCount - 1 }, (_, i) => `bench-group-${i}`);
  f.principals.bob = { ...users.bob, groups: groupIds };

  const now = f.clock.current;
  const db = options.database;
  const perTop = fanout * (folderSize + 1) + 1;
  const tops = Math.max(1, Math.round(total / perTop));
  let folderId = '';
  let written = 0;
  await db.transaction(async (tx) => {
    const insertNode = async (
      id: string,
      kind: 'folder' | 'document',
      name: string,
      chain: readonly string[],
      sortKey: number,
    ) => {
      await tx.insert('nodes', {
        id,
        tenantId: TENANT,
        roomId: room.id,
        parentId: chain[chain.length - 1]!,
        kind,
        name,
        nameKey: name.toLowerCase(),
        sortKey,
        createdBy: 'alice',
        createdAt: now,
        updatedAt: now,
      });
      if (kind === 'document')
        await tx.insert('documents', {
          id,
          tenantId: TENANT,
          roomId: room.id,
          latestVersion: 0,
          size: 0,
          flags: {},
          createdAt: now,
        });
      const full = [...chain, id];
      for (let i = 0; i < full.length; i++)
        await tx.insert('nodeClosure', {
          id: `${full[i]}:${id}`,
          tenantId: TENANT,
          roomId: room.id,
          ancestorId: full[i]!,
          descendantId: id,
          depth: full.length - 1 - i,
          createdAt: now,
        });
      written++;
    };
    const grant = (nodeId: string, subjectId: string, mask: number) =>
      tx.insert('aclEntries', {
        id: createId('acl', now),
        tenantId: TENANT,
        roomId: room.id,
        nodeId,
        subjectType: 'group',
        subjectId,
        mask,
        locked: false,
        grantedBy: 'alice',
        createdAt: now,
      });
    for (let t = 0; t < tops; t++) {
      const top = createId('node', now);
      await insertNode(top, 'folder', `Section ${t + 1}`, [room.rootNodeId], t + 1);
      // Every group has a cell on every top-level folder: half list-and-view, half list only.
      for (const [g, group] of groupIds.entries()) await grant(top, group, g % 2 ? 3 : 1);
      for (let s = 0; s < fanout; s++) {
        const sub = createId('node', now);
        await insertNode(sub, 'folder', `Folder ${t + 1}.${s + 1}`, [room.rootNodeId, top], s + 1);
        // A third of the groups get a deeper cell, so the nearest-entry rule has work to do.
        for (const [g, group] of groupIds.entries())
          if (g % 3 === 0) await grant(sub, group, g % 2 ? 1 : 3);
        if (!folderId) folderId = sub;
        for (let d = 0; d < folderSize; d++)
          await insertNode(
            createId('node', now),
            'document',
            `Document ${t + 1}.${s + 1}.${d + 1}.pdf`,
            [room.rootNodeId, top, sub],
            d + 1,
          );
      }
    }
  });
  return {
    dr: f.dr,
    roomId: room.id,
    folderId,
    guest: 'bob',
    nodes: written,
    close: () => f.dr.close(),
  };
}

/** Runs `fn` `iterations` times after `warmup` runs and returns latency percentiles in milliseconds. */
export async function measure(
  fn: () => Promise<unknown>,
  { iterations = 200, warmup = 20 }: { iterations?: number; warmup?: number } = {},
) {
  for (let i = 0; i < warmup; i++) await fn();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const at = (q: number) =>
    samples[Math.min(samples.length - 1, Math.ceil(q * samples.length) - 1)]!;
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    p99: round(at(0.99)),
    max: round(samples[samples.length - 1]!),
  };
}
