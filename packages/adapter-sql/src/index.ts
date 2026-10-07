import {
  conflict,
  BetterFilesError,
  invalidConfig,
  invalidInput,
  type Comparable,
  type DatabaseAdapter,
  type FieldFilter,
  type FindManyOptions,
  type MigrationResult,
  type ResolvedField,
  type ResolvedSchema,
  type ResolvedTable,
  type Where,
} from '@better-files/core';

export type SqlDialect = 'postgres' | 'sqlite';
export type SqlRow = Record<string, unknown>;

/**
 * The few things the SQL adapter needs from a database client. Drivers for better-sqlite3, pg and libSQL ship as
 * separate packages; wrapping another client (a Kysely or Drizzle connection, a serverless driver) takes ~30 lines.
 */
export interface SqlDriver {
  readonly dialect: SqlDialect;
  query(sql: string, params: readonly unknown[]): Promise<SqlRow[]>;
  execute(sql: string, params: readonly unknown[]): Promise<{ rowsAffected: number }>;
  /** Runs `fn` on one connection between BEGIN and COMMIT (ROLLBACK when it throws). */
  transaction<R>(fn: (driver: SqlDriver) => Promise<R>): Promise<R>;
  /** Maps a driver error to a uniqueness violation, which the adapter reports as CONFLICT. */
  isUniqueViolation(error: unknown): boolean;
  close?(): Promise<void>;
}

import { columnType, indexName, quote, tableIndexes } from './ddl.js';
import {
  finishPartitionedTable,
  partitionManager,
  preparePartitionedTable,
  resolvePartitions,
  type PartitionManager,
  type PartitionOptions,
} from './partitions.js';

export { generateSchema, type GenerateFormat, type GenerateOptions } from './generate.js';
export {
  intervalStart,
  partitionName,
  partitionsPlugin,
  type PartitionInfo,
  type PartitionInterval,
  type PartitionMaintenanceResult,
  type PartitionManager,
  type PartitionOptions,
  type PartitionSpec,
  type PartitionTableStatus,
} from './partitions.js';

export interface SqlAdapterOptions {
  id?: string;
  /** PostgreSQL only: range-partitioned tables by model name. See `PartitionSpec`. */
  partitions?: PartitionOptions;
}

/** A SQL `DatabaseAdapter`; `partitions` is there when the adapter was created with that option. */
export interface SqlDatabaseAdapter extends DatabaseAdapter {
  partitions?: PartitionManager;
}

interface Encoder {
  encode(field: ResolvedField, value: unknown): unknown;
  decode(field: ResolvedField, value: unknown): unknown;
}

function encoder(dialect: SqlDialect): Encoder {
  return {
    encode(field, value) {
      if (value === undefined || value === null) return null;
      if (field.type === 'boolean' && dialect === 'sqlite') return value ? 1 : 0;
      if (field.type === 'json') return JSON.stringify(value);
      return value;
    },
    decode(field, value) {
      if (value === null || value === undefined) return undefined;
      switch (field.type) {
        case 'boolean':
          return value === true || value === 1 || value === '1' || value === 't';
        case 'number':
        case 'timestamp':
          return typeof value === 'number' ? value : Number(value);
        case 'json':
          return typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
        default:
          return value;
      }
    },
  };
}

