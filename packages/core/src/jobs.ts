import type { MaintenanceContext } from './plugin.js';

/**
 * Durable background work. A job is a row in the `jobs` table, written in the same transaction as the change that
 * asked for it, so it exists exactly when that change committed. A runner decides where it executes: in this
 * process (`inline`), when the host calls `dr.jobs.work()` (`deferred`), or on the host's own queue (BullMQ,
 * pg-boss, SQS). Wherever it runs, `dr.jobs.run(id)` executes it, so retries, backoff and failure are tracked in one
 * place, and `dr.maintain()` picks up anything a crashed process or a lost queue message left behind.
 */
export interface JobDefinition<Payload = Record<string, unknown>> {
  handler(payload: Payload, context: JobContext): Promise<void>;
  /** Attempts before the job is marked `failed`. Default 5. */
  maxAttempts?: number;
  /** Delay before attempt `attempt + 1`, in milliseconds. Default: 30 s doubling, capped at 1 hour. */
  backoff?(attempt: number): number;
  /**
   * How long one attempt may hold the job before another worker may take it over (a crashed process). Default 5
   * minutes. A handler that runs longer must finish within it or be idempotent.
   */
  leaseMs?: number;
}

/** Declares a job while keeping its payload type. */
export const defineJob = <Payload extends Record<string, unknown>>(
  definition: JobDefinition<Payload>,
): JobDefinition<Payload> => definition;

/**
 * What a job handler receives: the maintenance context (whose `enqueue` commits follow-up jobs at once) plus the
 * job's tenant and attempt.
 */
export interface JobContext extends MaintenanceContext {
  tenantId: string;
  job: { id: string; name: string; attempt: number; maxAttempts: number };
}

export interface EnqueueOptions {
  /** Run no earlier than this many milliseconds from now. */
  delayMs?: number;
  /** Run no earlier than this time (epoch milliseconds). */
  runAt?: number;
  /**
   * Deduplication key, per tenant and job name: while a job with the same key is pending or running, enqueueing
   * returns that job instead of adding another.
   */
  key?: string;
  /** Overrides the definition's `maxAttempts`. */
  maxAttempts?: number;
}

/** What a runner carries: enough to call `dr.jobs.run(id)` and to schedule it. */
export interface JobEnvelope {
  id: string;
  tenantId: string;
  /** `{pluginId}.{name}` for plugin jobs, or the name the host registered. */
  name: string;
  /** When the job is due (epoch milliseconds). */
  runAt: number;
}

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/** What `dr.jobs.run(id)` reports. */
export interface JobOutcome {
  id: string;
  /**
   * `completed`; `retry` (failed, scheduled again at `runAt`); `failed` (out of attempts); `skipped` (not due, already
   * taken by another worker, finished, cancelled or unknown).
   */
  status: 'completed' | 'retry' | 'failed' | 'skipped';
  runAt?: number;
  error?: string;
}

/**
 * Where jobs execute. `dispatch` is called after the enqueueing transaction commits (and again after each failed
 * attempt that will be retried), so a runner never sees a job that does not exist.
 */
export interface JobRunner {
  readonly id: string;
  dispatch(jobs: readonly JobEnvelope[]): Promise<void> | void;
  /**
   * Starts consuming, with the function that executes a job. Called by `dr.jobs.start()`, which the host runs in the
   * processes that should work jobs (a worker, or every server).
   */
  start?(run: (id: string) => Promise<JobOutcome>): Promise<void> | void;
  /** Stops consuming; `dr.close()` calls it. */
  close?(): Promise<void>;
  /**
   * How long a due job may wait before `dr.maintain()` runs it itself, in milliseconds. Runners that deliver jobs
   * elsewhere set this so maintenance only catches what their queue lost. Default 0.
   */
  readonly recoverAfterMs?: number;
}

/** Default backoff: 30 s, 1 min, 2 min, … capped at an hour. */
export const defaultJobBackoff = (attempt: number) =>
  Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, attempt - 1));
