# ADR-001: Two-layer authorization

- **Status:** Accepted
- **Date:** 2026-10-03
- **Plan:** PLAN.md §3.2 (G1, G8), §9

## Context

A data room is a deep tree of folders and documents. Each bidder group can have its own grant on any folder. A
grant can be narrowed lower down, or locked so nothing below it can change it.

Better IAM is the host's identity and policy system. It is the obvious place for this, but it has two limits:

- **G1.** Relations inherit one level only (`resource.relations` plus `resource.parentRelations`), and a managed type
  cannot be its own parent. A folder ten levels deep cannot inherit a grant from the room root through IAM tuples.
- **G8.** Every decision loads all of the tenant's tuples. Per-folder tuples for every group in every room would make
  each check slower as the tenant grows.

The host's administrators still need their IAM tools for room access: policies (MFA, IP ranges, device, guests,
risk), access reviews and `whoCan`.

## Decision

Every protected operation must pass two layers.

**Layer A is the Better Files engine.** It owns the folder and document permission matrix.

- Rights are a capability bitmask (`Capability`, `packages/core/src/capabilities.ts`). Bits 0–9 are built in (LIST
  … MANAGE). Bits 16–30 are for plugins and configuration, handed out by `createCapabilityRegistry`, which refuses
  reused bits.
- `acl_entries` rows grant a mask to a subject (`identity:`, `group:` or `link:`) on a node.
- The reference resolver is `resolveAccess` in `packages/core/src/acl.ts`. For each subject, the nearest explicit entry
  on the path wins, unless a shallower entry is `locked`; a locked entry is final for its whole subtree. Expired
  entries are ignored. Masks for all of the caller's subjects are combined with a union. A caller who lacks LIST on any
  ancestor gets nothing.
- `createAccessEngine` in `packages/server/src/access.ts` loads the ancestor path from `node_closure` and the entries
  for that path. It ORs in the room-role floor (`better-files:admin` gives everything; `better-files:activity:export` gives
  LIST and VIEW). It then removes bits with clamps:
  - room state: closed, archived and provisioning rooms lose UPLOAD, EDIT and DELETE;
  - room settings: `downloadsEnabled` and `printEnabled`;
  - document flags: `viewOnly`, `noPrint` and `noCopy`;
  - plugin `clampCapabilities` hooks, such as an NDA not yet accepted or a quarantined version.
- **Delegation ceiling.** A caller cannot grant a mask larger than their own effective mask on that node
  (`assertCeiling`, `packages/server/src/endpoints/people.ts`).

**Layer B is the identity system.** It goes through the `AuthzProvider` port, and Better IAM by default.

- It decides who is in the room, in which role, and under which conditions.
- Room roles are tuples on `better-files-room/{roomId}`. Permission groups are IAM groups. Room security settings compile into
  IAM policies.
- Folders and documents are application-owned resources (`better-files-folder`, `better-files-document`), which
  `betterFilesResolver` describes to IAM.

**One table maps operations to both layers.** `operationMatrix` in `packages/core/src/operations.ts` gives each
`group.method` its IAM action, its target kind (`tenant`, `room`, `node` or `public`), its required capabilities and
whether it mutates. Endpoints reference matrix entries by key, so an unmapped endpoint does not type-check.

**Order in the pipeline** (`runEndpoint`, `packages/server/src/pipeline.ts`):

1. Validate the input, then authenticate.
2. For node targets:
   - load the node and room, and refuse writes to a closed room;
   - run layer A: no LIST answers `NOT_FOUND`, so nothing leaks; missing bits answer `FORBIDDEN`.
3. Run layer B: `authz.authorize(credential, { action, resource })`.
4. Run the handler, inside a transaction when the operation mutates.

Room and tenant targets get layer B only. `public` operations (ticket redemption) skip both, because the ticket is the
credential.

## Consequences

- Deep trees, per-folder overrides and locked subtrees cost one closure lookup and one indexed entry query. They do not
  depend on IAM's tuple count.
- IAM tuples stay coarse: room-level roles with group subjects. This keeps IAM's global write lock and its per-check
  tuple scan affordable (G8).
- Host policies still apply to every operation. A deny in IAM (wrong IP, no MFA, high risk, guest boundary) wins even
  when the matrix allows. The matrix cannot grant what IAM refuses.
- There are two places to reason about. `capabilitiesFor` and `resolveForIam` expose the engine's answer, so UIs and
  IAM's `whoCan` can show it. At room level, IAM and the engine agree.
- The boundary sits behind the `AuthzProvider` port. When Better IAM gains N-level relations and indexed tuple loading
  (§19 items 1–2), more of layer A can move into IAM without changing endpoints.

## Status of the implementation (2026-10-03)

- The resolver runs in memory over rows fetched by the adapter. PLAN §9.3 describes a single SQL query using the
  closure table and window functions; it does not exist yet. The comment in `acl.ts` says SQL adapters are checked
  against the reference by the conformance suite, but `databaseConformanceCases()` has no ACL case today.
- Tests in `tests/core/acl.test.ts` cover the rules, plus one seeded randomized check (adding a subject never removes
  access). Generated-tree property tests are in progress in `tests/core/acl-property.test.ts`.
- No test yet asserts that every mounted route maps to a matrix entry. Today that rests on the type-checked keys.
- The room-role floor calls `authorizeMany` from inside layer A. That is deliberate: IAM is the authority for room roles
  (ADR-002). It does mean layer A is not purely local.
