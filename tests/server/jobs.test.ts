import {
  BetterFilesError,
  type DatabaseAdapter,
  defineJob,
  definePlugin,
  endpoint,
  type JobContext,
  type JobEnvelope,
  type JobRunner,
} from '@better-files/core';
import { sqliteAdapter } from '@better-files/adapter-sqlite';
import { pgliteAdapter } from '@better-files/adapter-pglite';
import { memoryDatabase } from '@better-files/testing';
import { localKeyProvider } from '@better-files/crypto';
import { betterFiles, type JobsOptions } from '@better-files/server';
import { describe, expect, it } from 'vitest';
import { as, fixture, SECRET, TENANT } from '../fixtures.js';
import { objectSchema } from '../helpers.js';

type Seen = { payload: Record<string, unknown>; context: JobContext };

/** A plugin whose endpoint enqueues `demo.work` in its transaction, then optionally fails. */
function demoPlugin(
  handler: (payload: Record<string, unknown>, context: JobContext) => Promise<void>,
) {
  return definePlugin({
    id: 'demo',
    actions: ['better-files:demo:run'],
    jobs: {
      work: defineJob<{ n: number }>({
        handler: (payload, context) => handler(payload, context),
        maxAttempts: 2,
        backoff: () => 60_000,
      }),
    },
    endpoints: {
      start: endpoint({
        operation: { action: 'better-files:demo:run', target: 'tenant', mutates: true },
        input: objectSchema({ n: 'number', fail: 'boolean' }),
        async handler(context, input) {
          const job = await context.enqueue('demo.work', { n: input.n });
          if (input.fail) throw new BetterFilesError('CONFLICT', 'Refused after enqueueing');
          return job;
        },
      }),
    },
  });
}

async function setup(options: {
  database: () => DatabaseAdapter;
  jobs?: JobsOptions;
  handler?: (payload: Record<string, unknown>, context: JobContext) => Promise<void>;
}) {
  const f = await fixture({ database: options.database() });
  const seen: Seen[] = [];
  const plugin = demoPlugin(
    options.handler ??
      (async (payload, context) => {
        seen.push({ payload, context });
      }),
  );
  const dr = betterFiles({
    iam: f.iam,
    database: f.database,
    storage: f.storage,
    secret: SECRET,
    encryption: { keys: localKeyProvider({ secret: SECRET }) },
    plugins: [plugin],
    clock: { now: () => f.clock.current },
    logger: { warn() {}, error() {} },
    ...(options.jobs ? { jobs: options.jobs } : {}),
  });
  await dr.initialize();
  return { f, dr, seen };
}

const databases: [string, () => DatabaseAdapter][] = [
  ['memory', () => memoryDatabase()],
  ['sqlite', () => sqliteAdapter({ filename: ':memory:' })],
  ['pglite', () => pgliteAdapter()],
];

