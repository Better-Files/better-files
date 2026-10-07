import {
  invalidConfig,
  type ResolvedField,
  type ResolvedSchema,
  type ResolvedTable,
} from '@better-files/core';
import { columnType, indexName, quote, tableIndexes, type Dialect } from './ddl.js';
import {
  partitionedIndexes,
  partitionedTableDdl,
  resolvePartitions,
  type PartitionOptions,
} from './partitions.js';

export type GenerateFormat = 'sql' | 'prisma' | 'drizzle';

export interface GenerateOptions {
  format: GenerateFormat;
  dialect: Dialect;
  /**
   * PostgreSQL SQL only: tables created range-partitioned, with a default partition, as `postgresAdapter({ partitions
   * })` creates them. Its `partitions.maintain()` (or `partitionsPlugin`) then adds the ranges.
   */
  partitions?: PartitionOptions;
}

const pascal = (name: string) =>
  name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join('');
const camel = (name: string) => {
  const value = pascal(name);
  return value[0]!.toLowerCase() + value.slice(1);
};
const tables = (schema: ResolvedSchema) =>
  Object.values(schema.tables).sort((a, b) => a.tableName.localeCompare(b.tableName));
const nullable = (field: ResolvedField) => field.name !== 'id' && !field.required;

function sql(schema: ResolvedSchema, dialect: Dialect, partitions?: PartitionOptions): string {
  if (partitions && Object.keys(partitions).length && dialect !== 'postgres')
    throw invalidConfig('Partitioned tables need the postgres dialect');
  const partitioned = resolvePartitions(schema, partitions);
  const out: string[] = [];
  for (const table of tables(schema)) {
    const spec = partitioned.get(table.model)?.spec;
    if (spec) {
      out.push(...partitionedTableDdl(table, spec, { ifNotExists: true }).map((s) => `${s};`));
      for (const index of partitionedIndexes(table, spec.field)) {
        const names = index.fields.map((name) => table.fields[name]!.columnName);
        out.push(
          `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${quote(indexName(table.tableName, names, index.unique))} ON ${quote(table.tableName)} (${names.map(quote).join(', ')});`,
        );
      }
      out.push('');
      continue;
    }
    const columns = Object.values(table.fields).map((field) => {
      const parts = [quote(field.columnName), columnType(dialect, field)];
      if (field.name === 'id') parts.push('PRIMARY KEY');
      else if (field.required) parts.push('NOT NULL');
      return `  ${parts.join(' ')}`;
    });
    out.push(`CREATE TABLE IF NOT EXISTS ${quote(table.tableName)} (\n${columns.join(',\n')}\n);`);
    for (const index of tableIndexes(table)) {
      const names = index.fields.map((name) => table.fields[name]!.columnName);
      out.push(
        `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${quote(indexName(table.tableName, names, index.unique))} ON ${quote(table.tableName)} (${names.map(quote).join(', ')});`,
      );
    }
    out.push('');
  }
  return out.join('\n');
}

function prismaType(field: ResolvedField, dialect: Dialect): string {
  switch (field.type) {
    case 'number':
    case 'timestamp':
      return 'Float';
    case 'boolean':
      return 'Boolean';
    case 'json':
      // JSONB on PostgreSQL; JSON text on SQLite, where the adapter encodes it.
      return dialect === 'postgres' ? 'Json' : 'String';
    default:
      return 'String';
  }
}

function prisma(schema: ResolvedSchema, dialect: Dialect): string {
  const out: string[] = [];
  for (const table of tables(schema)) {
    const lines = Object.values(table.fields).map((field) => {
      const attributes = [
        ...(field.name === 'id' ? ['@id'] : []),
        ...(field.columnName !== field.name ? [`@map(${JSON.stringify(field.columnName)})`] : []),
      ];
      return `  ${field.name} ${prismaType(field, dialect)}${nullable(field) ? '?' : ''}${attributes.length ? ` ${attributes.join(' ')}` : ''}`;
    });
    for (const index of tableIndexes(table)) {
      const columns = index.fields.map((name) => table.fields[name]!.columnName);
      if (index.unique && index.fields.length === 1 && index.fields[0] === 'id') continue;
      lines.push(
        `  @@${index.unique ? 'unique' : 'index'}([${index.fields.join(', ')}], map: ${JSON.stringify(indexName(table.tableName, columns, index.unique))})`,
      );
    }
    lines.push(`  @@map(${JSON.stringify(table.tableName)})`);
    out.push(
      `/// Better Files (${table.source}): ${table.model}\nmodel ${pascal(table.tableName)} {\n${lines.join('\n')}\n}\n`,
    );
  }
  return out.join('\n');
}

