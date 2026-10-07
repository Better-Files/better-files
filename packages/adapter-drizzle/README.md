# @better-files/adapter-drizzle

Runs the Better Files tables on your drizzle database and its connection: node-postgres (`Pool`), postgres.js, PGlite,
better-sqlite3 or libSQL/Turso.

```sh
npx better-files generate --format drizzle --out src/db/better-files-schema.ts
npx drizzle-kit generate && npx drizzle-kit migrate
```

```ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { drizzleAdapter } from 'better-files/adapter-drizzle';

export const db = drizzle(pool);
export const dr = betterFiles({ database: drizzleAdapter(db), ...options });
```

- Export the generated tables from your schema so drizzle-kit creates and keeps them, or leave Better Files to create
  them (`dr.initialize()`) and exclude them from drizzle-kit with `tablesFilter: ['!better_files_*']`.
- The adapter recognizes the client behind `db.$client` and reuses the matching Better Files SQL driver, so behavior is
  identical to the direct adapters. node-postgres needs a `Pool` (transactions need their own connection).
- Verified with the database conformance suite on drizzle over PGlite and better-sqlite3.

Part of [Better Files](../../README.md).