describe.each(databases)('jobs on %s', (_, makeDatabase) => {
  const database = makeDatabase;
  it('runs a job enqueued in an operation after it commits (inline runner)', async () => {
    const { dr, seen } = await setup({ database });
    const job = await dr.api.demo.start(as('alice'), { tenantId: TENANT, n: 7, fail: false });
    await dr.jobs.drain();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.payload).toEqual({ n: 7 });
    expect(seen[0]!.context).toMatchObject({
      tenantId: TENANT,
      job: { id: job.id, name: 'demo.work', attempt: 1, maxAttempts: 2 },
    });
    expect(await dr.jobs.get(TENANT, job.id)).toMatchObject({
      status: 'completed',
      attempts: 1,
      leaseUntil: 0,
    });
    // Another tenant cannot see it.
    expect(await dr.jobs.get('t2', job.id)).toBeNull();
  });

  it('drops the job when the operation fails', async () => {
    const { dr, seen } = await setup({ database });
    await expect(
      dr.api.demo.start(as('alice'), { tenantId: TENANT, n: 1, fail: true }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await dr.jobs.drain();
    expect(seen).toHaveLength(0);
    expect(await dr.jobs.list(TENANT)).toHaveLength(0);
  });

  it('retries with backoff, then marks the job failed; retry() and cancel() manage it', async () => {
    let calls = 0;
    const { f, dr } = await setup({
      database,
      jobs: { runner: 'deferred' },
      handler: async () => {
        calls++;
        throw new Error(`boom ${calls}`);
      },
    });
    const job = await dr.api.demo.start(as('alice'), { tenantId: TENANT, n: 1, fail: false });
    // Deferred: nothing runs until the host asks.
    await dr.jobs.drain();
    expect(calls).toBe(0);

    expect(await dr.jobs.work()).toEqual({ ran: 1, completed: 0, retried: 1, failed: 0 });
    expect(await dr.jobs.get(TENANT, job.id)).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'boom 1',
      runAt: f.clock.current + 60_000,
    });
    // Not due yet.
    expect(await dr.jobs.work()).toMatchObject({ ran: 0 });
    f.clock.current += 60_000;
    expect(await dr.jobs.work()).toEqual({ ran: 1, completed: 0, retried: 0, failed: 1 });
    expect(await dr.jobs.get(TENANT, job.id)).toMatchObject({ status: 'failed', attempts: 2 });
    expect(calls).toBe(2);

    await dr.jobs.retry(TENANT, job.id);
    expect(await dr.jobs.get(TENANT, job.id)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(await dr.jobs.cancel(TENANT, job.id)).toBe(true);
    expect(await dr.jobs.cancel(TENANT, job.id)).toBe(false);
    expect(await dr.jobs.work()).toMatchObject({ ran: 0 });
    await expect(dr.jobs.retry(TENANT, 'job_missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('deduplicates by key while a job is pending', async () => {
    const { dr } = await setup({ database, jobs: { runner: 'deferred' } });
    const first = await dr.jobs.enqueue(TENANT, 'demo.work', { n: 1 }, { key: 'doc-1' });
    const second = await dr.jobs.enqueue(TENANT, 'demo.work', { n: 2 }, { key: 'doc-1' });
    const other = await dr.jobs.enqueue(TENANT, 'demo.work', { n: 3 }, { key: 'doc-2' });
    expect(second.id).toBe(first.id);
    expect(other.id).not.toBe(first.id);
    await dr.jobs.work();
    // Finished: the key is free again.
    const third = await dr.jobs.enqueue(TENANT, 'demo.work', { n: 4 }, { key: 'doc-1' });
    expect(third.id).not.toBe(first.id);
  });

  it('runs a job once when two workers race for it', async () => {
    let calls = 0;
    const { dr } = await setup({
      database,
      jobs: { runner: 'deferred' },
      handler: async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 10));
      },
    });
    const job = await dr.jobs.enqueue(TENANT, 'demo.work', { n: 1 });
    const outcomes = await Promise.all([dr.jobs.run(job.id), dr.jobs.run(job.id)]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['completed', 'skipped']);
    expect(calls).toBe(1);
    expect(await dr.jobs.run(job.id)).toMatchObject({ status: 'skipped' });
  });

  it('maintain() takes over jobs whose worker crashed', async () => {
    const { f, dr, seen } = await setup({ database, jobs: { runner: 'deferred' } });
    const job = await dr.jobs.enqueue(TENANT, 'demo.work', { n: 1 });
    // A worker claimed it, then died: running, with a lease that has not expired yet.
    await f.database.transaction((tx) =>
      tx.update(
        'jobs',
        { id: job.id },
        { status: 'running', attempts: 1, leaseUntil: f.clock.current + 1000 },
      ),
    );
    expect((await dr.maintain()).jobs).toBe(0);
    f.clock.current += 1001;
    expect((await dr.maintain()).jobs).toBe(1);
    expect(seen[0]!.context.job.attempt).toBe(2);
    expect(await dr.jobs.get(TENANT, job.id)).toMatchObject({ status: 'completed' });
  });

  it('hands committed jobs to a custom runner, and maintain() only recovers what it lost', async () => {
    const dispatched: JobEnvelope[] = [];
    let consumer: ((id: string) => Promise<unknown>) | undefined;
    const runner: JobRunner = {
      id: 'test-queue',
      recoverAfterMs: 5 * 60_000,
      dispatch(jobs) {
        dispatched.push(...jobs);
      },
      start(run) {
        consumer = run;
      },
    };
    const { f, dr, seen } = await setup({ database, jobs: { runner } });
    await expect(
      dr.api.demo.start(as('alice'), { tenantId: TENANT, n: 1, fail: true }),
    ).rejects.toThrow();
    expect(dispatched).toHaveLength(0);
    const job = await dr.api.demo.start(as('alice'), { tenantId: TENANT, n: 2, fail: false });
    expect(dispatched).toEqual([
      { id: job.id, tenantId: TENANT, name: 'demo.work', runAt: f.clock.current },
    ]);

    // The queue lost the message: maintenance waits for recoverAfterMs before running it itself.
    expect((await dr.maintain()).jobs).toBe(0);
    f.clock.current += 5 * 60_000;
    expect((await dr.maintain()).jobs).toBe(1);
    expect(seen).toHaveLength(1);

    // A consumer started by the host runs what the queue delivers.
    await dr.jobs.start();
    const next = await dr.jobs.enqueue(TENANT, 'demo.work', { n: 3 });
    expect(await consumer!(next.id)).toMatchObject({ status: 'completed' });
    expect(seen.map((s) => s.payload['n'])).toEqual([2, 3]);
  });

  it('host jobs, follow-up jobs and validation', async () => {
    const f = await fixture({ database: database() });
    const order: string[] = [];
    const dr = betterFiles({
      iam: f.iam,
      database: f.database,
      storage: f.storage,
      secret: SECRET,
      encryption: false,
      clock: { now: () => f.clock.current },
      logger: { warn() {}, error() {} },
      jobs: {
        handlers: {
          first: defineJob({
            async handler(payload, context) {
              order.push(`first:${String(payload['v'])}`);
              await context.enqueue(context.tenantId, 'second', { v: payload['v'] });
            },
          }),
          second: defineJob({
            async handler(payload) {
              order.push(`second:${String(payload['v'])}`);
            },
          }),
        },
      },
    });
    await dr.initialize();
    await dr.jobs.enqueue(TENANT, 'first', { v: 1 });
    await dr.jobs.drain();
    expect(order).toEqual(['first:1', 'second:1']);
    await expect(dr.jobs.enqueue(TENANT, 'nope', {})).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await dr.close();

    const base = {
      iam: f.iam,
      database: f.database,
      storage: f.storage,
      secret: SECRET,
      encryption: false as const,
    };
    const job = defineJob({ handler: async () => {} });
    expect(() => betterFiles({ ...base, jobs: { handlers: { 'a.b': job } } })).toThrow(/dots/);
    expect(() =>
      betterFiles({
        ...base,
        plugins: [definePlugin({ id: 'x', jobs: { work: job } })],
        jobs: { handlers: { x: job } },
      }),
    ).not.toThrow();
    expect(() =>
      betterFiles({ ...base, plugins: [definePlugin({ id: 'x', jobs: { 'bad.name': job } })] }),
    ).toThrow(/invalid job name/);
  });
});
