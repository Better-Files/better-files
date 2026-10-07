import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '@better-files/core';
import { pgliteAdapter } from '@better-files/adapter-pglite';
import { sqliteAdapter } from '@better-files/adapter-sqlite';
import { as, TENANT } from '../tests/fixtures.js';
import { largeRoom, measure, type LargeRoom } from './large-room.js';

/**
 * PLAN §9.3: p95 under 15 ms for a 500-item folder listing in a room with 100,000 nodes and 50 groups. `BENCH_NODES`
 * shrinks the room for a quick run; `BENCH_P95_MS` overrides the target (slow CI machines). PostgreSQL (PGlite, in
 * process and single-threaded, so slower than a server) runs with `BENCH_PGLITE=1`.
 */
const NODES = Number(process.env.BENCH_NODES ?? 100_000);
const TARGET_MS = Number(process.env.BENCH_P95_MS ?? 15);

const databases: { name: string; create: () => DatabaseAdapter; enabled: boolean }[] = [
  { name: 'SQLite', create: () => sqliteAdapter({ filename: ':memory:' }), enabled: true },
  {
    name: 'PostgreSQL (PGlite)',
    create: () => pgliteAdapter(),
    enabled: !!process.env.BENCH_PGLITE,
  },
];

for (const database of databases)
  describe.runIf(database.enabled)(
    `folder listing in a ${NODES.toLocaleString('en')}-node room (${database.name})`,
    () => {
      let room: LargeRoom;

      beforeAll(async () => {
        const started = performance.now();
        room = await largeRoom({ database: database.create(), nodes: NODES });
        console.log(
          `${database.name}: seeded ${room.nodes.toLocaleString('en')} nodes in ${Math.round(performance.now() - started)} ms`,
        );
      }, 1_800_000);
      afterAll(() => room?.close());

      it('lists a 500-item folder for a guest in 50 groups within the p95 target', async () => {
        const list = () =>
          room.dr.api.folders.list(as(room.guest), { tenantId: TENANT, nodeId: room.folderId });
        const first = await list();
        // Sanity: the guest sees every item, so the matrix was resolved for all 500.
        expect(first.items).toHaveLength(500);
        const stats = await measure(list, { iterations: 100, warmup: 10 });
        console.log(`${database.name}: folders.list (guest, 50 groups)`, stats);
        expect(stats.p95).toBeLessThan(TARGET_MS);
      });

      it('lists the same folder for the room owner (admin floor) within the target', async () => {
        const list = () =>
          room.dr.api.folders.list(as('alice'), { tenantId: TENANT, nodeId: room.folderId });
        const stats = await measure(list, { iterations: 100, warmup: 10 });
        console.log(`${database.name}: folders.list (owner)`, stats);
        expect(stats.p95).toBeLessThan(TARGET_MS);
      });
    },
  );
