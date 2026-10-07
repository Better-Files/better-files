import {
  definePlugin,
  invalidConfig,
  type ResolvedField,
  type ResolvedSchema,
  type ResolvedTable,
} from '@better-files/core';
import { columnType, indexName, quote, tableIndexes } from './ddl.js';
import type { SqlDriver } from './index.js';

export type PartitionInterval = 'day' | 'week' | 'month' | 'year';

/** How one table is range-partitioned in PostgreSQL. */
export interface PartitionSpec {
  /** Partition length, in UTC. */
  interval: PartitionInterval;
  /** The timestamp field rows are partitioned by. Default `createdAt`. */
  field?: string;
  /** Partitions kept ready ahead of the current one, so writes never land in the default partition. Default 3. */
  premake?: number;
  /**
   * Partitions to keep, the current one included; older ones expire on `maintain()`. Default: keep everything. The
   * activity log is hash-chained, so expiring its partitions ends verification at the oldest partition kept.
   */
  retain?: number;
  /** What happens to expired partitions: `detach` (default) leaves a standalone table to archive; `drop` deletes it. */
  expire?: 'detach' | 'drop';
  /**
   * PostgreSQL requires unique indexes on a partitioned table to include the partition field, so uniqueness of the
   * other columns is no longer enforced on its own. Set this to accept that for a table with unique indexes. The core
   * `activity` table does not need it: its sequence comes from a locked per-room counter.
   */
  relaxUnique?: boolean;
}

/** Partitioned tables by model name (`activity`, or a plugin's table). */
export type PartitionOptions = Readonly<Record<string, PartitionSpec>>;

export interface PartitionInfo {
  name: string;
  /** Inclusive lower bound (epoch milliseconds); absent for the default partition. */
  from?: number;
  /** Exclusive upper bound. */
  to?: number;
  default: boolean;
}

export interface PartitionTableStatus {
  model: string;
  tableName: string;
  /** False when the table existed unpartitioned with rows before partitioning was configured: see `convert`. */
  partitioned: boolean;
  partitions: PartitionInfo[];
  /** Rows in the default partition (writes outside every range); `maintain()` moves them out. */
  defaultRows: number;
}

export interface PartitionMaintenanceResult {
  created: string[];
  /** Rows moved out of default partitions into ranges created for them. */
  moved: number;
  detached: string[];
  dropped: string[];
}

/** Partition upkeep for a PostgreSQL adapter: `adapter.partitions`. */
export interface PartitionManager {
  readonly options: PartitionOptions;
  /**
   * Creates the partitions `premake` asks for, gives rows in default partitions a range of their own and expires
   * partitions beyond `retain`. Idempotent; run it daily (`partitionsPlugin` runs it from `dr.maintain()`).
   */
  maintain(now?: number): Promise<PartitionMaintenanceResult>;
  status(): Promise<PartitionTableStatus[]>;
  /**
   * Rebuilds an existing unpartitioned table as a partitioned one, copying its rows, in one transaction. It locks the
   * table for the copy: run it in a maintenance window. Returns false when the table is already partitioned.
   */
  convert(model: string, now?: number): Promise<boolean>;
}

/** The start (UTC epoch ms) of the interval holding `at`, shifted by `offset` intervals. */
export function intervalStart(interval: PartitionInterval, at: number, offset = 0): number {
  const date = new Date(at);
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const d = date.getUTCDate();
  switch (interval) {
    case 'day':
      return Date.UTC(y, m, d + offset);
    case 'week': {
      // ISO weeks start on Monday.
      const weekday = (date.getUTCDay() + 6) % 7;
      return Date.UTC(y, m, d - weekday + offset * 7);
    }
    case 'month':
      return Date.UTC(y, m + offset, 1);
    case 'year':
      return Date.UTC(y + offset, 0, 1);
  }
}

const pad = (value: number, size = 2) => String(value).padStart(size, '0');

function suffix(interval: PartitionInterval, start: number): string {
  const date = new Date(start);
  const y = date.getUTCFullYear();
  const m = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  switch (interval) {
    case 'day':
    case 'week':
      return `p${y}${m}${d}`;
    case 'month':
      return `p${y}${m}`;
    case 'year':
      return `p${y}`;
  }
}

function hash(text: string): string {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  return (value >>> 0).toString(36);
}

/** `{table}_{suffix}`, kept under PostgreSQL's 63-byte limit like index names. */
export function partitionName(tableName: string, part: string): string {
  const name = `${tableName}_${part}`;
  return name.length <= 63
    ? name
    : `${tableName.slice(0, 62 - part.length - 8)}_${hash(tableName)}_${part}`;
}

/** Bounds as SQL literals: timestamps are DOUBLE PRECISION milliseconds. */
const literal = (value: number) => `'${value}'`;

