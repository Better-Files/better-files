import {
  createId,
  BetterFilesError,
  defaultJobBackoff,
  invalidConfig,
  type Clock,
  type DatabaseAdapter,
  type BetterFilesPlugin,
  type EnqueueOptions,
  type JobContext,
  type JobDefinition,
  type JobEnvelope,
  type JobOutcome,
  type JobRecord,
  type JobRunner,
  type JobStatus,
  type Logger,
  type MaintenanceContext,
} from '@better-files/core';

export interface JobsOptions {
  /**
   * `inline` (default): jobs run in this process right after the enqueueing operation commits, with retries on
   * timers. `deferred`: jobs only wait in the table until the host calls `dr.jobs.work()` (or `dr.maintain()`), for
   * serverless hosts and existing workers. Or a `JobRunner` for the host's queue (`bullmqRunner`, `pgBossRunner` from
   * `@better-files/jobs`).
   */
  runner?: 'inline' | 'deferred' | JobRunner;
  /** Jobs the host defines, by name (plugin jobs are `{pluginId}.{name}` and come from the plugins). */
  handlers?: Record<string, JobDefinition<never>>;
  /** Inline runner: jobs running at once in this process. Default 4. */
  concurrency?: number;
}

/** `dr.jobs`. */
export interface Jobs {
  /** Enqueues a job for a tenant (committed at once) and hands it to the runner. */
  enqueue(
    tenantId: string,
    name: string,
    payload: Record<string, unknown>,
    options?: EnqueueOptions,
  ): Promise<JobEnvelope>;
  /** Executes one job: what a queue consumer calls with the id the runner sent. Safe to call more than once. */
  run(id: string): Promise<JobOutcome>;
  /** Runs due jobs from the table (`deferred` runners, cron routes, tests). */
  work(options?: { limit?: number; names?: readonly string[] }): Promise<{
    ran: number;
    completed: number;
    retried: number;
    failed: number;
  }>;
  /** Starts the runner's consumer in this process (`JobRunner.start`); a no-op for `inline` and `deferred`. */
  start(): Promise<void>;
  get(tenantId: string, id: string): Promise<JobRecord | null>;
  list(
    tenantId: string,
    options?: { status?: JobStatus | readonly JobStatus[]; name?: string; limit?: number },
  ): Promise<JobRecord[]>;
  /** Puts a failed or cancelled job back in the queue, due now, with a fresh set of attempts. */
  retry(tenantId: string, id: string): Promise<JobEnvelope>;
  /** Cancels a pending job; a running one finishes its attempt but is not retried. False when already finished. */
  cancel(tenantId: string, id: string): Promise<boolean>;
  /** Resolves when this process has no inline job running or queued (tests, graceful shutdown). */
  drain(): Promise<void>;
}

export interface JobsInternal {
  api: Jobs;
  /** Writes a job on `db` (an operation's transaction). `fresh` is false when a deduplication key matched. */
  insert(
    db: DatabaseAdapter,
    tenantId: string,
    name: string,
    payload: Record<string, unknown>,
    options?: EnqueueOptions,
  ): Promise<{ envelope: JobEnvelope; fresh: boolean }>;
  /** Hands committed jobs to the runner; failures are logged (maintenance recovers them). */
  dispatch(jobs: readonly JobEnvelope[]): Promise<void>;
  /** Maintenance: runs jobs the runner should have run by now. */
  recover(): Promise<number>;
  close(): Promise<void>;
}

const active: JobStatus[] = ['pending', 'running'];
const defaultLeaseMs = 5 * 60_000;
// Inline retries further out than this are left to maintain(), so a process does not hold long timers.
const maxTimerMs = 60 * 60_000;

const envelopeOf = (job: JobRecord): JobEnvelope => ({
  id: job.id,
  tenantId: job.tenantId,
  name: job.name,
  runAt: job.runAt,
});

const message = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 2000);

