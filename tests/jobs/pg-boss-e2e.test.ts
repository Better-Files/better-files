import { PGlite } from '@electric-sql/pglite';
import { defineJob } from '@better-files/core';
import { pgliteAdapter } from '@better-files/adapter-pglite';
import { pgBossRunner } from '@better-files/jobs';
import { betterFiles } from '@better-files/server';
import { fromPglite, PgBoss } from 'pg-boss';
import { expect, it } from 'vitest';
import { fixture, SECRET, TENANT } from '../fixtures.js';

const waitFor = async (condition: () => Promise<boolean> | boolean, timeoutMs = 20_000) => {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

it('runs Better Files jobs through pg-boss, with Better Files owning retries', async () => {
  const pg = new PGlite();
  const boss = new PgBoss({
    db: fromPglite(pg),
    backend: 'pglite',
    schedule: false,
    supervise: false,
  });
  await boss.start();
  const f = await fixture({ database: pgliteAdapter() });
  const order: string[] = [];
  let flakyCalls = 0;
  const dr = betterFiles({
    iam: f.iam,
    database: f.database,
    storage: f.storage,
    secret: SECRET,
    encryption: false,
    logger: { warn() {}, error() {} },
    jobs: {
      runner: pgBossRunner({ boss, work: { pollingIntervalSeconds: 0.5, batchSize: 4 } }),
      handlers: {
        work: defineJob<{ v: number }>({
          async handler(payload, context) {
            order.push(`work:${payload.v}`);
            await context.enqueue(context.tenantId, 'followUp', { v: payload.v });
          },
        }),
        followUp: defineJob<{ v: number }>({
          async handler(payload) {
            order.push(`followUp:${payload.v}`);
          },
        }),
        flaky: defineJob({
          maxAttempts: 3,
          backoff: () => 0,
          async handler() {
            flakyCalls++;
            if (flakyCalls === 1) throw new Error('first attempt fails');
          },
        }),
      },
    },
  });
  try {
    await dr.initialize();
    // Enqueued before any worker runs: the job waits in pg-boss.
    const work = await dr.jobs.enqueue(TENANT, 'work', { v: 1 });
    expect((await dr.jobs.get(TENANT, work.id))!.status).toBe('pending');
    expect(await boss.findJobs('better-files', { queued: true })).toHaveLength(1);

    await dr.jobs.start();
    const flaky = await dr.jobs.enqueue(TENANT, 'flaky', {});
    await waitFor(async () => (await dr.jobs.get(TENANT, flaky.id))!.status === 'completed');
    // The retry went back through pg-boss as a new delivery of the same Better Files job.
    expect(flakyCalls).toBe(2);
    expect(await dr.jobs.get(TENANT, flaky.id)).toMatchObject({ attempts: 2 });

    await waitFor(() => order.length === 2);
    expect(order).toEqual(['work:1', 'followUp:1']);
    expect(await dr.jobs.get(TENANT, work.id)).toMatchObject({ status: 'completed', attempts: 1 });
    // Nothing for maintenance to recover: pg-boss delivered everything.
    expect((await dr.maintain()).jobs).toBe(0);
  } finally {
    await dr.close();
    await boss.stop({ graceful: false, close: false });
    await pg.close();
  }
});
