import pg from 'pg';
import {
  createSqlAdapter,
  type PartitionOptions,
  type SqlDatabaseAdapter,
  type SqlDriver,
  type SqlRow,
} from '@better-files/adapter-sql';

export {
  partitionsPlugin,
  type PartitionInterval,
  type PartitionManager,
  type PartitionOptions,
  type PartitionSpec,
} from '@better-files/adapter-sql';

export interface PostgresAdapterOptions {
  /** A connection string, or an existing pool shared with the host application. */
  connectionString?: string;
  pool?: pg.Pool;
  poolSize?: number;
  /**
   * Range-partitioned tables by model name, typically `{ activity: { interval: 'month' } }`: old months can be
   * detached and archived, and queries on recent rows touch small partitions. New tables are created partitioned;
   * an existing table with rows is converted with `adapter.partitions.convert(model)`. Add `partitionsPlugin(adapter)`
   * so `dr.maintain()` creates partitions ahead of time.
   */
  partitions?: PartitionOptions;
}

interface Queryable {
  query(sql: string, params: unknown[]): Promise<{ rows: SqlRow[]; rowCount: number | null }>;
}

function driverFor(pool: pg.Pool, client: Queryable | undefined, ownsPool: boolean): SqlDriver {
  const target: Queryable = client ?? (pool as unknown as Queryable);
  const driver: SqlDriver = {
    dialect: 'postgres',
    async query(sql, params) {
      return (await target.query(sql, [...params])).rows;
    },
    async execute(sql, params) {
      return { rowsAffected: (await target.query(sql, [...params])).rowCount ?? 0 };
    },
    async transaction(fn) {
      if (client) return fn(driver);
      const connection = await pool.connect();
      try {
        await connection.query('BEGIN');
        const result = await fn(driverFor(pool, connection as unknown as Queryable, false));
        await connection.query('COMMIT');
        return result;
      } catch (error) {
        await connection.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    },
    isUniqueViolation: (error) => (error as { code?: unknown })?.code === '23505',
    async close() {
      if (ownsPool) await pool.end();
    },
  };
  return driver;
}

/** Better Files tables in PostgreSQL. Pass the host's pool to share connections with the rest of the app. */
export function postgresAdapter(options: PostgresAdapterOptions): SqlDatabaseAdapter {
  if (!options.pool && !options.connectionString)
    throw new Error('postgresAdapter needs a connectionString or a pool');
  const pool =
    options.pool ??
    new pg.Pool({ connectionString: options.connectionString, max: options.poolSize ?? 10 });
  return createSqlAdapter(driverFor(pool, undefined, !options.pool), {
    id: 'postgres',
    ...(options.partitions ? { partitions: options.partitions } : {}),
  });
}

export function postgresDriver(pool: pg.Pool): SqlDriver {
  return driverFor(pool, undefined, false);
}