/** A `DatabaseAdapter` over any `SqlDriver`; passes `databaseConformanceCases()`. */
export function createSqlAdapter(
  driver: SqlDriver,
  options: SqlAdapterOptions = {},
): SqlDatabaseAdapter {
  let schema: ResolvedSchema | undefined;
  const partitionOptions =
    options.partitions && Object.keys(options.partitions).length ? options.partitions : undefined;
  if (partitionOptions && driver.dialect !== 'postgres')
    throw invalidConfig('Partitioned tables need PostgreSQL');
  const codec = encoder(driver.dialect);
  // PostgreSQL placeholders carry explicit casts, so drivers that send typed parameters (Prisma, some serverless
  // drivers) behave like node-postgres, which sends them untyped.
  const placeholder =
    driver.dialect === 'postgres'
      ? (index: number, cast = 'text') => `$${index}::${cast}`
      : (_index: number, _cast?: string) => '?';
  const castOf = (column: ResolvedField) =>
    column.type === 'json'
      ? 'jsonb'
      : column.type === 'number' || column.type === 'timestamp'
        ? 'double precision'
        : column.type === 'boolean'
          ? 'boolean'
          : 'text';

  const table = (model: string): ResolvedTable => {
    const found = schema?.tables[model];
    if (!found) throw invalidInput(`Unknown model ${model}`);
    return found;
  };
  const field = (definition: ResolvedTable, name: string): ResolvedField => {
    const found = definition.fields[name];
    if (!found) throw invalidInput(`Unknown field ${definition.model}.${name}`);
    return found;
  };
  const decodeRow = (definition: ResolvedTable, row: SqlRow) => {
    const out: Record<string, unknown> = {};
    for (const column of Object.values(definition.fields)) {
      const value = codec.decode(column, row[column.columnName]);
      if (value !== undefined) out[column.name] = value;
    }
    return out;
  };

  function whereClause(definition: ResolvedTable, where: Where = {}, params: unknown[]): string {
    const parts: string[] = [];
    const bind = (column: ResolvedField, value: unknown) => {
      params.push(codec.encode(column, value));
      return placeholder(params.length, castOf(column));
    };
    // A primary-key lookup is always the best plan, but without statistics SQLite may drive it from another index
    // (`tenant_id` matches every row of a single-tenant table: 18 ms instead of 0.5 ms for 500 ids in a 100,000-row
    // table). A unary `+` keeps the other terms from being used as index terms.
    const byId =
      driver.dialect === 'sqlite' &&
      where.id !== undefined &&
      (typeof where.id !== 'object' ||
        where.id === null ||
        where.id.eq !== undefined ||
        where.id.in !== undefined);
    for (const [name, filter] of Object.entries(where)) {
      const column = field(definition, name);
      const col = byId && name !== 'id' ? `+${quote(column.columnName)}` : quote(column.columnName);
      const clause = (op: string, value: Comparable | undefined) =>
        value === null
          ? `${col} IS ${op === '<>' ? 'NOT ' : ''}NULL`
          : `${col} ${op} ${bind(column, value)}`;
      if (typeof filter !== 'object' || filter === null) {
        parts.push(clause('=', filter as Comparable));
        continue;
      }
      const ops = filter as Exclude<FieldFilter, Comparable>;
      if (ops.eq !== undefined) parts.push(clause('=', ops.eq));
      if (ops.ne !== undefined)
        parts.push(
          ops.ne === null
            ? `${col} IS NOT NULL`
            : `(${col} IS NULL OR ${col} <> ${bind(column, ops.ne)})`,
        );
      if (ops.in !== undefined)
        parts.push(
          ops.in.length
            ? `${col} IN (${ops.in.map((item) => bind(column, item)).join(', ')})`
            : '1 = 0',
        );
      if (ops.notIn !== undefined && ops.notIn.length)
        parts.push(
          `(${col} IS NULL OR ${col} NOT IN (${ops.notIn.map((item) => bind(column, item)).join(', ')}))`,
        );
      if (ops.isNull !== undefined) parts.push(`${col} IS ${ops.isNull ? '' : 'NOT '}NULL`);
      if (ops.contains !== undefined) {
        const escaped = ops.contains.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`);
        params.push(`%${escaped}%`);
        parts.push(`LOWER(${col}) LIKE ${placeholder(params.length)} ESCAPE '\\'`);
      }
      if (ops.lt !== undefined) parts.push(`${col} < ${bind(column, ops.lt)}`);
      if (ops.lte !== undefined) parts.push(`${col} <= ${bind(column, ops.lte)}`);
      if (ops.gt !== undefined) parts.push(`${col} > ${bind(column, ops.gt)}`);
      if (ops.gte !== undefined) parts.push(`${col} >= ${bind(column, ops.gte)}`);
    }
    return parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
  }

  async function existingColumns(
    run: SqlDriver,
    tableName: string,
  ): Promise<Set<string> | undefined> {
    const rows =
      run.dialect === 'postgres'
        ? await run.query(
            'SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1',
            [tableName],
          )
        : await run.query(`PRAGMA table_info(${quote(tableName)})`, []);
    return rows.length ? new Set(rows.map((row) => String(row.name))) : undefined;
  }

  function adapter(run: SqlDriver, inTransaction: boolean): DatabaseAdapter {
    const writable = () => {
      if (!inTransaction)
        throw new BetterFilesError('INTERNAL_ERROR', 'Writes must run inside a transaction');
    };
    const guarded = async <R>(action: () => Promise<R>): Promise<R> => {
      try {
        return await action();
      } catch (error) {
        if (driver.isUniqueViolation(error))
          throw conflict('A record with these values already exists');
        throw error;
      }
    };
    const self: DatabaseAdapter = {
      id: options.id ?? `sql:${driver.dialect}`,
      bind(resolved) {
        schema = resolved;
      },
      async migrate(resolved) {
        schema = resolved;
        const applied: string[] = [];
        const partitioned = resolvePartitions(resolved, partitionOptions);
        const now = Date.now();
        await driver.transaction(async (tx) => {
          for (const definition of Object.values(resolved.tables)) {
            const columns = Object.values(definition.fields);
            let existing = await existingColumns(tx, definition.tableName);
            const partitionedTable = partitioned.get(definition.model);
            const outcome =
              partitionedTable && (await preparePartitionedTable(tx, partitionedTable, !!existing));
            if (outcome === 'created') {
              applied.push(definition.model);
              existing = new Set(columns.map((column) => column.columnName));
            }
            if (outcome === 'created' || outcome === 'partitioned') {
              for (const column of columns)
                if (!existing!.has(column.columnName)) {
                  await tx.execute(
                    `ALTER TABLE ${quote(definition.tableName)} ADD COLUMN ${quote(column.columnName)} ${columnType(tx.dialect, column)}`,
                    [],
                  );
                  if (!applied.includes(definition.model)) applied.push(definition.model);
                }
              await finishPartitionedTable(tx, partitionedTable!, now);
              continue;
            }
            if (!existing) {
              const body = columns.map((column) => {
                const parts = [quote(column.columnName), columnType(tx.dialect, column)];
                if (column.name === 'id') parts.push('PRIMARY KEY');
                else if (column.required) parts.push('NOT NULL');
                return parts.join(' ');
              });
              await tx.execute(
                `CREATE TABLE ${quote(definition.tableName)} (${body.join(', ')})`,
                [],
              );
              applied.push(definition.model);
            } else {
              let altered = false;
              for (const column of columns)
                if (!existing.has(column.columnName)) {
                  // Added columns are nullable: existing rows have no value for them.
                  await tx.execute(
                    `ALTER TABLE ${quote(definition.tableName)} ADD COLUMN ${quote(column.columnName)} ${columnType(tx.dialect, column)}`,
                    [],
                  );
                  altered = true;
                }
              if (altered) applied.push(definition.model);
            }
            for (const index of tableIndexes(definition)) {
              const names = index.fields.map((name) => field(definition, name).columnName);
              await tx.execute(
                `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${quote(indexName(definition.tableName, names, index.unique))} ON ${quote(definition.tableName)} (${names.map(quote).join(', ')})`,
                [],
              );
            }
          }
        });
        return { applied } satisfies MigrationResult;
      },
      async findOne<T>(model: string, where: Where) {
        const definition = table(model);
        const params: unknown[] = [];
        const rows = await run.query(
          `SELECT * FROM ${quote(definition.tableName)}${whereClause(definition, where, params)} LIMIT 1`,
          params,
        );
        return rows[0] ? (decodeRow(definition, rows[0]) as T) : null;
      },
      async findMany<T>(model: string, options: FindManyOptions = {}) {
        const definition = table(model);
        const params: unknown[] = [];
        const order = (options.orderBy?.length ? options.orderBy : [{ field: 'id' }]).map(
          (entry) =>
            `${quote(field(definition, entry.field).columnName)} ${entry.direction === 'desc' ? 'DESC' : 'ASC'}`,
        );
        let sql = `SELECT * FROM ${quote(definition.tableName)}${whereClause(definition, options.where, params)} ORDER BY ${order.join(', ')}`;
        if (options.limit !== undefined) {
          params.push(Math.max(0, Math.floor(options.limit)));
          sql += ` LIMIT ${placeholder(params.length, 'bigint')}`;
        } else if (options.offset) sql += driver.dialect === 'sqlite' ? ' LIMIT -1' : '';
        if (options.offset) {
          params.push(Math.max(0, Math.floor(options.offset)));
          sql += ` OFFSET ${placeholder(params.length, 'bigint')}`;
        }
        return (await run.query(sql, params)).map((row) => decodeRow(definition, row) as T);
      },
      async count(model, where) {
        const definition = table(model);
        const params: unknown[] = [];
        const rows = await run.query(
          `SELECT COUNT(*) AS count FROM ${quote(definition.tableName)}${whereClause(definition, where, params)}`,
          params,
        );
        return Number(rows[0]?.count ?? 0);
      },
      async insert<T extends object>(model: string, record: T) {
        writable();
        const definition = table(model);
        const entries = Object.entries(record).filter(([, value]) => value !== undefined);
        for (const [name] of entries) field(definition, name);
        for (const column of Object.values(definition.fields))
          if (column.required && (record as Record<string, unknown>)[column.name] === undefined)
            throw invalidInput(`${model}.${column.name} is required`);
        const params = entries.map(([name, value]) => codec.encode(field(definition, name), value));
        await guarded(() =>
          run.execute(
            `INSERT INTO ${quote(definition.tableName)} (${entries
              .map(([name]) => quote(field(definition, name).columnName))
              .join(
                ', ',
              )}) VALUES (${entries.map(([name], index) => placeholder(index + 1, castOf(field(definition, name)))).join(', ')})`,
            params,
          ),
        );
        return structuredClone(Object.fromEntries(entries)) as T;
      },
      async update(model, where, patch) {
        writable();
        if ('id' in patch || 'tenantId' in patch)
          throw invalidInput('id and tenantId cannot change');
        const definition = table(model);
        const entries = Object.entries(patch);
        if (entries.length === 0) return 0;
        const params: unknown[] = [];
        const assignments = entries.map(([name, value]) => {
          const column = field(definition, name);
          params.push(codec.encode(column, value));
          return `${quote(column.columnName)} = ${placeholder(params.length, castOf(column))}`;
        });
        const result = await guarded(() =>
          run.execute(
            `UPDATE ${quote(definition.tableName)} SET ${assignments.join(', ')}${whereClause(definition, where, params)}`,
            params,
          ),
        );
        return result.rowsAffected;
      },
      async increment(model, where, name, by = 1) {
        writable();
        const definition = table(model);
        const column = quote(field(definition, name).columnName);
        const params: unknown[] = [by];
        const filter = whereClause(definition, where, params);
        // UPDATE … RETURNING takes the row lock, so a concurrent transaction waits and then sees this value.
        const rows = await run.query(
          `UPDATE ${quote(definition.tableName)} SET ${column} = COALESCE(${column}, 0) + ${placeholder(1, 'double precision')}${filter} RETURNING ${column} AS value`,
          params,
        );
        if (rows.length > 1) throw invalidInput('increment must match exactly one row');
        return rows[0] ? Number(rows[0].value) : null;
      },
      async delete(model, where) {
        writable();
        const definition = table(model);
        const params: unknown[] = [];
        const result = await run.execute(
          `DELETE FROM ${quote(definition.tableName)}${whereClause(definition, where, params)}`,
          params,
        );
        return result.rowsAffected;
      },
      async transaction<R>(fn: (tx: DatabaseAdapter) => Promise<R>): Promise<R> {
        if (inTransaction) return fn(self);
        return driver.transaction((tx) => fn(adapter(tx, true)));
      },
      async close() {
        await driver.close?.();
      },
    };
    return self;
  }

  const root: SqlDatabaseAdapter = adapter(driver, false);
  if (partitionOptions) root.partitions = partitionManager(driver, partitionOptions, () => schema);
  return root;
}

/**
 * Serializes async work: SQLite has one writer, and a single connection must never interleave two transactions.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<R>(fn: () => Promise<R>): Promise<R> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
