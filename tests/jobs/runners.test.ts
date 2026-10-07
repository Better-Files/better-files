import { PGlite } from '@electric-sql/pglite';
import { createId, type JobEnvelope, type JobOutcome } from '@better-files/core';
import {
  bullmqProcessor,
  bullmqRunner,
  pgBossHandler,
  pgBossRunner,
  type BullJobOptions,
  type BullProcessor,
  type PgBossLike,
  type QueuedJob,
} from '@better-files/jobs';
import { fromPglite, PgBoss } from 'pg-boss';
import { afterEach, describe, expect, it } from 'vitest';

const envelope = (runAt = Date.now(), name = 'tests.work'): JobEnvelope => ({
  id: createId('job'),
  tenantId: 'tenant-1',
  name,
  runAt,
});

const waitFor = async (condition: () => boolean, timeoutMs = 15_000) => {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

describe('bullmqRunner', () => {
  function fakeQueue() {
    const added: { name: string; data: QueuedJob; opts?: BullJobOptions }[] = [];
    let closed = false;
    return {
      added,
      closed: () => closed,
      queue: {
        name: 'better-files',
        async addBulk(jobs: typeof added) {
          added.push(...jobs);
          return jobs;
        },
        async close() {
          closed = true;
        },
      },
    };
  }

  it('adds one BullMQ job per attempt, carrying only the job identity, with BullMQ retries off', async () => {
    const { queue, added } = fakeQueue();
    const runner = bullmqRunner({ queue });
    expect(runner.id).toBe('bullmq');
    expect(runner.recoverAfterMs).toBe(5 * 60_000);
    const now = Date.now();
    const due = envelope(now - 10);
    const later = envelope(now + 60_000);
    await runner.dispatch([due, later]);
    expect(added).toHaveLength(2);
    expect(added[0]!.name).toBe('tests.work');
    expect(added[0]!.data).toEqual({ id: due.id, tenantId: 'tenant-1', name: 'tests.work' });
    expect(added[0]!.opts).toMatchObject({
      jobId: `${due.id}@${due.runAt}`,
      delay: 0,
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: 1000,
    });
    expect(added[1]!.opts!.delay).toBeGreaterThan(59_000);
    expect(added[1]!.opts!.delay).toBeLessThanOrEqual(60_000);
    // BullMQ refuses custom ids containing ':'.
    expect(added.every((job) => !job.opts!.jobId.includes(':'))).toBe(true);

    // A retry of the same job is a new BullMQ job, not a duplicate of the finished one.
    await runner.dispatch([{ ...due, runAt: now + 30_000 }]);
    expect(added[2]!.opts!.jobId).not.toBe(added[0]!.opts!.jobId);
    await runner.dispatch([]);
    expect(added).toHaveLength(3);
  });

  it('starts the host worker with a processor that runs jobs, and closes it', async () => {
    const { queue, closed } = fakeQueue();
    let processor: BullProcessor | undefined;
    let workerClosed = 0;
    let workersMade = 0;
    const runner = bullmqRunner({
      queue,
      keep: { completed: 100, failed: false },
      priority: 2,
      worker(p) {
        workersMade++;
        processor = p;
        return {
          async close() {
            workerClosed++;
          },
        };
      },
    });
    const ran: string[] = [];
    const run = async (id: string): Promise<JobOutcome> => {
      ran.push(id);
      return { id, status: 'completed' };
    };
    await runner.start!(run);
    await runner.start!(run);
    expect(workersMade).toBe(1);
    const job = envelope();
    expect(await processor!({ data: { id: job.id, tenantId: 't', name: 'x' } })).toEqual({
      id: job.id,
      status: 'completed',
    });
    // Messages that do not name a Better Files job are skipped, not run or failed.
    expect((await processor!({ data: { id: 'not-a-job' } })).status).toBe('skipped');
    expect((await processor!({ data: null })).status).toBe('skipped');
    expect(ran).toEqual([job.id]);
    await runner.close!();
    expect(workerClosed).toBe(1);
    expect(closed()).toBe(false);
  });

  it('only consumes where a worker factory is given, and can own the queue', async () => {
    const { queue, closed } = fakeQueue();
    const runner = bullmqRunner({ queue, closeQueue: true, recoverAfterMs: 1000 });
    expect(runner.recoverAfterMs).toBe(1000);
    await runner.start!(async (id) => ({ id, status: 'completed' }));
    await runner.close!();
    expect(closed()).toBe(true);
    expect(() => bullmqRunner({ queue: {} as never })).toThrow(/BullMQ Queue/);
  });

  it('bullmqProcessor accepts a Better Files instance', async () => {
    const ran: string[] = [];
    const processor = bullmqProcessor({
      jobs: {
        run: async (id) => {
          ran.push(id);
          return { id, status: 'retry', runAt: 1 };
        },
      },
    });
    const job = envelope();
    expect((await processor({ data: { id: job.id } })).status).toBe('retry');
    expect(ran).toEqual([job.id]);
  });
});

describe('pgBossRunner', () => {
  let cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const fn of cleanup.reverse()) await fn();
    cleanup = [];
  });

  async function startBoss() {
    const pg = new PGlite();
    const boss = new PgBoss({
      db: fromPglite(pg),
      backend: 'pglite',
      schedule: false,
      supervise: false,
    });
    await boss.start();
    cleanup.push(async () => {
      await boss.stop({ graceful: false, close: false });
      await pg.close();
    });
    return boss;
  }

  it('fits a real PgBoss instance', async () => {
    const boss = await startBoss();
    // Compile-time: the structural interface accepts pg-boss itself.
    const like: PgBossLike = boss;
    expect(typeof like.insert).toBe('function');
  });

  it('delivers due jobs to dr.jobs.run through PostgreSQL and holds back delayed ones', async () => {
    const boss = await startBoss();
    const runner = pgBossRunner({
      boss,
      queue: 'better-files-test',
      work: { pollingIntervalSeconds: 0.5, batchSize: 5 },
    });
    expect(runner.id).toBe('pg-boss');
    const ran: string[] = [];
    await runner.start!(async (id) => {
      ran.push(id);
      return { id, status: 'completed' };
    });
    const due = [envelope(), envelope(Date.now() - 1000)];
    const later = envelope(Date.now() + 60 * 60_000);
    await runner.dispatch([...due, later]);
    await waitFor(() => ran.length >= 2);
    expect(ran.sort()).toEqual(due.map((job) => job.id).sort());

    const [queued] = await boss.findJobs<QueuedJob>('better-files-test', { queued: true });
    expect(queued!.data).toEqual({ id: later.id, tenantId: 'tenant-1', name: 'tests.work' });
    await runner.close!();

    // After close, nothing more is consumed in this process.
    const afterClose = envelope();
    await runner.dispatch([afterClose]);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(ran).not.toContain(afterClose.id);
  });

  it('does not fail pg-boss jobs on a failed attempt, since Better Files schedules the retry', async () => {
    const boss = await startBoss();
    const runner = pgBossRunner({ boss, work: { pollingIntervalSeconds: 0.5 } });
    const attempts: string[] = [];
    await runner.start!(async (id) => {
      attempts.push(id);
      return { id, status: 'retry', runAt: Date.now() + 60_000, error: 'boom' };
    });
    const job = envelope();
    await runner.dispatch([job]);
    await waitFor(() => attempts.length === 1);
    let state: string | undefined;
    for (let i = 0; i < 100 && state !== 'completed'; i++) {
      state = (await boss.findJobs('better-files', {}))[0]?.state;
      if (state !== 'completed') await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(state).toBe('completed');
    await runner.close!();
    expect(attempts).toEqual([job.id]);
  });

  it('pgBossHandler runs every job of a batch and skips foreign messages', async () => {
    const ran: string[] = [];
    const handler = pgBossHandler(async (id) => {
      ran.push(id);
      return { id, status: 'completed' };
    });
    const a = envelope();
    const b = envelope();
    const outcomes = await handler([
      { id: '1', data: { id: a.id } },
      { id: '2', data: { id: b.id } },
      { id: '3', data: { hello: 'world' } },
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      'completed',
      'completed',
      'skipped',
    ]);
    expect(ran).toEqual([a.id, b.id]);
  });

  it('refuses something that is not pg-boss', () => {
    expect(() => pgBossRunner({ boss: {} as never })).toThrow(/PgBoss/);
  });
});
