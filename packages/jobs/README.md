# @better-files/jobs

Queue runners for Better Files jobs: run `dr.jobs` on **BullMQ** or **pg-boss** instead of in the web process.

Part of [Better Files](../../README.md). Most applications install `better-files` and import this
package as `better-files/jobs`.

## How it works

Better Files keeps every job in its own `jobs` table, written in the same transaction as the change that asked for it.
A runner only **delivers** jobs: after the transaction commits, it puts a message on the queue that names the job,
and the queue's worker calls `dr.jobs.run(id)`. Attempts, backoff, leases, failures and deduplication stay in
Better Files, so:

- the queue's own retries are off (one delivery per attempt; Better Files re-dispatches a retry with its new `runAt`);
- a message carries only `{ id, tenantId, name }`, never the payload, so Redis or the queue database holds no room data;
- running a job twice is harmless (the second run is `skipped`), so at-least-once delivery is fine;
- `dr.maintain()` runs any job the queue lost, once it has waited `recoverAfterMs` (5 minutes by default).

Neither queue library is a dependency: the runners take the host's own `Queue`, `Worker` or `PgBoss`.

## BullMQ

```ts
import { Queue, Worker } from 'bullmq';
import { bullmqRunner } from 'better-files/jobs';

const connection = { host: 'localhost', port: 6379 };
const queue = new Queue('better-files', { connection });

export const dr = betterFiles({
  // …
  jobs: {
    runner: bullmqRunner({
      queue,
      // Only in processes that call dr.jobs.start():
      worker: (processor) => new Worker('better-files', processor, { connection, concurrency: 8 }),
    }),
  },
});

// In the worker process (or every server):
await dr.jobs.start();
```

A worker the host builds elsewhere uses the processor directly:
`new Worker('better-files', bullmqProcessor(dr), { connection })`.

| Option           | Default                             |                                              |
| ---------------- | ----------------------------------- | -------------------------------------------- |
| `queue`          | required                            | Where jobs are added                         |
| `worker`         | none: this process only enqueues    | Creates the worker on `dr.jobs.start()`      |
| `keep`           | `{ completed: true, failed: 1000 }` | BullMQ's `removeOnComplete` / `removeOnFail` |
| `priority`       | none                                | BullMQ priority for Better Files jobs        |
| `recoverAfterMs` | 5 minutes                           | When `dr.maintain()` takes over a lost job   |
| `closeQueue`     | `false`                             | Also close `queue` on `dr.close()`           |

Each BullMQ job id is `{jobId}@{runAt}`, so a retry is a new BullMQ job rather than a duplicate of the finished one.

## pg-boss

```ts
import { PgBoss } from 'pg-boss';
import { pgBossRunner } from 'better-files/jobs';

const boss = await new PgBoss(process.env.DATABASE_URL!).start();

export const dr = betterFiles({
  // …
  jobs: { runner: pgBossRunner({ boss, work: { localConcurrency: 4 } }) },
});

await dr.jobs.start(); // in the processes that should work jobs
```

pg-boss can live in the same PostgreSQL database as Better Files (it uses its own schema). The runner creates its queue
(`better-files` by default) on first use; pass `createQueue: false` when the host manages queues. A worker registered
elsewhere uses the handler directly: `boss.work('better-files', pgBossHandler(dr))`.

| Option           | Default        |                                                           |
| ---------------- | -------------- | --------------------------------------------------------- |
| `boss`           | required       | A started `PgBoss`; the host stops it                     |
| `queue`          | `better-files` | The pg-boss queue                                         |
| `createQueue`    | `true`         | Create the queue on first use                             |
| `work`           | pg-boss's      | `batchSize`, `pollingIntervalSeconds`, `localConcurrency` |
| `priority`       | none           | pg-boss priority for Better Files jobs                    |
| `recoverAfterMs` | 5 minutes      | When `dr.maintain()` takes over a lost job                |

## Other queues

Any queue works with a few lines: implement `JobRunner` from `@better-files/core` (`dispatch` sends
`{ id }` with a delay of `runAt - now`, `start` consumes and calls `run(id)`), and set `recoverAfterMs`.
