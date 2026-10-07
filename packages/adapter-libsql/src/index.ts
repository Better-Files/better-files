import { createClient, type Client, type InValue, type Transaction } from '@libsql/client';
import type { DatabaseAdapter } from '@better-files/core';
import { createSqlAdapter, Mutex, type SqlDriver, type SqlRow } from '@better-files/adapter-sql';

export interface LibsqlAdapterOptions {
  /** `file:local.db`, `libsql://…` (Turso) or `http://…` (sqld). Or pass an existing client. */
  url?: string;
  authToken?: string;
  client?: Client;
}

const args = (params: readonly unknown[]) => params.map((value) => value as InValue);
const rows = (result: { rows: unknown[]; columns: string[] }): SqlRow[] =>
  result.rows.map((row) => {
    const out: SqlRow = {};
    result.columns.forEach((column, index) => {
      out[column] = (row as Record<number, unknown>)[index];
    });
    return out;
  });

function driverFor(client: Client, tx: Transaction | undefined, mutex: Mutex): SqlDriver {
  // Only transactions are serialized; statements outside one never wait on the mutex, so they cannot deadlock.
  const run = (sql: string, params: readonly unknown[]) =>
    (tx ?? client).execute({ sql, args: args(params) });
  const driver: SqlDriver = {
    dialect: 'sqlite',
    async query(sql, params) {
      return rows(await run(sql, params));
    },
    async execute(sql, params) {
      return { rowsAffected: (await run(sql, params)).rowsAffected };
    },
    async transaction(fn) {
      if (tx) return fn(driver);
      return mutex.run(async () => {
        const transaction = await client.transaction('write');
        try {
          const result = await fn(driverFor(client, transaction, mutex));
          await transaction.commit();
          return result;
        } catch (error) {
          await transaction.rollback().catch(() => undefined);
          throw error;
        } finally {
          transaction.close();
        }
      });
    },
    isUniqueViolation(error) {
      const text = `${(error as { code?: unknown })?.code ?? ''} ${(error as Error)?.message ?? ''}`;
      return /SQLITE_CONSTRAINT/.test(text) && /UNIQUE|PRIMARY/.test(text);
    },
    async close() {
      client.close();
    },
  };
  return driver;
}

/** Better Files tables in libSQL: local files, Turso or sqld. */
export function libsqlAdapter(options: LibsqlAdapterOptions): DatabaseAdapter {
  const client =
    options.client ??
    createClient({
      url: options.url ?? 'file::memory:',
      ...(options.authToken ? { authToken: options.authToken } : {}),
    });
  return createSqlAdapter(driverFor(client, undefined, new Mutex()), { id: 'libsql' });
}
