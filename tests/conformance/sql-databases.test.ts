import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, it } from 'vitest';
import type { DatabaseAdapter } from '@better-files/core';
import { conformanceSchema, databaseConformanceCases } from '@better-files/core/conformance';
import { sqliteAdapter } from '@better-files/adapter-sqlite';
import { libsqlAdapter } from '@better-files/adapter-libsql';
import { postgresAdapter } from '@better-files/adapter-postgres';
import { pgliteAdapter } from '@better-files/adapter-pglite';

const directory = mkdtempSync(join(tmpdir(), 'better-files-sql-'));
let counter = 0;
afterAll(() => {
  // Windows may still hold the WAL files briefly after close; a leftover temp folder is harmless.
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {}
});

const adapters: [string, () => DatabaseAdapter][] = [
  ['sqlite (memory)', () => sqliteAdapter({ filename: ':memory:' })],
  ['sqlite (file)', () => sqliteAdapter({ filename: join(directory, `db-${++counter}.sqlite`) })],
  // libSQL opens a new connection per transaction, so it needs a file even in tests.
  ['libsql (file)', () => libsqlAdapter({ url: `file:${join(directory, `lib-${++counter}.db`)}` })],
  // Real PostgreSQL (in WebAssembly): the PostgreSQL SQL path runs on every machine, not only in CI.
  ['pglite (postgres)', () => pgliteAdapter()],
];
const postgresUrl = process.env.BETTER_FILES_POSTGRES_URL;
if (postgresUrl)
  adapters.push([
    'postgres',
    () => {
      const adapter = postgresAdapter({ connectionString: postgresUrl });
      // Each case starts from empty tables.
      return adapter;
    },
  ]);

for (const [name, create] of adapters)
  describe(`${name} conformance`, () => {
    for (const testCase of databaseConformanceCases())
      it(testCase.name, async () => {
        const db = create();
        try {
          await db.migrate(conformanceSchema);
          if (name === 'postgres') await db.transaction((tx) => tx.delete('widgets', {}));
          await testCase.run(db);
        } finally {
          await db.close?.();
        }
      });
  });
