import type { PGlite, Transaction } from '@electric-sql/pglite';
import {
  createSqlAdapter,
  type PartitionOptions,
  type SqlDatabaseAdapter,
  type SqlDriver,
  type SqlRow,
} from '@better-files/adapter-sql';

export { partitionsPlugin, type PartitionOptions } from '@better-files/adapter-sql';

export interface PgliteAdapterOptions {
  /** An existing PGlite instance, shared with the rest of the app. */
  client?: PGlite;
  /** Where a new instance keeps its data (`./pgdata`, `idb://better-files`); in memory when omitted. */
  dataDir?: string;
  /** Range-partitioned tables, as in `postgresAdapter`. */
  partitions?: PartitionOptions;
}

type Queryable = Pick<PGlite | Transaction, 'query'>;

// int8 results (counts) arrive as bigint; everything the adapter reads is a JS number.
const normalize = (rows: SqlRow[]) =>
  rows.map((row) => {
    for (const [key, value] of Object.entries(row))
      if (typeof value === 'bigint') row[key] = Number(value);
    return row;
  });

function driverFor(
  root: () => Promise<PGlite>,
  target: Queryable | undefined,
  owns: boolean,
): SqlDriver {
  const run = async () => target ?? (await root());
  const driver: SqlDriver = {
    dialect: 'postgres',
    async query(sql, params) {
      const result = await (await run()).query<SqlRow>(sql, [...params]);
      return normalize(result.rows);
    },
    async execute(sql, params) {
      const result = await (await run()).query(sql, [...params]);
      return { rowsAffected: result.affectedRows ?? 0 };
    },
    async transaction(fn) {
      // PGlite has one connection: inside a transaction, nested work joins it.
      if (target) return fn(driver);
      return (await root()).transaction((tx) => fn(driverFor(root, tx, false)));
    },
    isUniqueViolation: (error) => (error as { code?: unknown })?.code === '23505',
    async close() {
      if (owns) await (await root()).close();
    },
  };
  return driver;
}

/**
 * Better Files tables in PGlite, PostgreSQL compiled to WebAssembly: real PostgreSQL semantics with no server, for
 * local development, tests, single-process deployments and edge runtimes.
 */
export function pgliteAdapter(options: PgliteAdapterOptions = {}): SqlDatabaseAdapter {
  let instance: Promise<PGlite> | undefined = options.client
    ? Promise.resolve(options.client)
    : undefined;
  const root = () =>
    (instance ??= import('@electric-sql/pglite').then(({ PGlite }) =>
      PGlite.create(options.dataDir ? { dataDir: options.dataDir } : {}),
    ));
  return createSqlAdapter(driverFor(root, undefined, !options.client), {
    id: 'pglite',
    ...(options.partitions ? { partitions: options.partitions } : {}),
  });
}