interface Resolved {
  definition: ResolvedTable;
  spec: Required<Omit<PartitionSpec, 'retain'>> & Pick<PartitionSpec, 'retain'>;
  column: ResolvedField;
}

function resolve(definition: ResolvedTable, spec: PartitionSpec): Resolved {
  const fieldName = spec.field ?? 'createdAt';
  const column = definition.fields[fieldName];
  if (!column)
    throw invalidConfig(`Cannot partition ${definition.model}: it has no field ${fieldName}`);
  if (column.type !== 'timestamp' && column.type !== 'number')
    throw invalidConfig(`Cannot partition ${definition.model} by ${fieldName}: not a timestamp`);
  if (!column.required)
    throw invalidConfig(`Cannot partition ${definition.model} by ${fieldName}: it is optional`);
  const safeUnique = definition.model === 'activity' && definition.source === 'core';
  if (!spec.relaxUnique && !safeUnique) {
    const unique = tableIndexes(definition).find(
      (index) => index.unique && !index.fields.includes(fieldName),
    );
    if (unique)
      throw invalidConfig(
        `Partitioning ${definition.model} would stop enforcing its unique index on ${unique.fields.join(', ')} ` +
          'on its own (PostgreSQL requires the partition field in unique indexes); set relaxUnique to accept that',
      );
  }
  for (const [name, value] of [
    ['premake', spec.premake],
    ['retain', spec.retain],
  ] as const)
    if (value !== undefined && (!Number.isInteger(value) || value < (name === 'retain' ? 1 : 0)))
      throw invalidConfig(`partitions.${definition.model}.${name} must be a whole number`);
  return {
    definition,
    column,
    spec: {
      interval: spec.interval,
      field: fieldName,
      premake: spec.premake ?? 3,
      expire: spec.expire ?? 'detach',
      relaxUnique: spec.relaxUnique ?? safeUnique,
      ...(spec.retain !== undefined ? { retain: spec.retain } : {}),
    },
  };
}

/** Validates partition options against a schema; throws INVALID_CONFIG for unknown models or unsafe tables. */
export function resolvePartitions(
  schema: ResolvedSchema,
  options: PartitionOptions | undefined,
): Map<string, Resolved> {
  const out = new Map<string, Resolved>();
  for (const [model, spec] of Object.entries(options ?? {})) {
    const definition = schema.tables[model];
    if (!definition) throw invalidConfig(`Cannot partition unknown table ${model}`);
    out.set(model, resolve(definition, spec));
  }
  return out;
}

/** Index columns for a partitioned table: unique indexes gain the partition column, as PostgreSQL requires. */
export function partitionedIndexes(
  definition: ResolvedTable,
  fieldName: string,
): { fields: string[]; unique: boolean }[] {
  return tableIndexes(definition).map((index) =>
    index.unique && !index.fields.includes(fieldName)
      ? { fields: [...index.fields, fieldName], unique: true }
      : index,
  );
}

/** `CREATE TABLE … PARTITION BY RANGE` plus its default partition. */
export function partitionedTableDdl(
  definition: ResolvedTable,
  spec: { field: string },
  options: { ifNotExists?: boolean } = {},
): string[] {
  const partitionColumn = definition.fields[spec.field]!.columnName;
  const body = Object.values(definition.fields).map((column) => {
    const parts = [quote(column.columnName), columnType('postgres', column)];
    if (column.name === 'id' || column.required) parts.push('NOT NULL');
    return parts.join(' ');
  });
  // Named apart from the default `{table}_pkey`, which an unpartitioned table being converted still holds.
  body.push(
    `CONSTRAINT ${quote(partitionName(definition.tableName, 'ppkey'))} PRIMARY KEY (${quote(definition.fields.id!.columnName)}, ${quote(partitionColumn)})`,
  );
  const exists = options.ifNotExists ? 'IF NOT EXISTS ' : '';
  return [
    `CREATE TABLE ${exists}${quote(definition.tableName)} (${body.join(', ')}) PARTITION BY RANGE (${quote(partitionColumn)})`,
    `CREATE TABLE ${exists}${quote(partitionName(definition.tableName, 'default'))} PARTITION OF ${quote(definition.tableName)} DEFAULT`,
  ];
}

const BOUND = /FROM \('?([-\d.e+]+)'?\) TO \('?([-\d.e+]+)'?\)/i;

async function relkind(run: SqlDriver, tableName: string): Promise<string | undefined> {
  const rows = await run.query(
    'SELECT c.relkind AS kind FROM pg_class c WHERE c.oid = to_regclass($1::text)',
    [quote(tableName)],
  );
  return rows[0] ? String(rows[0].kind) : undefined;
}

