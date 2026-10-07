import type { JobEnvelope, JobOutcome, JobRunner } from '@better-files/core';
import { invalidConfig } from '@better-files/core';
import {
  defaultRecoverAfterMs,
  queuedJob,
  runMessage,
  runOf,
  type JobsHost,
  type QueuedJob,
  type RunJob,
} from './shared.js';

/** What the runner inserts for each job (a subset of pg-boss's `JobInsert`). */
export interface PgBossInsert {
  data: QueuedJob;
  startAfter: Date;
  retryLimit: number;
  priority?: number;
}

/** A job as pg-boss hands it to a worker. */
export interface PgBossJobLike {
  id: string;
  data: unknown;
}

/** The pg-boss worker options this runner passes through (a subset of pg-boss's `WorkOptions`). */
export interface PgBossWorkOptions {
  /** Jobs fetched per poll (pg-boss default 1). */
  batchSize?: number;
  /** Seconds between polls (pg-boss default 2). */
  pollingIntervalSeconds?: number;
  /** Workers polling in parallel in this process (pg-boss default 1). */
  localConcurrency?: number;
}

/** The part of a started `PgBoss` instance the runner uses. */
export interface PgBossLike {
  createQueue(name: string): Promise<void>;
  insert(name: string, jobs: PgBossInsert[]): Promise<unknown>;
  work(
    name: string,
    options: PgBossWorkOptions,
    handler: (jobs: PgBossJobLike[]) => Promise<unknown>,
  ): Promise<string>;
  offWork(name: string, options?: { id?: string; wait?: boolean }): Promise<void>;
}

export interface PgBossRunnerOptions {
  /** A started pg-boss instance (`await new PgBoss(connectionString).start()`). The host owns and stops it. */
  boss: PgBossLike;
  /** The pg-boss queue. Default `better-files`. */
  queue?: string;
  /** Creates the queue on first use (pg-boss 10+ needs queues to exist). Default true. */
  createQueue?: boolean;
  /** Worker options for `dr.jobs.start()`. */
  work?: PgBossWorkOptions;
  /** pg-boss priority for every Better Files job (higher runs first). */
  priority?: number;
  /** See `JobRunner.recoverAfterMs`. Default 5 minutes. */
  recoverAfterMs?: number;
}

/**
 * The pg-boss handler for Better Files jobs, for workers the host registers itself:
 * `boss.work('better-files', pgBossHandler(dr))`. Each job in a batch runs; a failed attempt does not fail the pg-boss
 * job, because Better Files has already scheduled the retry.
 */
export function pgBossHandler(
  host: JobsHost | RunJob,
): (jobs: PgBossJobLike[]) => Promise<JobOutcome[]> {
  const run = runOf(host);
  return (jobs) => Promise.all(jobs.map((job) => runMessage(run, job.data)));
}

/**
 * Runs Better Files jobs on pg-boss, a queue in PostgreSQL (it can share the Better Files database). pg-boss only
 * delivers, with its retries off; attempts, backoff, leases and failures stay in the Better Files `jobs` table, and
 * `dr.maintain()` runs anything the queue lost.
 *
 * ```ts
 * import { PgBoss } from 'pg-boss';
 * const boss = await new PgBoss(process.env.DATABASE_URL!).start();
 * const dr = betterFiles({ ..., jobs: { runner: pgBossRunner({ boss, work: { localConcurrency: 4 } }) } });
 * await dr.jobs.start(); // in the processes that should work jobs
 * ```
 */
export function pgBossRunner(options: PgBossRunnerOptions): JobRunner {
  const { boss } = options;
  if (!boss || typeof boss.insert !== 'function' || typeof boss.work !== 'function')
    throw invalidConfig('pgBossRunner: boss must be a started PgBoss instance');
  const queue = options.queue ?? 'better-files';
  let ready: Promise<void> | undefined;
  const ensureQueue = () => {
    if (options.createQueue === false) return Promise.resolve();
    // A failed creation is retried by the next call rather than remembered.
    ready ??= boss.createQueue(queue).catch((error: unknown) => {
      ready = undefined;
      throw error;
    });
    return ready;
  };
  let workerId: string | undefined;

  return {
    id: 'pg-boss',
    recoverAfterMs: options.recoverAfterMs ?? defaultRecoverAfterMs,
    async dispatch(envelopes: readonly JobEnvelope[]) {
      if (envelopes.length === 0) return;
      await ensureQueue();
      await boss.insert(
        queue,
        envelopes.map((envelope) => ({
          data: queuedJob(envelope),
          startAfter: new Date(envelope.runAt),
          retryLimit: 0,
          ...(options.priority === undefined ? {} : { priority: options.priority }),
        })),
      );
    },
    async start(run) {
      if (workerId) return;
      await ensureQueue();
      workerId = await boss.work(queue, options.work ?? {}, pgBossHandler(run));
    },
    async close() {
      const id = workerId;
      workerId = undefined;
      if (id) await boss.offWork(queue, { id, wait: true });
    },
  };
}
