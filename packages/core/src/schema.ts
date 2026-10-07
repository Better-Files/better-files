import { invalidConfig } from './errors.js';

export type FieldType = 'string' | 'number' | 'boolean' | 'timestamp' | 'json' | 'enum';

/** A column in the Better Files schema. `T` is the TypeScript value type; `R` whether a value is required. */
export interface FieldDefinition<T = unknown, R extends boolean = boolean> {
  readonly type: FieldType;
  readonly required: R;
  readonly unique?: boolean;
  readonly indexed?: boolean;
  readonly values?: readonly string[];
  readonly references?: {
    readonly model: string;
    readonly field?: string;
    readonly onDelete?: 'cascade' | 'restrict' | 'set-null';
  };
  /** Physical column name; defaults to the field name in snake_case. */
  readonly columnName?: string;
  /** Phantom marker carrying `T`; never set at runtime. */
  readonly __type?: T;
}

export interface FieldOptions {
  unique?: boolean;
  indexed?: boolean;
  references?: FieldDefinition['references'];
  columnName?: string;
}
type RequiredOptions = FieldOptions & { required?: true };
type OptionalOptions = FieldOptions & { required: false };

// Overloads, not a generic `R`: inside a table literal the contextual type would otherwise widen `R` to `boolean`.
export interface FieldBuilder<T> {
  (options?: RequiredOptions): FieldDefinition<T, true>;
  (options: OptionalOptions): FieldDefinition<T, false>;
}
export interface JsonFieldBuilder {
  <T = unknown>(options?: RequiredOptions): FieldDefinition<T, true>;
  <T = unknown>(options: OptionalOptions): FieldDefinition<T, false>;
}
export interface EnumFieldBuilder {
  <const V extends readonly string[]>(
    values: V,
    options?: RequiredOptions,
  ): FieldDefinition<V[number], true>;
  <const V extends readonly string[]>(
    values: V,
    options: OptionalOptions,
  ): FieldDefinition<V[number], false>;
}

function define(
  type: FieldType,
  options: (FieldOptions & { required?: boolean }) | undefined,
  values?: readonly string[],
): FieldDefinition {
  const { required, ...rest } = options ?? {};
  return { type, required: required ?? true, ...rest, ...(values ? { values } : {}) };
}

const builder = <T>(type: FieldType) =>
  ((options?: FieldOptions & { required?: boolean }) => define(type, options)) as FieldBuilder<T>;

/** Field builders. Fields are required unless `{ required: false }` is passed. */
export const field = {
  string: builder<string>('string'),
  number: builder<number>('number'),
  boolean: builder<boolean>('boolean'),
  /** Epoch milliseconds, as Better IAM stores times. */
  timestamp: builder<number>('timestamp'),
  json: ((options?: FieldOptions & { required?: boolean }) =>
    define('json', options)) as JsonFieldBuilder,
  enum: ((values: readonly string[], options?: FieldOptions & { required?: boolean }) =>
    define('enum', options, values)) as EnumFieldBuilder,
};

export type Fields = Record<string, FieldDefinition>;

export interface IndexDefinition {
  fields: readonly string[];
  unique?: boolean;
}

export interface TableDefinition<F extends Fields = Fields> {
  fields: F;
  indexes?: readonly IndexDefinition[];
}

export const defineTable = <const F extends Fields>(
  table: TableDefinition<F>,
): TableDefinition<F> => table;

type Prettify<T> = { [K in keyof T]: T[K] } & {};
type FieldValue<D> = D extends FieldDefinition<infer T, boolean> ? T : never;
type RequiredKeys<F> = {
  [K in keyof F]: F[K] extends FieldDefinition<unknown, true> ? K : never;
}[keyof F];

/** The record type a set of fields describes. */
export type InferFields<F> = Prettify<
  { [K in RequiredKeys<F>]: FieldValue<F[K]> } & {
    [K in Exclude<keyof F, RequiredKeys<F>>]?: FieldValue<F[K]>;
  }
>;