async function listPartitions(run: SqlDriver, tableName: string): Promise<PartitionInfo[]> {
  const rows = await run.query(
    `SELECT c.relname AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
       FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = to_regclass($1::text)
      ORDER BY c.relname`,
    [quote(tableName)],
  );
  return rows.map((row) => {
    const bound = String(row.bound);
    const match = BOUND.exec(bound);
    return match
      ? { name: String(row.name), from: Number(match[1]), to: Number(match[2]), default: false }
      : { name: String(row.name), default: /DEFAULT/i.test(bound) };
  });
}

const defaultOf = (partitions: PartitionInfo[]) => partitions.find((p) => p.default);

/**
 * Creates the range partition for `[from, to)`. Rows the default partition already holds in that range move into it
 * first, since PostgreSQL refuses a new range that overlaps default rows.
 */
async function createRange(
  tx: SqlDriver,
  table: Resolved,
  from: number,
  to: number,
  defaultPartition: string | undefined,
): Promise<{ name: string; moved: number }> {
  const { definition, column } = table;
  const name = partitionName(definition.tableName, suffix(table.spec.interval, from));
  const col = quote(column.columnName);
  await tx.execute(
    `CREATE TABLE ${quote(name)} (LIKE ${quote(definition.tableName)} INCLUDING DEFAULTS)`,
    [],
  );
  let moved = 0;
  if (defaultPartition) {
    const range = `${col} >= ${literal(from)} AND ${col} < ${literal(to)}`;
    moved = (
      await tx.execute(
        `INSERT INTO ${quote(name)} SELECT * FROM ${quote(defaultPartition)} WHERE ${range}`,
        [],
      )
    ).rowsAffected;
    if (moved) await tx.execute(`DELETE FROM ${quote(defaultPartition)} WHERE ${range}`, []);
  }
  await tx.execute(
    `ALTER TABLE ${quote(definition.tableName)} ATTACH PARTITION ${quote(name)} FOR VALUES FROM (${literal(from)}) TO (${literal(to)})`,
    [],
  );
  return { name, moved };
}

/** Ranges from `first` to the interval `premake` after `now`, plus ranges for rows sitting in the default partition. */
async function ensureRanges(
  tx: SqlDriver,
  table: Resolved,
  now: number,
  result: PartitionMaintenanceResult,
) {
  const { definition, spec, column } = table;
  const partitions = await listPartitions(tx, definition.tableName);
  const fallback = defaultOf(partitions)?.name;
  const covered = (at: number) => partitions.some((p) => !p.default && p.from! <= at && at < p.to!);
  const wanted = new Set<number>();
  for (let offset = 0; offset <= spec.premake; offset++)
    wanted.add(intervalStart(spec.interval, now, offset));
  if (fallback) {
    // Every interval with rows in the default partition gets its own range.
    const rows = await tx.query(
      `SELECT DISTINCT ${quote(column.columnName)} AS at FROM ${quote(fallback)}`,
      [],
    );
    for (const row of rows) wanted.add(intervalStart(spec.interval, Number(row.at)));
  }
  for (const from of [...wanted].sort((a, b) => a - b)) {
    if (covered(from)) continue;
    const to = intervalStart(spec.interval, from, 1);
    // A hand-made range may overlap part of this interval; leave such rows in the default partition.
    if (partitions.some((p) => !p.default && p.from! < to && from < p.to!)) continue;
    // A partition detached by `retain` keeps its name as an archive table: never reuse it.
    const name = partitionName(definition.tableName, suffix(spec.interval, from));
    if (await relkind(tx, name)) continue;
    const created = await createRange(tx, table, from, to, fallback);
    partitions.push({ name: created.name, from, to, default: false });
    result.created.push(created.name);
    result.moved += created.moved;
  }
}

async function expireRanges(
  tx: SqlDriver,
  table: Resolved,
  now: number,
  result: PartitionMaintenanceResult,
) {
  const { definition, spec } = table;
  if (spec.retain === undefined) return;
  const oldest = intervalStart(spec.interval, now, -(spec.retain - 1));
  for (const partition of await listPartitions(tx, definition.tableName)) {
    if (partition.default || partition.to! > oldest) continue;
    await tx.execute(
      `ALTER TABLE ${quote(definition.tableName)} DETACH PARTITION ${quote(partition.name)}`,
      [],
    );
    if (spec.expire === 'drop') {
      await tx.execute(`DROP TABLE ${quote(partition.name)}`, []);
      result.dropped.push(partition.name);
    } else result.detached.push(partition.name);
  }
}

async function createIndexes(tx: SqlDriver, table: Resolved) {
  const { definition, spec } = table;
  for (const index of partitionedIndexes(definition, spec.field)) {
    const names = index.fields.map((name) => definition.fields[name]!.columnName);
    await tx.execute(
      `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${quote(indexName(definition.tableName, names, index.unique))} ON ${quote(definition.tableName)} (${names.map(quote).join(', ')})`,
      [],
    );
  }
}

