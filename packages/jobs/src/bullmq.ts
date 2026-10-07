import type { JobEnvelope, JobOutcome, JobRunner } from '@better-files/core';
import { invalidConfig } from '@better-files/core';
import {
  defaultRecoverAfterMs,
  delayOf,
  queuedJob,
  runMessage,
  runOf,
  type JobsHost,
  type QueuedJob,
  type RunJob,
} from './shared.js';

/** The options this runner sets on each BullMQ job (a subset of BullMQ's `JobsOptions`). */
export interface BullJobOptions {
  jobId: string;
  delay: number;
  attempts: number;
  removeOnComplete: boolean | number;
  removeOnFail: boolean | number;
  priority?: number;
}

/** The part of a BullMQ `Queue` the runner uses. A `new Queue(name, { connection })` fits. */
export interface BullQueueLike {
  readonly name: string;
  addBulk(jobs: { name: string; data: QueuedJob; opts?: BullJobOptions }[]): Promise<unknown>;
  close(): Promise<void>;
}

/** The part of a BullMQ `Worker` the runner uses. */
export interface BullWorkerLike {
  close(force?: boolean): Promise<void>;
}

/** A BullMQ processor: what `new Worker(name, processor, options)` takes. */
export type BullProcessor = (job: { data: unknown }) => Promise<JobOutcome>;

export interface BullmqRunnerOptions {
  /** The queue Better Files adds jobs to. The host creates it (and owns its connection). */
  queue: BullQueueLike;
  /**
   * Creates the worker when the host calls `dr.jobs.start()`, for example
   * `(processor) => new Worker(queue.name, processor, { connection, concurrency: 8 })`. Leave it out in processes
   * that only enqueue; a separate worker process can use `bullmqProcessor(dr)` instead.
   */
  worker?(processor: BullProcessor): BullWorkerLike;
  /**
   * Finished BullMQ jobs to keep (BullMQ's `removeOnComplete` / `removeOnFail`). Better Files records every outcome in
   * its own `jobs` table, so the defaults keep little: none completed, the last 1000 failed.
   */
  keep?: { completed?: boolean | number; failed?: boolean | number };
  /** BullMQ priority for every Better Files job (1 is highest). */
  priority?: number;
  /** See `JobRunner.recoverAfterMs`. Default 5 minutes. */
  recoverAfterMs?: number;
  /** Also close `queue` on `dr.close()`. Default false: the host created it, the host closes it. */
  closeQueue?: boolean;
}

/**
 * The BullMQ processor for Better Files jobs, for workers the host builds itself:
 * `new Worker('better-files', bullmqProcessor(dr), { connection })`.
 *
 * It resolves with the outcome rather than throwing on a failed attempt: Better Files owns retries and backoff, and has
 * already scheduled the next attempt. It throws only when the job could not be run at all (the database is down),
 * which leaves the job to `dr.maintain()`.
 */
export function bullmqProcessor(host: JobsHost | RunJob): BullProcessor {
  const run = runOf(host);
  return (job) => runMessage(run, job.data);
}

/**
 * Runs Better Files jobs on BullMQ (Redis or BullMQ's other backends). BullMQ only delivers: each message carries the
 * job id, at most once per attempt (the BullMQ job id is `{jobId}@{runAt}`), with BullMQ retries off. Attempts,
 * backoff, leases and failures stay in the Better Files `jobs` table, and `dr.maintain()` runs anything the queue lost.
 *
 * ```ts
 * import { Queue, Worker } from 'bullmq';
 * const queue = new Queue('better-files', { connection });
 * const dr = betterFiles({
 *   ...,
 *   jobs: { runner: bullmqRunner({ queue, worker: (p) => new Worker('better-files', p, { connection }) }) },
 * });
 * await dr.jobs.start(); // in the processes that should work jobs
 * ```
 */
export function bullmqRunner(options: BullmqRunnerOptions): JobRunner {
  const { queue } = options;
  if (!queue || typeof queue.addBulk !== 'function')
    throw invalidConfig('bullmqRunner: queue must be a BullMQ Queue');
  const keepCompleted = options.keep?.completed ?? true;
  const keepFailed = options.keep?.failed ?? 1000;
  let worker: BullWorkerLike | undefined;

  return {
    id: 'bullmq',
    recoverAfterMs: options.recoverAfterMs ?? defaultRecoverAfterMs,
    async dispatch(envelopes: readonly JobEnvelope[]) {
      if (envelopes.length === 0) return;
      const now = Date.now();
      await queue.addBulk(
        envelopes.map((envelope) => ({
          name: envelope.name,
          data: queuedJob(envelope),
          opts: {
            // A retry re-dispatches the same job with a new runAt; a plain job id would collide with the finished
            // BullMQ job of the previous attempt, and BullMQ would drop the add.
            jobId: `${envelope.id}@${envelope.runAt}`,
            delay: delayOf(envelope, now),
            attempts: 1,
            removeOnComplete: keepCompleted,
            removeOnFail: keepFailed,
            ...(options.priority === undefined ? {} : { priority: options.priority }),
          },
        })),
      );
    },
    start(run) {
      if (worker || !options.worker) return;
      worker = options.worker(bullmqProcessor(run));
    },
    async close() {
      const current = worker;
      worker = undefined;
      await current?.close();
      if (options.closeQueue) await queue.close();
    },
  };
}
