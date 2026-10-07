import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import type { DatabaseAdapter } from '@better-files/core';
import { conformanceSchema, databaseConformanceCases } from '@better-files/core/conformance';
import { generateSchema } from '@better-files/adapter-sql';
import { prismaAdapter, type PrismaClientLike } from '@better-files/adapter-prisma';
import { drizzleAdapter } from '@better-files/adapter-drizzle';
import { pgliteAdapter } from '@better-files/adapter-pglite';
import { fixture } from '../fixtures.js';

/** A PrismaClient-shaped wrapper: raw queries and interactive transactions, as Prisma exposes them. */
function prismaOverPglite(
  db: PGlite | Parameters<Parameters<PGlite['transaction']>[0]>[0],
  root = true,
): PrismaClientLike {
  return {
    $queryRawUnsafe: async <T>(sql: string, ...values: unknown[]) =>
      (await db.query(sql, values)).rows as T,
    $executeRawUnsafe: async (sql: string, ...values: unknown[]) =>
      (await db.query(sql, values)).affectedRows ?? 0,
    ...(root
      ? {
          $transaction: <R>(fn: (tx: PrismaClientLike) => Promise<R>) =>
            (db as PGlite).transaction((tx) => fn(prismaOverPglite(tx, false))),
        }
      : {}),
  };
}

function prismaOverSqlite(db: Database.Database): PrismaClientLike {
  // SQLite has one writer: like Prisma, interactive transactions wait their turn.
  let queue: Promise<unknown> = Promise.resolve();
  const client: PrismaClientLike = {
    $queryRawUnsafe: async <T>(sql: string, ...values: unknown[]) =>
      db.prepare(sql).all(...values) as T,
    $executeRawUnsafe: async (sql: string, ...values: unknown[]) =>
      db.prepare(sql).run(...values).changes,
    $transaction: <R>(fn: (tx: PrismaClientLike) => Promise<R>) => {
      const run = queue.then(async () => {
        db.exec('BEGIN');
        try {
          const result = await fn({
            $queryRawUnsafe: client.$queryRawUnsafe,
            $executeRawUnsafe: client.$executeRawUnsafe,
          });
          db.exec('COMMIT');
          return result;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
  return client;
}

const adapters: [string, () => DatabaseAdapter][] = [
  [
    'prisma (postgresql via PGlite)',
    () => prismaAdapter({ client: prismaOverPglite(new PGlite()), provider: 'postgresql' }),
  ],
  [
    'prisma (sqlite)',
    () => prismaAdapter({ client: prismaOverSqlite(new Database(':memory:')), provider: 'sqlite' }),
  ],
  ['drizzle (pglite)', () => drizzleAdapter(drizzlePglite(new PGlite()))],
  ['drizzle (better-sqlite3)', () => drizzleAdapter(drizzleSqlite(new Database(':memory:')))],
];

for (const [name, create] of adapters)
  describe(`${name} conformance`, () => {
    for (const testCase of databaseConformanceCases())
      it(testCase.name, async () => {
        const db = create();
        await db.migrate(conformanceSchema);
        await testCase.run(db);
      });
  });

describe('generated schemas', () => {
  it('SQL DDL creates exactly the tables migrate expects', async () => {
    const f = await fixture();
    const ddl = generateSchema(f.dr.schema, { format: 'sql', dialect: 'postgres' });
    const client = new PGlite();
    await client.exec(ddl);
    const db = pgliteAdapter({ client });
    // Nothing left to create or alter.
    expect(await db.migrate(f.dr.schema)).toEqual({ applied: [] });
  });

  it('emits Prisma models and a Drizzle schema for every table', async () => {
    const f = await fixture();
    const tables = Object.values(f.dr.schema.tables);
    const prisma = generateSchema(f.dr.schema, { format: 'prisma', dialect: 'postgres' });
    expect(prisma.match(/^model /gm)).toHaveLength(tables.length);
    expect(prisma).toContain('@@map("better_files_rooms")');
    expect(prisma).toMatch(/model BetterFilesRooms \{\n {2}id String @id\n/);
    expect(prisma).toMatch(/settings Json\n/);
    expect(prisma).toMatch(
      /@@unique\(\[tenantId, slug\], map: "better_files_rooms_tenant_id_slug_key"\)/,
    );

    const drizzle = generateSchema(f.dr.schema, { format: 'drizzle', dialect: 'sqlite' });
    expect(drizzle).toContain("from 'drizzle-orm/sqlite-core'");
    expect(drizzle.match(/= sqliteTable\(/g)).toHaveLength(tables.length);
    expect(drizzle).toContain('id: text("id").primaryKey(),');
    expect(drizzle).toMatch(
      /uniqueIndex\("better_files_rooms_tenant_id_slug_key"\)\.on\(table\.tenantId, table\.slug\)/,
    );
  });
});
