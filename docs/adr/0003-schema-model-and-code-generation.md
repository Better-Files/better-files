# ADR-003: Schema model and code generation

- **Status:** Accepted
- **Date:** 2026-10-03
- **Plan:** PLAN.md §8.1, §8.3

## Context

Better Files runs on the host's database through several adapters: SQLite, PostgreSQL, libSQL, PGlite, Prisma, Drizzle
and memory. Hosts need to:

- add typed fields to core records, for example a deal code on rooms;
- rename tables to fit their conventions;
- let plugins own tables, the way better-auth and Better IAM plugins extend a schema;
- run migrations with their own tools (Prisma Migrate, drizzle-kit, plain SQL) or let Better Files apply them.

Writing DDL by hand for every adapter, plus the TypeScript types to match, would drift quickly.

## Decision

**One declarative schema model in core** (`packages/core/src/schema.ts`):

- Fields are built with `field.string | number | boolean | timestamp | json<T> | enum(values)`. Each field is required
  unless `{ required: false }`, and may be `unique`, `indexed`, reference another table, or set its own `columnName`.
- Tables are declared with `defineTable({ fields, indexes })`. `InferFields` derives the record type from the
  declaration, so types and DDL come from the same source.
- `resolveSchema` merges sources: the core tables, each plugin's `schema` (its own tables), each plugin's
  `extendSchema` (additional fields on existing tables), and the host's `schema` option (`tablePrefix`, per-table
  `tableName`, `additionalFields`).
- Physical names are `tablePrefix + snake_case(model)`. Columns are snake-cased.
- Duplicate tables or fields, extending or renaming an unknown table, and indexing an unknown field are configuration
  errors when `betterFiles()` builds.

**Additional fields are typed end to end.** `InferRecord` merges `schema.{model}.additionalFields` with every plugin's
`extendSchema`, so `dr.$Infer.Room`, `dr.api` inputs and outputs, and the client see them (ADR-005).

**Adapters are generic over the model.** The `DatabaseAdapter` port speaks in models and fields (`findOne`, `findMany`
with filter operators, `insert`, `update`, `delete`, `increment`, `transaction`, `migrate`). The SQL layer
(`packages/adapter-sql`) translates once for every SQL dialect. `databaseConformanceCases()` in core runs the same cases
on every adapter:

- round-trip of every field type, and null versus absent;
- filter operators, including escaping wildcards in `contains`;
- ordering, limit and offset;
- `CONFLICT` on unique fields, unique indexes and primary keys;
- update and delete counts;
- rollback, and nested transactions joining the outer one;
- refusing to change `id` or `tenantId`;
- idempotent `migrate`;
- atomic concurrent `increment`.

**Two ways to migrate.**

- `better-files generate --format sql|prisma|drizzle [--dialect]` emits files from the resolved schema, plugins and
  additional fields included (`generateSchema`, `packages/adapter-sql/src/generate.ts`). The host commits them and
  applies them with its own tool.
- `dr.initialize()` (and `better-files migrate`) applies the schema directly. It introspects the database, creates missing
  tables, adds missing columns as nullable, and creates missing indexes, all in one transaction.

## Consequences

- Adding a field or a plugin table is a declaration, not a migration file per dialect.
- Prisma and Drizzle users keep their own migration history. Better Files is just more models in their schema.
- Index names longer than PostgreSQL's 63-byte limit are shortened with a stable hash suffix, so generated names stay
  deterministic.
- Built-in migration is **additive only**. It never drops or retypes a column, and new columns are nullable even when
  the field is required, so existing rows stay valid. Destructive changes need a host-written migration.

## Status of the implementation (2026-10-03)

- There is no `migrations` table and no checksum. `migrate()` is idempotent introspection, not a versioned ledger. PLAN
  §8.1 lists a migrations table. A ledger becomes necessary once a release needs a data migration (backfills, column
  type changes) rather than an additive one.
- Column renames are per field (`columnName`) in plugin and core declarations. The host-level `fields: { name: 'title' }`
  rename map sketched in PLAN §8.3 is not implemented. Hosts can rename tables, not columns.
