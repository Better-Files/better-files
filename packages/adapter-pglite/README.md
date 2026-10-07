# @better-files/adapter-pglite

Better Files on [PGlite](https://pglite.dev): PostgreSQL compiled to WebAssembly, with no server. Use it for local
development and tests with the same SQL as production PostgreSQL, single-process deployments, and edge runtimes.

```ts
import { pgliteAdapter } from 'better-files/adapter-pglite';

betterFiles({ database: pgliteAdapter({ dataDir: './.better-files-db' }), ...options }); // in memory when omitted
betterFiles({ database: pgliteAdapter({ client: existingPglite }), ...options }); // share an instance
```

The Better Files test suite runs the database conformance cases and a full engine flow on it, so the PostgreSQL path
is exercised on every machine, not only where a PostgreSQL server is available.

Part of [Better Files](../../README.md).
