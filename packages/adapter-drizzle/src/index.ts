import type {
  DatabaseAdapter,
  FindManyOptions,
  MigrationResult,
  ResolvedSchema,
  Where,
} from '@better-files/core';
import { createSqlAdapter, type SqlDriver, type SqlRow } from '@better-files/adapter-sql';

/** A drizzle database: `drizzle(client)` exposes the underlying client as `$client`. */
export interface DrizzleLike {
  $client: unknown;
}

type Client = Record<string, unknown>;
const has = (client: Client, ...methods: string[]) =>
  methods.every((name) => typeof client[name] === 'function');

/** postgres.js (`postgres`), common with Drizzle on Supabase, Neon and Vercel. */
function postgresJsDriver(sql: Client, inTransaction = false): SqlDriver {
  type Unsafe = (query: string, params: unknown[]) => Promise<SqlRow[] & { count?: number }>;
  const unsafe = (sql.unsafe as Unsafe).bind(sql);
  const driver: SqlDriver = {
    dialect: 'postgres',
    async query(query, params) {
      const rows = await unsafe(query, [...params]);
      return [...rows].map((row) => {
        for (const [key, value] of Object.entries(row))
          if (typeof value === 'bigint') row[key] = Number(value);
        return row;
      });
    },
    async execute(query, params) {
      return { rowsAffected: (await unsafe(query, [...params])).count ?? 0 };
    },
    async transaction(fn) {
      if (inTransaction) return fn(driver);
      type Begin = <R>(fn: (tx: Client) => Promise<R>) => Promise<R>;
      return (sql.begin as Begin)((tx) => fn(postgresJsDriver(tx, true)));
    },
    isUniqueViolation: (error) => (error as { code?: unknown })?.code === '23505',
  };
  return driver;
}

async function resolve(client: Client): Promise<DatabaseAdapter> {
  if (has(client, 'prepare', 'pragma')) {
    const { sqliteDriver } = await import('@better-files/adapter-sqlite');
    return createSqlAdapter(sqliteDriver(client as never), { id: 'drizzle:better-sqlite3' });
  }
  if (has(client, 'execute', 'batch', 'transaction')) {
    const { libsqlAdapter } = await import('@better-files/adapter-libsql');
    return libsqlAdapter({ client: client as never });
  }
  if (has(client, 'query', 'exec', 'transaction') && 'waitReady' in client) {
    const { pgliteAdapter } = await import('@better-files/adapter-pglite');
    return pgliteAdapter({ client: client as never });
  }
  if (has(client, 'unsafe', 'begin'))
    return createSqlAdapter(postgresJsDriver(client), { id: 'drizzle:postgres-js' });
  if (has(client, 'connect', 'query') && 'totalCount' in client) {
    const { postgresDriver } = await import('@better-files/adapter-postgres');
    return createSqlAdapter(postgresDriver(client as never), { id: 'drizzle:node-postgres' });
  }
  if (has(client, 'connect', 'query'))
    throw new Error(
      'drizzleAdapter needs a pg Pool, not a single pg Client: transactions need their own connection',
    );
  throw new Error(
    'drizzleAdapter: unsupported drizzle client (supported: node-postgres, postgres.js, PGlite, better-sqlite3, libSQL)',
  );
}

/**
 * Better Files tables on the host's drizzle database and its connection. Generate the table definitions with
 * `better-files generate --format drizzle` and export them from your schema so drizzle-kit keeps them.
 */
export function drizzleAdapter(db: DrizzleLike): DatabaseAdapter {
  if (!db || typeof db !== 'object' || !db.$client)
    throw new Error('drizzleAdapter expects a drizzle database');
  let schema: ResolvedSchema | undefined;
  let resolved: Promise<DatabaseAdapter> | undefined;
  const inner = () =>
    (resolved ??= resolve(db.$client as Client).then((adapter) => {
      if (schema) adapter.bind?.(schema);
      return adapter;
    }));
  return {
    id: 'drizzle',
    bind(next) {
      schema = next;
    },
    migrate: async (next: ResolvedSchema): Promise<MigrationResult> => {
      schema = next;
      return (await inner()).migrate(next);
    },
    findOne: async (model: string, where: Where) => (await inner()).findOne(model, where),
    findMany: async (model: string, options?: FindManyOptions) =>
      (await inner()).findMany(model, options),
    count: async (model: string, where?: Where) => (await inner()).count(model, where),
    insert: async (model, record) => (await inner()).insert(model, record),
    update: async (model, where, patch) => (await inner()).update(model, where, patch),
    increment: async (model, where, field, by) =>
      (await inner()).increment(model, where, field, by),
    delete: async (model, where) => (await inner()).delete(model, where),
    transaction: async (fn) => (await inner()).transaction(fn),
    close: async () => {
      // The host owns the connection; closing it is theirs to do.
    },
  } as DatabaseAdapter;
}
