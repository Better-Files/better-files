import { isId, type JobEnvelope, type JobOutcome } from '@better-files/core';

/** Executes one Better Files job by id: `dr.jobs.run`. */
export type RunJob = (id: string) => Promise<JobOutcome>;

/** A Better Files instance, or anything with its `jobs.run`. */
export interface JobsHost {
  jobs: { run: RunJob };
}

/**
 * What a queue message carries. Only the job's identity: the payload stays in the Better Files `jobs` table, so
 * queue storage (Redis, another database) never holds document names, emails or other room data.
 */
export interface QueuedJob {
  id: string;
  tenantId: string;
  name: string;
}

/**
 * External queues deliver jobs themselves, so `dr.maintain()` only runs a due job after it has waited this long:
 * what the queue lost (a message dropped, a worker that died between claim and run).
 */
export const defaultRecoverAfterMs = 5 * 60_000;

export const queuedJob = (envelope: JobEnvelope): QueuedJob => ({
  id: envelope.id,
  tenantId: envelope.tenantId,
  name: envelope.name,
});

export const delayOf = (envelope: JobEnvelope, now = Date.now()) =>
  Math.max(0, envelope.runAt - now);

export const runOf = (host: JobsHost | RunJob): RunJob =>
  typeof host === 'function' ? host : (id) => host.jobs.run(id);

/**
 * Runs the job a message names. A message that does not name a job (another producer on the same queue) is skipped
 * rather than failed, so it does not pile up as a failure the queue retries.
 */
export async function runMessage(run: RunJob, data: unknown): Promise<JobOutcome> {
  const id = (data as Partial<QueuedJob> | null | undefined)?.id;
  if (!isId(id, 'job')) return { id: String(id), status: 'skipped' };
  return run(id);
}
