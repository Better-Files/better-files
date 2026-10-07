# @better-files/adapter-prisma

Runs the Better Files tables through your `PrismaClient` (PostgreSQL or SQLite): one connection pool, including
Accelerate and driver adapters, and one migration tool.

```sh
npx better-files generate --format prisma --out prisma/better-files.prisma   # paste into schema.prisma (or use prismaSchemaFolder)
npx prisma migrate dev --name better-files
```

```ts
import { PrismaClient } from '@prisma/client';
import { prismaAdapter } from 'better-files/adapter-prisma';

const prisma = new PrismaClient();
export const dr = betterFiles({
  database: prismaAdapter({ client: prisma, provider: 'postgresql' }),
  ...options,
});
```

- Why generate the models: Better Files tables that Prisma does not know about look like drift to `prisma migrate`,
  which then offers to reset the database. With the models in your schema, Prisma creates and keeps them.
  Regenerate after upgrading Better Files or changing plugins or additional fields.
- Queries go through `$queryRawUnsafe` / `$executeRawUnsafe` with bound parameters and explicit PostgreSQL casts;
  transactions are interactive (`$transaction`), 30 s timeout by default (`transaction: { timeout }`).
- Verified with the database conformance suite through a Prisma-shaped client on PGlite (PostgreSQL) and SQLite.

Part of [Better Files](../../README.md).
