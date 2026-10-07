# @better-files/adapter-postgres

PostgreSQL database adapter for Better Files, via pg.

Part of [Better Files](../../README.md). Most applications install `better-files` and import this package through its subpaths.

```ts
import { postgresAdapter } from 'better-files/adapter-postgres';

const database = postgresAdapter({ pool }); // or { connectionString }
```

## Partitioned tables

The activity log only grows. Range-partition it by month so queries on recent activity read small partitions, and old
months can be detached and archived:

```ts
import { partitionsPlugin, postgresAdapter } from 'better-files/adapter-postgres';

const database = postgresAdapter({
  pool,
  partitions: { activity: { interval: 'month', premake: 3 } },
});
const dr = betterFiles({ database, plugins: [partitionsPlugin(database), ...plugins], ... });
```

- `dr.initialize()` creates the table as `PARTITION BY RANGE (created_at)` with a default partition, plus the current
  interval and `premake` intervals ahead of it.
- `dr.maintain()` (through `partitionsPlugin`) creates the next ranges before they are needed. Rows that landed in the
  default partition meanwhile get a range of their own and move into it.
- `retain: 12` keeps 12 intervals, the current one included. Older partitions are detached as ordinary tables named
  `{table}_p{yyyymm}`, ready to dump and archive, or dropped with `expire: 'drop'`. The activity log is hash-chained,
  so `activity.verify` then reports breaks at the oldest partition kept. Archive before you expire.
- An existing table with rows is not changed by `initialize()`. Convert it once, in a maintenance window, with
  `await database.partitions.convert('activity')`. This copies the rows into a partitioned table in one transaction.
- `database.partitions.status()` lists each table's partitions and how many rows sit in its default partition.

Any table with a required timestamp field can be partitioned, including a plugin's own tables, with `interval` set to
`day`, `week`, `month` or `year`. PostgreSQL requires unique indexes on a partitioned table to include the partition
column, so a table with other unique indexes (such as `outbox`) is refused unless you set `relaxUnique: true` and accept
that weaker guarantee. The core `activity` table does not need this, because each room's sequence comes from a
locked counter.

`better-files generate` users can pass the same `partitions` to `generateSchema({ format: 'sql', dialect: 'postgres',
partitions })` so the generated DDL matches.

The same option works on `pgliteAdapter`.