function drizzleColumn(field: ResolvedField, dialect: Dialect): string {
  const name = JSON.stringify(field.columnName);
  let column: string;
  if (dialect === 'postgres')
    column =
      field.type === 'number' || field.type === 'timestamp'
        ? `doublePrecision(${name})`
        : field.type === 'boolean'
          ? `boolean(${name})`
          : field.type === 'json'
            ? `jsonb(${name})`
            : `text(${name})`;
  else
    column =
      field.type === 'number' || field.type === 'timestamp'
        ? `real(${name})`
        : field.type === 'boolean'
          ? `integer(${name}, { mode: 'boolean' })`
          : field.type === 'json'
            ? `text(${name}, { mode: 'json' })`
            : `text(${name})`;
  if (field.name === 'id') column += '.primaryKey()';
  else if (field.required) column += '.notNull()';
  return column;
}

function drizzle(schema: ResolvedSchema, dialect: Dialect): string {
  const core = dialect === 'postgres' ? 'pg-core' : 'sqlite-core';
  const tableFn = dialect === 'postgres' ? 'pgTable' : 'sqliteTable';
  const imports =
    dialect === 'postgres'
      ? ['pgTable', 'text', 'doublePrecision', 'boolean', 'jsonb', 'index', 'uniqueIndex']
      : ['sqliteTable', 'text', 'real', 'integer', 'index', 'uniqueIndex'];
  const out = [`import { ${imports.join(', ')} } from 'drizzle-orm/${core}';`, ''];
  for (const table of tables(schema) as ResolvedTable[]) {
    const columns = Object.values(table.fields).map(
      (field) => `    ${field.name}: ${drizzleColumn(field, dialect)},`,
    );
    const indexes = tableIndexes(table).map((index) => {
      const columnNames = index.fields.map((name) => table.fields[name]!.columnName);
      return `    ${index.unique ? 'uniqueIndex' : 'index'}(${JSON.stringify(indexName(table.tableName, columnNames, index.unique))}).on(${index.fields.map((name) => `table.${name}`).join(', ')}),`;
    });
    out.push(
      `/** Better Files (${table.source}): ${table.model} */`,
      `export const ${camel(table.tableName)} = ${tableFn}(`,
      `  ${JSON.stringify(table.tableName)},`,
      '  {',
      ...columns,
      '  },',
      ...(indexes.length ? ['  (table) => [', ...indexes, '  ],'] : []),
      ');',
      '',
    );
  }
  return out.join('\n');
}

const header: Record<GenerateFormat, (dialect: Dialect) => string> = {
  sql: (dialect) =>
    `-- Better Files tables (${dialect}). Generated by \`better-files generate\`; regenerate after upgrades or plugin changes.\n\n`,
  prisma: () =>
    '/// Better Files tables. Generated by `better-files generate --format prisma`: add them to schema.prisma so\n' +
    '/// `prisma migrate` owns (and does not drop) them. Better Files reads and writes them itself; do not edit rows by hand.\n\n',
  drizzle: () =>
    '// Better Files tables. Generated by `better-files generate --format drizzle`: export them from your schema so\n' +
    "// drizzle-kit owns (and does not drop) them, or exclude them with `tablesFilter: ['!better_files_*']`.\n",
};

/**
 * The Better Files tables (core, plugins, host fields) as SQL DDL, Prisma models or a Drizzle schema, for hosts whose
 * migration tool owns the database. `dr.initialize()` stays the simplest path; use this when a migration tool would
 * otherwise see the tables as drift.
 */
export function generateSchema(schema: ResolvedSchema, options: GenerateOptions): string {
  const body =
    options.format === 'sql'
      ? sql(schema, options.dialect, options.partitions)
      : options.format === 'prisma'
        ? prisma(schema, options.dialect)
        : drizzle(schema, options.dialect);
  return header[options.format](options.dialect) + body;
}