/** Collects job definitions from plugins and the host; names must be unique. */
export function jobDefinitions(
  plugins: readonly BetterFilesPlugin[],
  handlers: Record<string, JobDefinition<never>> = {},
) {
  const definitions = new Map<string, JobDefinition<never>>();
  const add = (name: string, definition: JobDefinition<never>) => {
    if (definitions.has(name)) throw invalidConfig(`Job ${name} is defined more than once`);
    if (typeof definition?.handler !== 'function')
      throw invalidConfig(`Job ${name} needs a handler`);
    definitions.set(name, definition);
  };
  for (const plugin of plugins)
    for (const [name, definition] of Object.entries(plugin.jobs ?? {})) {
      if (!/^[a-z][a-zA-Z0-9-]{0,63}$/.test(name))
        throw invalidConfig(`Plugin ${plugin.id}: invalid job name ${name}`);
      add(`${plugin.id}.${name}`, definition);
    }
  for (const [name, definition] of Object.entries(handlers)) {
    if (!/^[a-zA-Z][a-zA-Z0-9:_-]{0,63}$/.test(name))
      throw invalidConfig(`Invalid job name ${name}: host job names may not contain dots`);
    add(name, definition);
  }
  return definitions;
}

/** Runs jobs in this process: at once when due, on a timer when delayed, a few at a time. */
function inlineRunner(concurrency: number, clock: Clock, logger: Logger) {
  let run: ((id: string) => Promise<JobOutcome>) | undefined;
  const queue: string[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let running = 0;
  let idle: (() => void)[] = [];
  let closed = false;
  const settle = () => {
    if (running === 0 && queue.length === 0) for (const resolve of idle.splice(0)) resolve();
  };
  const pump = () => {
    while (run && !closed && running < concurrency && queue.length) {
      const id = queue.shift()!;
      running++;
      void run(id)
        .catch((error: unknown) =>
          logger.error('Better Files job failed', { id, error: message(error) }),
        )
        .finally(() => {
          running--;
          pump();
          settle();
        });
    }
    settle();
  };
  return {
    id: 'inline',
    bind(fn: (id: string) => Promise<JobOutcome>) {
      run = fn;
    },
    dispatch(jobs: readonly JobEnvelope[]) {
      if (closed) return;
      for (const job of jobs) {
        const delay = job.runAt - clock.now();
        if (delay <= 0) queue.push(job.id);
        else if (delay <= maxTimerMs) {
          const timer = setTimeout(() => {
            timers.delete(timer);
            queue.push(job.id);
            pump();
          }, delay);
          (timer as { unref?: () => void }).unref?.();
          timers.add(timer);
        }
      }
      pump();
    },
    drain: () =>
      running === 0 && queue.length === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => idle.push(resolve)),
    async close() {
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      queue.length = 0;
      if (running > 0) await new Promise<void>((resolve) => idle.push(resolve));
      idle = [];
    },
  };
}

