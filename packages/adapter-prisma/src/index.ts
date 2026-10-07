import type { DatabaseAdapter } from '@better-files/core';
import { createSqlAdapter, type SqlDriver, type SqlRow } from '@better-files/adapter-sql';

/** The part of a `PrismaClient` (or an interactive transaction client) Better Files uses. */
export interface PrismaClientLike {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $transaction?: unknown;
}

type InteractiveTransaction = <R>(
  fn: (tx: PrismaClientLike) => Promise<R>,
  options?: { maxWait?: number; timeout?: number },
) => Promise<R>;

export interface PrismaAdapterOptions {
  client: PrismaClientLike;
  /** The datasource provider. */
  provider: 'postgresql' | 'sqlite';
  /** Interactive transaction limits. Defaults: wait 5 s for a connection, 30 s to finish. */
  transaction?: { maxWait?: number; timeout?: number };
}

const normalize = (rows: unknown) =>
  (Array.isArray(rows) ? (rows as SqlRow[]) : []).map((row) => {
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === 'bigint') row[key] = Number(value);
      // Decimal.js values from numeric columns.
      else if (
        value &&
        typeof value === 'object' &&
        'toNumber' in value &&
        typeof value.toNumber === 'function'
      )
        row[key] = (value as { toNumber(): number }).toNumber();
    }
    return row;
  });

function uniqueViolation(error: unknown): boolean {
  const e = error as {
    code?: unknown;
    meta?: { code?: unknown; message?: unknown };
    message?: unknown;
  };
  if (e?.code === 'P2002') return true;
  const text = `${String(e?.meta?.code ?? '')} ${String(e?.meta?.message ?? '')} ${String(e?.message ?? '')}`;
  return /\b23505\b|UNIQUE constraint failed|duplicate key value/i.test(text);
}

function driverFor(
  client: PrismaClientLike,
  options: PrismaAdapterOptions,
  inTransaction: boolean,
): SqlDriver {
  const driver: SqlDriver = {
    dialect: options.provider === 'postgresql' ? 'postgres' : 'sqlite',
    async query(sql, params) {
      return normalize(await client.$queryRawUnsafe(sql, ...params));
    },
    async execute(sql, params) {
      return { rowsAffected: await client.$executeRawUnsafe(sql, ...params) };
    },
    async transaction(fn) {
      // A transaction client has no $transaction: nested work joins the open transaction.
      if (inTransaction || typeof client.$transaction !== 'function') return fn(driver);
      return (client.$transaction as InteractiveTransaction)(
        (tx) => fn(driverFor(tx, options, true)),
        {
          maxWait: options.transaction?.maxWait ?? 5_000,
          timeout: options.transaction?.timeout ?? 30_000,
        },
      );
    },
    isUniqueViolation: uniqueViolation,
  };
  return driver;
}

/**
 * Better Files tables through the host's PrismaClient: one connection pool (Accelerate and driver adapters included)
 * and one migration tool. Generate the models with `better-files generate --format prisma` and add them to
 * schema.prisma so `prisma migrate` creates and keeps the tables; `dr.initialize()` is then a no-op check.
 */
export function prismaAdapter(options: PrismaAdapterOptions): DatabaseAdapter {
  return createSqlAdapter(driverFor(options.client, options, false), {
    id: `prisma:${options.provider}`,
  });
}