/**
 * The first step of `migrate` for a table in the partitions option: creates it partitioned when missing, and rebuilds
 * an empty unpartitioned one (partitioning configured after the first migration). A table with rows is left alone
 * (`unpartitioned`) until `partitions.convert()`. Added columns and indexes follow as for any table.
 */
export async function preparePartitionedTable(
  tx: SqlDriver,
  table: Resolved,
  existing: boolean,
): Promise<'created' | 'partitioned' | 'unpartitioned'> {
  const { definition } = table;
  if (existing) {
    if ((await relkind(tx, definition.tableName)) === 'p') return 'partitioned';
    const rows = await tx.query(`SELECT 1 AS one FROM ${quote(definition.tableName)} LIMIT 1`, []);
    if (rows.length) return 'unpartitioned';
    await tx.execute(`DROP TABLE ${quote(definition.tableName)}`, []);
  }
  for (const statement of partitionedTableDdl(definition, table.spec))
    await tx.execute(statement, []);
  return 'created';
}

/** The last step of `migrate` for a partitioned table: its indexes, and the ranges `premake` asks for. */
export async function finishPartitionedTable(tx: SqlDriver, table: Resolved, now: number) {
  await createIndexes(tx, table);
  await ensureRanges(tx, table, now, { created: [], moved: 0, detached: [], dropped: [] });
}

/** Builds `adapter.partitions` over a driver; `schema` is read lazily, after `migrate` or `bind`. */
export function partitionManager(
  driver: SqlDriver,
  options: PartitionOptions,
  schema: () => ResolvedSchema | undefined,
): PartitionManager {
  const tables = () => {
    const resolved = schema();
    if (!resolved) throw invalidConfig('The database has no schema yet: run dr.initialize() first');
    return resolvePartitions(resolved, options);
  };
  return {
    options,
    async maintain(now = Date.now()) {
      const result: PartitionMaintenanceResult = {
        created: [],
        moved: 0,
        detached: [],
        dropped: [],
      };
      for (const table of tables().values())
        await driver.transaction(async (tx) => {
          if ((await relkind(tx, table.definition.tableName)) !== 'p') return;
          await ensureRanges(tx, table, now, result);
          await expireRanges(tx, table, now, result);
        });
      return result;
    },
    async status() {
      const out: PartitionTableStatus[] = [];
      for (const [model, table] of tables()) {
        const { tableName } = table.definition;
        const partitioned = (await relkind(driver, tableName)) === 'p';
        const partitions = partitioned ? await listPartitions(driver, tableName) : [];
        const fallback = defaultOf(partitions);
        const defaultRows = fallback
          ? Number(
              (await driver.query(`SELECT COUNT(*) AS count FROM ${quote(fallback.name)}`, []))[0]
                ?.count ?? 0,
            )
          : 0;
        out.push({ model, tableName, partitioned, partitions, defaultRows });
      }
      return out;
    },
    async convert(model, now = Date.now()) {
      const table = tables().get(model);
      if (!table) throw invalidConfig(`${model} is not in the partitions option`);
      const { tableName } = table.definition;
      return driver.transaction(async (tx) => {
        const kind = await relkind(tx, tableName);
        if (kind === 'p') return false;
        if (!kind) throw invalidConfig(`${tableName} does not exist: run dr.initialize() first`);
        const old = partitionName(tableName, 'unpartitioned');
        await tx.execute(`ALTER TABLE ${quote(tableName)} RENAME TO ${quote(old)}`, []);
        // Old index names would collide with the new table's: drop them with the old table at the end.
        for (const statement of partitionedTableDdl(table.definition, table.spec))
          await tx.execute(statement, []);
        const columns = Object.values(table.definition.fields)
          .map((column) => quote(column.columnName))
          .join(', ');
        await tx.execute(
          `INSERT INTO ${quote(tableName)} (${columns}) SELECT ${columns} FROM ${quote(old)}`,
          [],
        );
        await tx.execute(`DROP TABLE ${quote(old)}`, []);
        await createIndexes(tx, table);
        await ensureRanges(tx, table, now, { created: [], moved: 0, detached: [], dropped: [] });
        return true;
      });
    },
  };
}

/**
 * Runs `adapter.partitions.maintain()` from `dr.maintain()`, so new partitions exist before they are needed:
 * `plugins: [partitionsPlugin(database)]`.
 */
export function partitionsPlugin(database: { partitions?: PartitionManager }) {
  return definePlugin({
    id: 'partitions',
    init() {
      if (!database.partitions)
        throw invalidConfig(
          'partitionsPlugin needs a PostgreSQL adapter created with a partitions option',
        );
    },
    async maintain(context) {
      const result = await database.partitions!.maintain(context.now);
      if (result.created.length || result.detached.length || result.dropped.length || result.moved)
        context.logger.info?.('better-files: partitions maintained', { ...result });
    },
  });
}
