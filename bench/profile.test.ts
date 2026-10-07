import { Session, type Profiler } from 'node:inspector';
import Database from 'better-sqlite3';
import { describe, it } from 'vitest';
import { createSqlAdapter, type SqlDriver } from '@better-files/adapter-sql';
import { sqliteDriver } from '@better-files/adapter-sqlite';
import { as, TENANT } from '../tests/fixtures.js';
import { largeRoom } from './large-room.js';

/**
 * Not a target: prints where one guest listing spends its time, query by query, with SQLite's plan. Run with
 * `BENCH_PROFILE=1 pnpm bench:targets` when a target regresses.
 */
describe.runIf(process.env.BENCH_PROFILE)('folder listing profile (SQLite)', () => {
  it('times each query of one listing', async () => {
    const raw = new Database(':memory:');
    const timings: { sql: string; ms: number; rows: number }[] = [];
    let recording = false;
    const wrap = (driver: SqlDriver): SqlDriver => ({
      ...driver,
      async query(sql, params) {
        const start = performance.now();
        const rows = await driver.query(sql, params);
        if (recording) timings.push({ sql, ms: performance.now() - start, rows: rows.length });
        return rows;
      },
      transaction: (fn) => driver.transaction((tx) => fn(wrap(tx))),
    });
    const room = await largeRoom({
      database: createSqlAdapter(wrap(sqliteDriver(raw)), { id: 'sqlite' }),
      nodes: Number(process.env.BENCH_NODES ?? 100_000),
    });
    const list = () =>
      room.dr.api.folders.list(as(room.guest), { tenantId: TENANT, nodeId: room.folderId });
    await list();
    recording = true;
    const start = performance.now();
    await list();
    const total = performance.now() - start;
    recording = false;
    for (const t of timings) {
      const shape = t.sql.replace(/(\?, )+\?/g, '…').slice(0, 140);
      const plan = raw
        .prepare(`EXPLAIN QUERY PLAN ${t.sql.replace(/\?/g, "'x'")}`)
        .all()
        .map((row) => (row as { detail: string }).detail)
        .join(' | ');
      console.log(
        `${t.ms.toFixed(2).padStart(7)} ms ${String(t.rows).padStart(5)} rows  ${shape}\n            ${plan}`,
      );
    }
    const inQueries = timings.reduce((sum, t) => sum + t.ms, 0);
    console.log(`total ${total.toFixed(2)} ms, in queries ${inQueries.toFixed(2)} ms`);

    // Where the JavaScript time goes: self time by function over 50 listings.
    const session = new Session();
    session.connect();
    const post = <T>(method: string, params?: object) =>
      new Promise<T>((resolve, reject) =>
        session.post(method, params, (error, result) =>
          error ? reject(error) : resolve(result as T),
        ),
      );
    await post('Profiler.enable');
    await post('Profiler.setSamplingInterval', { interval: 100 });
    await post('Profiler.start');
    for (let i = 0; i < 50; i++) await list();
    const { profile } = await post<{ profile: Profiler.Profile }>('Profiler.stop');
    session.disconnect();
    const interval = (profile.endTime - profile.startTime) / profile.samples!.length / 1000;
    const hits = new Map<number, number>();
    for (const id of profile.samples!) hits.set(id, (hits.get(id) ?? 0) + 1);
    const self = new Map<string, number>();
    for (const node of profile.nodes) {
      const { functionName, url, lineNumber } = node.callFrame;
      const where = `${functionName || '(anonymous)'} ${url.replace(/^.*\/(packages|node_modules)\//, '$1/')}:${lineNumber + 1}`;
      self.set(where, (self.get(where) ?? 0) + (hits.get(node.id) ?? 0) * interval);
    }
    console.log('self time per listing, top 25:');
    for (const [where, ms] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25))
      console.log(`${(ms / 50).toFixed(3).padStart(8)} ms  ${where}`);
    await room.close();
  }, 600_000);
});