export function createJobs(deps: {
  db: DatabaseAdapter;
  clock: Clock;
  logger: Logger;
  definitions: Map<string, JobDefinition<never>>;
  options: JobsOptions | undefined;
  /** The maintenance context; its `enqueue` is wired to this service. */
  maintenance(): MaintenanceContext;
}): JobsInternal {
  const { db, clock, logger, definitions } = deps;
  const choice = deps.options?.runner ?? 'inline';
  const inline =
    choice === 'inline' ? inlineRunner(deps.options?.concurrency ?? 4, clock, logger) : undefined;
  const runner: JobRunner | undefined =
    typeof choice === 'object' ? choice : choice === 'inline' ? inline : undefined;
  if (typeof choice === 'object' && typeof choice.dispatch !== 'function')
    throw invalidConfig('jobs.runner must be inline, deferred or a JobRunner');
  let started: Promise<void> | undefined;

  function definitionOf(name: string) {
    const definition = definitions.get(name);
    if (!definition) throw new BetterFilesError('INVALID_INPUT', `Unknown job ${name}`);
    return definition;
  }

  async function insert(
    target: DatabaseAdapter,
    tenantId: string,
    name: string,
    payload: Record<string, unknown>,
    options: EnqueueOptions = {},
  ) {
    const definition = definitionOf(name);
    const now = clock.now();
    return target.transaction(async (tx) => {
      if (options.key !== undefined) {
        const existing = await tx.findOne<JobRecord>('jobs', {
          tenantId,
          name,
          key: options.key,
          status: { in: active },
        });
        if (existing) return { envelope: envelopeOf(existing), fresh: false };
      }
      const record: JobRecord = {
        id: createId('job', now),
        tenantId,
        name,
        // Stored as JSON either way; normalizing here makes every adapter hand the handler the same thing.
        payload: JSON.parse(JSON.stringify(payload)) as Record<string, unknown>,
        status: 'pending',
        attempts: 0,
        maxAttempts: Math.max(1, options.maxAttempts ?? definition.maxAttempts ?? 5),
        runAt: options.runAt ?? now + Math.max(0, options.delayMs ?? 0),
        leaseUntil: 0,
        ...(options.key === undefined ? {} : { key: options.key }),
        createdAt: now,
        updatedAt: now,
      };
      await tx.insert('jobs', record);
      return { envelope: envelopeOf(record), fresh: true };
    });
  }

  async function dispatch(jobs: readonly JobEnvelope[]) {
    if (!runner || jobs.length === 0) return;
    try {
      await runner.dispatch(jobs);
    } catch (error) {
      logger.error('Better Files could not dispatch jobs; maintain() will run them', {
        ids: jobs.map((job) => job.id),
        error: message(error),
      });
    }
  }

  async function run(id: string): Promise<JobOutcome> {
    const now = clock.now();
    const job = await db.findOne<JobRecord>('jobs', { id });
    if (!job || !active.includes(job.status) || job.runAt > now || job.leaseUntil >= now)
      return { id, status: 'skipped' };
    const definition = definitions.get(job.name);
    if (!definition) {
      // A job whose plugin was removed: keep it, failed, rather than retrying it forever.
      await db.transaction((tx) =>
        tx.update(
          'jobs',
          { id, attempts: job.attempts },
          {
            status: 'failed',
            leaseUntil: 0,
            lastError: `No handler for ${job.name}`,
            finishedAt: now,
            updatedAt: now,
          },
        ),
      );
      return { id, status: 'failed', error: `No handler for ${job.name}` };
    }
    const attempt = job.attempts + 1;
    // Claim it: only one worker's update matches the attempt count and the expired lease it read.
    const claimed = await db.transaction((tx) =>
      tx.update(
        'jobs',
        { id, status: { in: active }, attempts: job.attempts, leaseUntil: job.leaseUntil },
        {
          status: 'running',
          attempts: attempt,
          leaseUntil: now + (definition.leaseMs ?? defaultLeaseMs),
          updatedAt: now,
        },
      ),
    );
    if (claimed !== 1) return { id, status: 'skipped' };
    const context: JobContext = {
      ...deps.maintenance(),
      tenantId: job.tenantId,
      job: { id, name: job.name, attempt, maxAttempts: job.maxAttempts },
    };
    try {
      await definition.handler(job.payload as never, context);
    } catch (error) {
      const finishedAt = clock.now();
      const failed = attempt >= job.maxAttempts;
      const runAt = finishedAt + Math.max(0, (definition.backoff ?? defaultJobBackoff)(attempt));
      const updated = await db.transaction((tx) =>
        tx.update(
          'jobs',
          { id, status: 'running', attempts: attempt },
          failed
            ? {
                status: 'failed',
                leaseUntil: 0,
                lastError: message(error),
                finishedAt,
                updatedAt: finishedAt,
              }
            : {
                status: 'pending',
                leaseUntil: 0,
                runAt,
                lastError: message(error),
                updatedAt: finishedAt,
              },
        ),
      );
      logger.warn(failed ? 'Better Files job failed' : 'Better Files job will be retried', {
        id,
        name: job.name,
        attempt,
        error: message(error),
      });
      if (failed) return { id, status: 'failed', error: message(error) };
      // Cancelled while it ran: nothing more to schedule.
      if (updated === 1) await dispatch([{ ...envelopeOf(job), runAt }]);
      return { id, status: 'retry', runAt, error: message(error) };
    }
    const finishedAt = clock.now();
    await db.transaction((tx) =>
      tx.update(
        'jobs',
        { id, status: 'running', attempts: attempt },
        { status: 'completed', leaseUntil: 0, finishedAt, updatedAt: finishedAt },
      ),
    );
    return { id, status: 'completed' };
  }
  inline?.bind(run);

  async function due(olderThanMs: number, limit: number, names?: readonly string[]) {
    const now = clock.now();
    return db.findMany<JobRecord>('jobs', {
      where: {
        status: { in: active },
        runAt: { lte: now - olderThanMs },
        leaseUntil: { lt: now },
        ...(names ? { name: { in: [...names] } } : {}),
      },
      orderBy: [{ field: 'runAt' }],
      limit,
    });
  }

  const api: Jobs = {
    async enqueue(tenantId, name, payload, options) {
      const { envelope, fresh } = await insert(db, tenantId, name, payload, options);
      if (fresh) await dispatch([envelope]);
      return envelope;
    },
    run,
    async work(options = {}) {
      const totals = { ran: 0, completed: 0, retried: 0, failed: 0 };
      for (const job of await due(0, options.limit ?? 100, options.names)) {
        const outcome = await run(job.id);
        if (outcome.status === 'skipped') continue;
        totals.ran++;
        if (outcome.status === 'completed') totals.completed++;
        else if (outcome.status === 'retry') totals.retried++;
        else totals.failed++;
      }
      return totals;
    },
    start() {
      started ??= Promise.resolve(runner?.start?.(run)).then(() => undefined);
      return started;
    },
    get: (tenantId, id) => db.findOne<JobRecord>('jobs', { id, tenantId }),
    list: (tenantId, options = {}) =>
      db.findMany<JobRecord>('jobs', {
        where: {
          tenantId,
          ...(options.status
            ? {
                status:
                  typeof options.status === 'string' ? options.status : { in: [...options.status] },
              }
            : {}),
          ...(options.name ? { name: options.name } : {}),
        },
        orderBy: [{ field: 'createdAt', direction: 'desc' }],
        limit: Math.min(options.limit ?? 100, 1000),
      }),
    async retry(tenantId, id) {
      const now = clock.now();
      const job = await db.findOne<JobRecord>('jobs', { id, tenantId });
      if (!job) throw new BetterFilesError('NOT_FOUND', 'Job not found');
      if (job.status !== 'failed' && job.status !== 'cancelled')
        throw new BetterFilesError('CONFLICT', `The job is ${job.status}`);
      await db.transaction((tx) =>
        tx.update(
          'jobs',
          { id, tenantId, status: job.status },
          {
            status: 'pending',
            attempts: 0,
            runAt: now,
            leaseUntil: 0,
            finishedAt: null,
            updatedAt: now,
          },
        ),
      );
      const envelope = { ...envelopeOf(job), runAt: now };
      await dispatch([envelope]);
      return envelope;
    },
    async cancel(tenantId, id) {
      const now = clock.now();
      const changed = await db.transaction((tx) =>
        tx.update(
          'jobs',
          { id, tenantId, status: { in: active } },
          { status: 'cancelled', finishedAt: now, updatedAt: now },
        ),
      );
      return changed === 1;
    },
    drain: () => inline?.drain() ?? Promise.resolve(),
  };

  return {
    api,
    insert,
    dispatch,
    async recover() {
      let ran = 0;
      for (const job of await due(runner?.recoverAfterMs ?? 0, 100))
        if ((await run(job.id)).status !== 'skipped') ran++;
      return ran;
    },
    async close() {
      await runner?.close?.();
    },
  };
}
