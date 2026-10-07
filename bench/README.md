# Benchmarks

Kept out of `pnpm check` (seeding a 100,000-node room takes a few seconds), but typechecked with it.

| Command                                      | What it does                                                                                                                             |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm bench:targets`                         | Checks the PLAN's performance targets against a seeded room on SQLite and fails when one is missed                                       |
| `pnpm bench`                                 | Vitest comparisons (`*.bench.ts`), e.g. `resolveAccess` per path vs `createAccessIndex`                                                  |
| `BENCH_PROFILE=1 pnpm bench:targets profile` | Prints one listing query by query with SQLite's plan, then the top JavaScript functions by self time. Start here when a target regresses |

`BENCH_NODES` (default 100,000) shrinks the room for a quick run; `BENCH_P95_MS` (default 15) overrides the target for
slow machines.

## Targets

| Target (PLAN)                                                                 | Bench                                 | Windows laptop, Node 22 |
| ----------------------------------------------------------------------------- | ------------------------------------- | ----------------------- |
| §9.3: p95 under 15 ms for a 500-item folder listing, 100,000 nodes, 50 groups | `targets.test.ts`, guest in 50 groups | p95 7.3 ms              |
| same, room owner (admin floor)                                                | `targets.test.ts`, owner              | p95 5.5 ms              |

`large-room.ts` builds the room: top-level sections, ten subfolders each, 500 documents per subfolder, every group with a
cell on every section and a third of them with a deeper cell, written straight to the database in one transaction.
`bob` is invited through the API, so both authorization layers run.

## What the first run found (2026-10-03)

The listing started at p95 65 ms. In order of impact:

1. SQLite drove `documents WHERE tenant_id = ? AND id IN (…)` from the `tenant_id` index (one tenant matches every row)
   instead of the primary key: 18 ms per call. The SQL adapter now keeps other terms out of the index choice for
   primary-key lookups on SQLite.
2. The same 500 `documents` rows were fetched twice per listing (access engine and views). They now load once.
3. `children()` omitted `roomId`, so the `(tenantId, roomId, parentId)` index could not be used: 10 ms.
4. `folders.list` resolved the folder itself in a second pass, repeating the floor, closure and matrix queries.
5. The SQLite driver prepared every statement on each call; it now keeps an LRU cache of 256 statements.

Not covered yet (PLAN §17): upload throughput, watermark throughput, and the same targets on PostgreSQL.
