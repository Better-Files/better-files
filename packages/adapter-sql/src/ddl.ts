import type { ResolvedField, ResolvedTable } from '@better-files/core';

export type Dialect = 'postgres' | 'sqlite';

export const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

export function columnType(dialect: Dialect, field: ResolvedField): string {
  switch (field.type) {
    case 'number':
    case 'timestamp':
      return dialect === 'postgres' ? 'DOUBLE PRECISION' : 'REAL';
    case 'boolean':
      return dialect === 'postgres' ? 'BOOLEAN' : 'INTEGER';
    case 'json':
      return dialect === 'postgres' ? 'JSONB' : 'TEXT';
    default:
      return 'TEXT';
  }
}

function hash(text: string): string {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  return (value >>> 0).toString(36);
}

/** Index names are limited to 63 bytes in PostgreSQL; long ones keep a readable prefix and a hash. */
export function indexName(table: string, columns: readonly string[], unique: boolean): string {
  const name = `${table}_${columns.join('_')}_${unique ? 'key' : 'idx'}`;
  return name.length <= 63 ? name : `${name.slice(0, 54)}_${hash(name)}`;
}

/** Declared indexes plus single-column `unique` and `indexed` fields, by logical field name. */
export function tableIndexes(definition: ResolvedTable): { fields: string[]; unique: boolean }[] {
  const columns = Object.values(definition.fields);
  return [
    ...definition.indexes.map((index) => ({
      fields: [...index.fields],
      unique: index.unique === true,
    })),
    ...columns
      .filter((column) => column.unique)
      .map((column) => ({ fields: [column.name], unique: true })),
    ...columns
      .filter((column) => column.indexed && !column.unique)
      .map((column) => ({ fields: [column.name], unique: false })),
  ];
}
