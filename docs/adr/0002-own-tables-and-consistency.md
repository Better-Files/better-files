# ADR-002: Own tables, and consistency with the identity system

- **Status:** Accepted
- **Date:** 2026-10-03
- **Plan:** PLAN.md §2 principle 4, §3.2 (G2, G3), §8.1, §10.6

## Context

Better IAM plugins keep their data as JSON rows in one shared table, with a fixed index set and a global write lock
(G2). Their endpoints are JSON POST only, capped at 64 KB (G3). A data room writes far more than that: nodes, versions,
blobs, upload parts, ACL entries and per-view activity. It also needs streaming routes and indexed queries over trees.

IAM still has to own the facts that its policies and access reviews depend on: whether a room exists as a resource,
its role tuples, its groups and guests, its keys, and the security audit.

The two stores cannot share a transaction. Even in the same database, IAM's adapter does not expose its handle.

## Decision

**Better Files keeps its own tables, behind its own `DatabaseAdapter` port.**

- The core tables are rooms, nodes, node closure, documents, versions, blobs, renditions, uploads, upload parts,
  permission groups, ACL entries, members, activity, tickets, exports and outbox. They are declared with the schema
  model (ADR-003).
- Physical names have the prefix `better_files_` by default. The tables can sit in the host's database or in a separate
  one.
- Every table has `id`, `tenantId` and `createdAt`. Every lookup passes `tenantId` in its `where`, so an id from another
  tenant is simply not found. Adapters refuse to change `id` or `tenantId` on update; the conformance suite checks this.

**IAM is authoritative for membership.**

- Room roles are IAM tuples. Permission-group membership is IAM group membership, read from `principal.groups` at
  request time.
- The `members` table is the room's roster for listings and engagement data. Access decisions do not trust it.

**Cross-store writes are ordered so failures leave nothing usable.** Room creation (`rooms.create`,
`transaction: 'manual'`) works like this:

1. One transaction inserts the room as `provisioning` together with its root folder.
2. Outside any transaction: register `better-files-room/{id}` in IAM, grant the owner tuple, create the room key.
3. A second transaction moves the room to `draft`, stores the key id, adds the owner member and records activity.
4. On any failure, the rows are deleted, and the IAM resource too if it was registered.

Deletion runs in reverse order: IAM groups and resource, then rows and blobs, then the room key is retired (ADR-004).

**Inconsistent states fail closed.**

- A `provisioning` room answers `NOT_FOUND`, is left out of `rooms.list`, and gets the write clamp.
- A room that IAM does not know is denied by layer B (ADR-001).
- IAM writes that must follow a commit are queued with `context.afterCommit` and run after the transaction succeeds.

**Drift is found and repaired out of band.** `better-files reconcile` compares IAM resources, tuples and groups with
rooms, members and permission groups. It reports missing or lingering relations and memberships, orphan relations,
unregistered rooms and rooms stuck in `provisioning`. It can repair them (`--repair`, `--revoke-orphans`).
`better-files doctor` checks the secret, plugins, a database read, a storage round-trip and a data-key round-trip.

## Consequences

- High-volume data gets real indexes and transactions, and never takes IAM's global write lock.
- The host can join Better Files tables in its own queries, because they live in its database.
- A crash between steps can leave a room in `provisioning`, or an IAM tuple without a member row. Because access fails
  closed, this is a liveness problem, never an exposure. The reconciler cleans it up.
- When Better IAM gains a shared-transaction hook (§19 item 5), the ordered writes can collapse into one transaction
  for hosts that keep both in one database.

## Status of the implementation (2026-10-03)

- The `outbox` table is declared but nothing reads or writes it yet, and there is no dispatcher. After-commit IAM writes
  log their failures, and the reconciler catches the drift. A durable outbox, or using the jobs table now in progress,
  would let these retry with idempotency keys as PLAN §10.6 describes.
- Reconciliation is a CLI command (`reconcileIam` in `packages/cli`). There is no `dr.reconcile()` on the instance yet.
- Tenant isolation is a convention enforced in code review and tests, not by the adapter injecting a filter.
