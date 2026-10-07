# ADR-005: Plugin contract and type inference

- **Status:** Accepted
- **Date:** 2026-10-03
- **Plan:** PLAN.md §3.2 (G4), §12.3, §14.1

## Context

Most of Better Files is optional: NDA, watermark, Q&A, e-signature, search, AI, sync and more. The core has to stay small,
and every optional feature has to plug in the same way a host's own extension would. Hosts also expect the
better-auth / Better IAM experience: add a plugin to the list, and `dr.api` and the browser client gain typed methods
with no code generation.

Better IAM plugins cannot own tables and give the client no typings (G2, G4), so Better Files cannot simply reuse that
contract.

## Decision

**A plugin is a plain object** (`BetterFilesPlugin`, `packages/core/src/plugin.ts`), declared with
`definePlugin(...)`. `definePlugin` returns its argument unchanged, but its `const` type parameter keeps the literal
id, endpoint inputs and outputs, and additional fields.

| Member                        | Purpose                                                                                                                                                               |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                          | API group name: `dr.api[id]`, `POST {base}/{id}/{method}`                                                                                                             |
| `schema`, `extendSchema`      | Own tables, and additional fields on core tables (ADR-003)                                                                                                            |
| `capabilities`                | Extension capability bits (16–30), allocated by the registry (ADR-001)                                                                                                |
| `actions`, `accessModel`      | IAM actions in the `better-files:` namespace, and which room relations may perform them                                                                               |
| `endpoints`                   | `endpoint({ operation, input, handler, target?, transaction?, … })`; each runs through the same two-layer pipeline as core endpoints                                  |
| `hooks`                       | `beforeUpload`, `afterUpload`, `beforeDownload`, `afterDownload`, `transformDownload`, `beforePermissionChange`, `onRoomStatusChange`, `clampCapabilities`, `retains` |
| `dependsOn`, `init`           | Ordering and one-time configuration checks when `betterFiles()` builds                                                                                                |
| `maintain`, `jobs`, `onEvent` | Host-scheduled work (`dr.maintain()`), durable jobs, and the event bus                                                                                                |

- Endpoint input accepts any [Standard Schema](https://standardschema.dev) validator (zod, valibot, arktype).
  Better Files depends on none of them.
- Hooks fail closed. A `before*` hook refuses by throwing a `BetterFilesError`. A download variant that no
  `transformDownload` hook produces is refused rather than served as the original. Any `retains` reason blocks
  deletion.
- `betterFiles()` validates plugins when it builds:
  - the id pattern, and that the id is not reserved (core group names, `files`, `health`, `downloads`);
  - every action is in the `better-files:` namespace;
  - room and node endpoints declare a `target`;
  - every `dependsOn` entry is registered.

**Types are inferred from the options object.** No code is generated.

- `betterFiles<const O>(options)` types `api` as `InferApi<O>` (`packages/server/src/infer.ts`). That is the core API
  merged with `{ [plugin.id]: { [name]: (credential, input & { tenantId }) => Promise<Output> } }` for every plugin in
  `options.plugins`.
- `dr.$Infer` is a type-only phantom. It exposes `Room`, `Node`, `Document`, `Version`, `Member`, `PermissionGroup` and
  `AclEntry` with the host's and every plugin's additional fields.
- `createBetterFilesClient<typeof dr>()` maps the same API for the browser: the credential is dropped (cookies or a
  bearer token carry it), and `tenantId` becomes optional. Calls go through a Proxy, so plugin groups need no runtime
  registration on the client. The UI bindings take the same type parameter: `createBetterFilesReact<typeof dr>()`,
  `createBetterFilesVue<typeof dr>()` and `createBetterFilesSvelte<typeof dr>()`.

**The IAM side is collected from the same plugin list.**

- `betterFilesIamPlugin({ plugins })` registers the union of core actions and every plugin's `actions`.
- `betterIamIntegration(iam).validate` merges each plugin's `accessModel` into the access-model policy. It throws at
  startup if any plugin action is missing from the IAM plugin, so a mismatch shows up at boot, not as a denied
  request.

## Consequences

- First-party plugins use exactly the contract available to hosts. Most features ship as separate
  `@better-files/plugin-*` packages, and an app pays nothing for plugins it does not import.
- Adding a plugin to `plugins: [...]` is the only step needed for typed server and client calls (closes G4 for
  Better Files).
- Inference depends on `const` type parameters and the plugin list being a literal tuple. A plugin list built
  dynamically (`plugins: someArray`) loses per-plugin typing. That is the same trade-off as better-auth.
- Type-checking cost grows with the number of plugins. PLAN §20 calls for a `tsc --extendedDiagnostics` benchmark in CI
  to keep it bounded.
- The plugin contract is now public API. Changes to `BetterFilesPlugin` or the hook signatures are breaking changes for
  hosts' own plugins, and need a changelog entry and a major or 0.x minor bump.

## Status of the implementation (2026-10-03)

- Plugins have no `migrations` member. Plugin tables migrate through the same additive schema path as core tables
  (ADR-003).
- `jobs` on plugins, with `context.enqueue`, is being added together with the durable job runner (PLAN §15).
