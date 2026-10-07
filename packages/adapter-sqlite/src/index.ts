import Database from 'better-sqlite3';
import type { DatabaseAdapter } from '@better-files/core';
import { createSqlAdapter, Mutex, type SqlDriver, type SqlRow } from '@better-files/adapter-sql';

export interface SqliteAdapterOptions {
  /** A file path, or `:memory:`. */
  filename: string;
  /** Milliseconds to wait for a lock held by another process. Default 5000. */
  busyTimeoutMs?: number;
  /** Default `wal` for files, so readers do not block the writer. */
  journalMode?: 'wal' | 'delete' | 'truncate' | 'persist' | 'memory' | 'off';
}

type BetterSqlite = InstanceType<typeof Database>;
type Statement = Database.Statement<unknown[]>;

/**
 * Prepared statements by SQL text, least recently used evicted first. The adapter builds the same few statements
 * over and over (a 500-item listing spends ~0.8 ms preparing otherwise); SQLite re-prepares a cached statement by
 * itself after a schema change.
 */
function statementCache(db: BetterSqlite, size = 256): (sql: string) => Statement {
  const cache = new Map<string, Statement>();
  return (sql) => {
    let statement = cache.get(sql);
    if (statement) cache.delete(sql);
    else {
      statement = db.prepare<unknown[]>(sql);
      if (cache.size >= size) cache.delete(cache.keys().next().value!);
    }
    cache.set(sql, statement);
    return statement;
  };
}

function driverFor(
  db: BetterSqlite,
  mutex: Mutex,
  inTransaction: boolean,
  prepare = statementCache(db),
): SqlDriver {
  // better-sqlite3 is synchronous, so single statements never interleave. Only transactions take the mutex: two
  // async transactions on one connection must not overlap. (Reads never wait on it, so they cannot deadlock.)
  const guard = <R>(fn: () => R): Promise<R> => Promise.resolve().then(fn);
  const driver: SqlDriver = {
    dialect: 'sqlite',
    query(sql, params) {
      return guard(() => {
        const statement = prepare(sql);
        return statement.reader
          ? (statement.all(...params) as SqlRow[])
          : (statement.run(...params), []);
      });
    },
    execute(sql, params) {
      return guard(() => ({ rowsAffected: prepare(sql).run(...params).changes }));
    },
    async transaction(fn) {
      if (inTransaction) return fn(driver);
      return mutex.run(async () => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const result = await fn(driverFor(db, mutex, true, prepare));
          db.exec('COMMIT');
          return result;
        } catch (error) {
          if (db.inTransaction) db.exec('ROLLBACK');
          throw error;
        }
      });
    },
    isUniqueViolation(error) {
      const code = (error as { code?: unknown })?.code;
      return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
    },
    async close() {
      await mutex.run(async () => db.close());
    },
  };
  return driver;
}

/** Better Files tables in SQLite via better-sqlite3. Use the same file as Better IAM or a separate one. */
export function sqliteAdapter(options: SqliteAdapterOptions): DatabaseAdapter {
  const db = new Database(options.filename);
  db.pragma(`busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs ?? 5000))}`);
  if (options.filename !== ':memory:') db.pragma(`journal_mode = ${options.journalMode ?? 'wal'}`);
  db.pragma('foreign_keys = ON');
  return createSqlAdapter(driverFor(db, new Mutex(), false), { id: 'sqlite' });
}

/** The raw driver, for composing with other SQLite tooling or custom migrations. */
export function sqliteDriver(db: BetterSqlite): SqlDriver {
  return driverFor(db, new Mutex(), false);
}