/** Every table carries these; the schema model adds them, so tables never declare them. */
export const baseFields = {
  id: field.string(),
  tenantId: field.string({ indexed: true }),
  createdAt: field.timestamp(),
} as const;
export type BaseRecord = InferFields<typeof baseFields>;

export interface ResolvedField extends FieldDefinition {
  name: string;
  columnName: string;
}

export interface ResolvedTable {
  /** The logical name adapters are called with (`rooms`). */
  model: string;
  /** The physical table name (`better_files_rooms`). */
  tableName: string;
  /** `core` or the id of the plugin that declared the table. */
  source: string;
  fields: Record<string, ResolvedField>;
  indexes: IndexDefinition[];
}

export interface ResolvedSchema {
  tablePrefix: string;
  tables: Record<string, ResolvedTable>;
}

export interface TableCustomization {
  tableName?: string;
  additionalFields?: Fields;
}

export interface SchemaSource {
  source: string;
  tables?: Record<string, TableDefinition>;
  extend?: Record<string, { additionalFields: Fields }>;
}

const snakeCase = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const modelName = /^[a-z][a-zA-Z0-9]{0,47}$/;
const fieldName = /^[a-z][a-zA-Z0-9]{0,47}$/;

/**
 * Merges the core tables, plugin tables and additional fields into one schema. Collisions are configuration errors:
 * two sources may not declare the same table, and an additional field may not redefine an existing one.
 */
export function resolveSchema(
  sources: readonly SchemaSource[],
  options: { tablePrefix?: string; tables?: Record<string, TableCustomization | undefined> } = {},
): ResolvedSchema {
  const tablePrefix = options.tablePrefix ?? 'better_files_';
  if (!/^[a-z][a-z0-9_]{0,23}$/.test(tablePrefix) && tablePrefix !== '')
    throw invalidConfig(`Invalid table prefix ${tablePrefix}`);
  const tables: Record<string, ResolvedTable> = {};
  const addField = (table: ResolvedTable, name: string, definition: FieldDefinition) => {
    if (!fieldName.test(name)) throw invalidConfig(`Invalid field name ${table.model}.${name}`);
    if (table.fields[name])
      throw invalidConfig(`Field ${table.model}.${name} is declared more than once`);
    table.fields[name] = {
      ...definition,
      name,
      columnName: definition.columnName ?? snakeCase(name),
    };
  };
  for (const source of sources)
    for (const [model, definition] of Object.entries(source.tables ?? {})) {
      if (!modelName.test(model)) throw invalidConfig(`Invalid table name ${model}`);
      if (tables[model])
        throw invalidConfig(
          `Table ${model} from ${source.source} is already declared by ${tables[model].source}`,
        );
      const table: ResolvedTable = {
        model,
        tableName: options.tables?.[model]?.tableName ?? tablePrefix + snakeCase(model),
        source: source.source,
        fields: {},
        indexes: [...(definition.indexes ?? [])],
      };
      for (const [name, base] of Object.entries(baseFields)) addField(table, name, base);
      for (const [name, value] of Object.entries(definition.fields)) addField(table, name, value);
      tables[model] = table;
    }
  const extensions: [string, Fields][] = [
    ...sources.flatMap((source) =>
      Object.entries(source.extend ?? {}).map(
        ([model, e]) => [model, e.additionalFields] as [string, Fields],
      ),
    ),
    ...Object.entries(options.tables ?? {}).flatMap(([model, custom]) =>
      custom?.additionalFields ? [[model, custom.additionalFields] as [string, Fields]] : [],
    ),
  ];
  for (const [model, fields] of extensions) {
    const table = tables[model];
    if (!table) throw invalidConfig(`Cannot add fields to unknown table ${model}`);
    for (const [name, definition] of Object.entries(fields)) addField(table, name, definition);
  }
  for (const [model, custom] of Object.entries(options.tables ?? {}))
    if (!tables[model] && custom?.tableName)
      throw invalidConfig(`Cannot rename unknown table ${model}`);
  for (const table of Object.values(tables))
    for (const index of table.indexes)
      for (const name of index.fields)
        if (!table.fields[name])
          throw invalidConfig(`Index on ${table.model} references unknown field ${name}`);
  return { tablePrefix, tables };
}
