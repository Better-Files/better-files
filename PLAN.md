# Better Files: Library Build Plan

> **Better Files is an embeddable TypeScript library for adding secure data rooms to your own application.** It works the same way Better IAM works for identity: you install it, call a factory with your database and storage, and mount it into your Next.js, NestJS, Express, Hono, Fastify, Nuxt, SvelteKit or React Router app. It gives you the building blocks behind Dropbox-style file sharing and DocuSign Rooms / Datasite-style deal rooms: rooms, folders, versions, permission matrices, guests, NDA gating, watermarking, secure viewing, audit trails, Q&A and e-signature. **Better IAM** handles identity and authorization.
>
> It is **not** a SaaS product, a hosted service or a web app. There is no dashboard to deploy. Your app is the product; Better Files is the engine inside it.

**Status:** Phases 0–4 largely built; see [Implementation status](#implementation-status-2026-09-26). **Runtime:** Node.js 22.12+. **Databases:** PostgreSQL, SQLite, libSQL/Turso, or your existing Kysely / Drizzle / Prisma client. **License:** Apache-2.0, to match Better IAM.

```sh
npm install better-files better-iam
```

```ts
import { betterFiles } from 'better-files';
import { betterIamIntegration } from 'better-files/iam';
import { postgresAdapter } from 'better-files/adapter-postgres';
import { s3Storage } from 'better-files/storage-s3';
import { iam } from './iam';

export const dr = betterFiles({
  iam: betterIamIntegration(iam),
  database: postgresAdapter({ connectionString: process.env.DATABASE_URL! }),
  storage: s3Storage({ bucket: 'my-app-files', region: 'eu-west-1' }),
  plugins: [ndaPlugin(), watermarkPlugin(), qaPlugin()],
});
```

```ts
// app/api/better-files/[...path]/route.ts  (Next.js)
import { createBetterFilesNext } from 'better-files/next';
export const { GET, POST, PUT, OPTIONS } = createBetterFilesNext(dr).handlers();
```

---

## Table of contents

1. [Goals and non-goals](#1-goals-and-non-goals)
2. [Design principles](#2-design-principles)
3. [Better IAM: what we reuse, and its gaps](#3-better-iam-what-we-reuse-and-its-gaps)
4. [How it fits into a host app](#4-how-it-fits-into-a-host-app)
5. [Monorepo layout](#5-monorepo-layout)
6. [Package catalogue and import map](#6-package-catalogue-and-import-map)
7. [The `betterFiles()` instance API](#7-the-better-files-instance-api)
8. [Data model and schema customization](#8-data-model-and-schema-customization)
9. [Authorization model](#9-authorization-model)
10. [Better IAM integration in detail](#10-better-iam-integration-in-detail)
11. [Files: storage, encryption, processing](#11-files-storage-encryption-processing)
12. [HTTP protocol, client SDK and typing](#12-http-protocol-client-sdk-and-typing)
13. [Framework integrations](#13-framework-integrations)
14. [Plugin system and first-party plugins](#14-plugin-system-and-first-party-plugins)
15. [Background work without a worker app](#15-background-work-without-a-worker-app)
16. [Security model](#16-security-model)
17. [Tooling, testing, CI and releases](#17-tooling-testing-ci-and-releases)
18. [Phased roadmap](#18-phased-roadmap)
19. [Upstream Better IAM work track](#19-upstream-better-iam-work-track)
20. [Risks and mitigations](#20-risks-and-mitigations)
21. [Open decisions](#21-open-decisions)
22. [Appendix: integration sketches](#22-appendix-integration-sketches)

---

## 1. Goals and non-goals

### Goals

- **A library, shaped like Better IAM.**
  - A single factory, `betterFiles({...})`, returns an instance with `dr.api.*` (server calls), `dr.handler` / `dr.nodeHandler` (HTTP), `dr.require` / `dr.can` (authorization), `dr.events`, and maintenance functions the host schedules.
  - Separately publishable `@better-files/*` packages, plus an umbrella `better-files` package with subpath imports.
- **Drop-in for any framework.** First-class packages for Next.js, NestJS, Express, Hono, Fastify, React Router, SvelteKit and Nuxt. Browser SDKs for React, Vue and Svelte. A framework-neutral middleware for everything else.
- **Deep Better IAM integration.** The library does not reimplement any of these; it takes them from Better IAM:
  - identity, sessions, tenants and guests;
  - groups, relationship tuples and policies;
  - MFA step-up and terms of use;
  - KMS envelope encryption;
  - the audit chain and webhooks;
  - billing meters, licenses and feature flags;
  - threat response and MCP gating.
- **Dynamic and composable.**
  - Every infrastructure dependency is an adapter: database, storage, queue, search, scanner, converter, signature provider, AI provider and key provider.
  - Every product feature beyond the core is a **plugin** that brings its own tables, endpoints, hooks, actions and client typings.
  - The schema can be extended with extra fields and custom table names, and it can live in the host app's own database.
- **Headless.** The library ships logic, protocols, typed clients and hooks. Optional UI pieces are limited to primitives that _need_ client code to be secure: the secure viewer element and a resumable uploader. There are no product screens.
- **Runs anywhere Node runs.** Everything runs in one process by default. Heavy processing can be moved out to the host's own queue workers with a single option.

### Non-goals

- No hosted service, admin console, product web app or managed deployment. The `examples/` folder holds reference integrations, not a product.
- No bundled design system or page components. The host builds its UI with its own components and the hooks.
- No real-time co-editing of Office documents. A WOPI plugin can hook into an editor later.
- No hardware-attested DRM. The library provides watermarking, view-only rendering and forensic tracing, and says plainly that screenshots cannot be prevented.
- No claims of API compatibility with Dropbox, DocuSign or AWS.

---

## 2. Design principles

1. **Mirror Better IAM's ergonomics.** A developer who knows `betterIam()` should feel at home:
   - the same instance shape (`api`, `handler`, `nodeHandler`, `require`, `initialize`);
   - the same HTTP envelope (`POST {base}/{group}/{method}`, `{ data } | { error }`);
   - the same typed-client pattern (`createBetterFilesClient<typeof dr>()`);
   - the same framework-package pattern (`createBetterFilesNext`, `BetterFilesModule.forRoot`, `createBetterFilesExpress`);
   - the same repository tooling.
2. **Ports and adapters, with no vendor SDKs in core.** `@better-files/core` defines the interfaces (`DatabaseAdapter`, `StorageAdapter`, `KeyProvider`, `IdentityProvider`, `AuthzProvider`, `AuditSink`, `JobRunner`, `SearchAdapter`, `Scanner`, `Converter`, `SignatureProvider`, `AiProvider`, `Mailer`).
3. **Better IAM is the default integration, not a hard import in core.** `@better-files/iam` implements the identity, authz, key, audit, billing and guest ports. Core stays testable with in-memory fakes. Other identity systems can plug in through the same ports.
4. **Data room data lives in its own tables, which can sit in your database.** Better IAM keeps plugin data as JSON rows in one table behind a global write lock. High-volume document and activity data therefore goes into Better Files tables through Better Files' own adapter, which can share the host's database connection. Only facts tied to identity stay in IAM: room resources, relationship tuples, groups, guests, keys and security audit.
5. **Authorize immediately before acting, on the server, against trusted storage.** Client-side checks are advisory only. This is Better IAM's own rule.
6. **Tenant isolation everywhere.** Every row carries `tenant_id` (the Better IAM tenant id). Every lookup by id re-checks `tenant_id`, the same discipline `@better-iam/projects` follows.
7. **Streaming, never buffering.** Uploads, downloads, encryption, watermarking and exports stream end to end.
8. **Opt-in features, zero-cost when unused.** Plugins and protocol adapters load only when imported. `sideEffects: false` everywhere. Heavy dependencies such as pdf-lib, sharp and tesseract are optional peer dependencies, loaded lazily.
9. **The host owns scheduling, processes and UI.** The library exposes functions (`dr.jobs.work()`, `dr.maintain()`, `dr.events.dispatch()`). The host decides whether to call them from a cron job, a queue worker, a Next.js route, a Nest scheduler or a serverless timer.

---

## 3. Better IAM: what we reuse, and its gaps

### 3.1 Capabilities we build on

> Guests (`guests.invite`, `guests.configure`, guest boundaries, `principal.guest`) arrived in better-iam 0.3.0. On 0.2.x
> Better Files detects their absence and falls back as §17 describes.

| Data room need                      | Better IAM feature                                                                                                                                                   | Better Files usage                                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Accounts and organizations          | Tenants, identities, invitations, SSO, SCIM                                                                                                                          | A host-app tenant is the data room owner scope. SSO and SCIM come free.                                  |
| External bidders, counsel, auditors | **Guests**: `guests.invite` with `groupIds`, `accessDays`, a sponsor and a `guestBoundary`                                                                           | Room invitations for outsiders become guest invitations.                                                 |
| Room roles                          | **Managed resource type** `better-files-room`, plus **relationship tuples** (with `expiresAt`)                                                                       | The relations `owner/admin/publisher/editor/contributor/viewer/auditor` on `better-files-room/{roomId}`. |
| Permission groups ("Buyer A")       | **Groups**, with expiring membership                                                                                                                                 | One IAM group per room permission group, so SCIM-synced groups work directly.                            |
| Room security settings              | **Policies**: 21 operators, plus `principal.mfa`, `request.sourceIp`, `request.deviceAssurance`, `principal.guest`, `principal.agreements` and `principal.riskLevel` | Room settings compile into policy documents.                                                             |
| "Which rooms can I see?"            | `listAccessible` on managed types                                                                                                                                    | The room list.                                                                                           |
| Filtering large lists               | `planResources` with `filterToSql` / `filterToPrisma`                                                                                                                | IAM conditions become SQL predicates on Better Files tables.                                             |
| UI gating                           | `authorizeMany`, `<Can>`, `useCan`, `req.iam.can`                                                                                                                    | Buttons and menus in the host UI.                                                                        |
| Time-boxed access                   | Expiring tuples and memberships, binding windows, just-in-time activation                                                                                            | Expiring room access.                                                                                    |
| Access reviews                      | `certifications`, `policies.whoCan`, `invariants`                                                                                                                    | Periodic "who can see this room" reviews.                                                                |
| Encryption at rest                  | **KMS**: `generateDataKey`, `encryptionContext`, grants, rotation, deletion                                                                                          | Envelope encryption per file; a key per room; crypto-shredding.                                          |
| Short tickets                       | `assertions.issue` / `verifyAssertion`; session JWTs with JWKS                                                                                                       | 60-second download and viewer tickets.                                                                   |
| Audit                               | Per-tenant hash chain, webhooks, `events.subscribe`                                                                                                                  | Security events go into the IAM chain.                                                                   |
| Anomaly response                    | `threats.reportSuspicious` / `threats.respond`, `principal.riskLevel`                                                                                                | The mass-download detector feeds IAM's response tools.                                                   |
| Metering and plans                  | `billing.record`, licenses, feature flags                                                                                                                            | Hosts can meter storage, egress, rooms and signatures if they want.                                      |
| Agents                              | Agent identities, delegation, `better-iam/mcp`                                                                                                                       | The MCP plugin runs under the IAM gate.                                                                  |
| Framework glue                      | `better-iam/next`, `/nestjs`, `/express`, `/hono`, `/fastify` and others                                                                                             | Better Files adapters reuse `req.iam` / `c.get('iam')` and the session.                                  |

### 3.2 Gaps found in the Better IAM source, and how we handle each

| #   | Gap                                                                                                                                      | Where                                           | Workaround in Better Files                                                                                                                          | Upstream fix (§19)                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| G1  | Relations inherit **one level only** (`resource.relations` plus `resource.parentRelations`), and a managed type cannot be its own parent | `server/src/decisions.ts`, `catalog.ts:469-485` | Two layers. IAM owns room-level membership and guardrails; the Better Files engine owns the folder/document matrix, backed by a closure table (§9). | N-level ancestor relations                         |
| G2  | Plugins cannot own tables, have a fixed SQLite index set, and share one global write lock                                                | `core/src/sql.ts`, `storage.ts:95`              | Better Files has its own database adapter and tables, in the host database or a separate one.                                                       | Plugin-declared indexes; a shared-transaction hook |
| G3  | Plugin endpoints are JSON POST only, capped at 64 KB                                                                                     | `server/src/http.ts`                            | Better Files serves its own streaming routes. It can also mount inside IAM through `iam.useProtocol`.                                               | Streaming plugin routes                            |
| G4  | Plugins get no client typings                                                                                                            | `client/src/index.ts:126`                       | `createBetterFilesClient<typeof dr>` infers every group, **including plugin groups**.                                                               | Typed plugin client                                |
| G5  | Allowed reads are not audited, and plugin audit events carry no metadata                                                                 | `operations.ts:184`                             | Better Files keeps its own per-room activity chain. Security events go to IAM through `protocolHost.recordAudit`.                                   | `ctx.audit()`; opt-in "audit allows"               |
| G6  | Agreements are tenant-scoped, with at most 50                                                                                            | `api/agreements.ts:41`                          | The native NDA plugin, per room                                                                                                                     | Resource-scoped agreements                         |
| G7  | No anonymous or link principals                                                                                                          | —                                               | Links are backed by an IAM service identity, a scoped STS session and session tags                                                                  | Link principals                                    |
| G8  | Every decision loads all of the tenant's tuples                                                                                          | `decisions.ts:870`                              | Tuples stay at room level with group subjects; the fine-grained matrix lives in the engine                                                          | Indexed tuple loading                              |
| G9  | Threat rules are fixed                                                                                                                   | `docs/threat-detection.md`                      | A Better Files detector that calls `threats.reportSuspicious`                                                                                       | Custom rules                                       |
| G10 | Legal holds apply to identities only                                                                                                     | `docs/privacy.md`                               | The retention plugin provides document holds                                                                                                        | Resource holds                                     |

---

## 4. How it fits into a host app

```mermaid
flowchart LR
  subgraph "Your app (Next.js / NestJS / Express / Hono / Fastify / …)"
    UI[Your UI<br/>your components + @better-files/react hooks<br/>+ optional &lt;bf-viewer&gt;, uploader]
    ROUTES[Your routes / server actions / controllers<br/>dr.api.* · dr.require · req.betterFiles]
    MOUNT[Mounted protocol<br/>/api/iam/* · /api/better-files/*]
    IAM[better-iam instance<br/>plugins: betterFilesIamPlugin]
    DR[better-files instance<br/>betterFiles({ iam, database, storage, plugins })]
    SCHED[Your scheduler / queue worker<br/>dr.jobs.work() · dr.maintain()]
  end
  DB[(Your database<br/>iam_* tables + better_files_* tables)]
  BLOB[(Your storage<br/>S3 / R2 / GCS / Azure / disk)]

  UI -->|createBetterFilesClient| MOUNT
  UI --> ROUTES
  ROUTES --> DR
  MOUNT --> IAM
  MOUNT --> DR
  DR -->|authorize · tuples · groups · guests · KMS · audit| IAM
  DR --> DB
  IAM --> DB
  DR --> BLOB
  SCHED --> DR
```

**Three ways to use it:**

1. **Server-only SDK.** Call `dr.api.documents.upload(credential, …)` from your own route handlers, server actions or Nest services. Nothing is mounted.
2. **Mounted protocol.** Mount `dr.handler` (via a framework package) and use `@better-files/client` / `@better-files/react` from the browser.
3. **Mixed**, which is typical: mount the streaming routes (uploads, downloads, viewer tiles) and call everything else server-side.

### Request lifecycle: downloading a document

1. The client calls `POST /api/better-files/documents/requestDownload { tenantId, documentId, variant: 'watermarked' }`, or server code calls `dr.api.documents.requestDownload(...)`.
2. `IdentityProvider.authenticate` returns the Better IAM principal (`id`, `groups`, `mfa`, `guest`, and so on). If the framework adapter already resolved `req.iam`, that session is reused.
3. The engine loads the document, checks `tenant_id`, and resolves its ancestors from the closure table.
4. **Layer A (engine ACL):** the effective capability mask must include `DOWNLOAD_WATERMARKED`. Room state, the NDA gate and plugin `beforeDownload` hooks also run here.
5. **Layer B (IAM guardrail):** `iam.require({ action: 'better-files:documents:download', resource: { type: 'better-files-document', id } })`.
6. An activity record is written, and a security-audit record if the policy says so. The `document.download.requested` event is emitted.
7. A **60-second single-use ticket** is issued through `iam.api.assertions.issue`.
8. `GET /api/better-files/files/{ticket}` verifies the ticket, unwraps the file key through KMS, then decrypts, watermarks and streams the file with `Content-Disposition: attachment` and `nosniff`.

---

## 5. Monorepo layout

This mirrors `better-iam/` on purpose: `packages/*`, `examples/*`, root `tests/`, `docs/` and `scripts/`. There is **no `apps/` product folder**.

```
data-room/
├─ package.json                 # private workspace root, scripts only
├─ pnpm-workspace.yaml          # packages/*, examples/*
├─ tsconfig.base.json           # ES2023, NodeNext, strict, noUncheckedIndexedAccess, composite
├─ tsconfig.json                # files: [], references every package
├─ vitest.config.ts             # aliases @better-files/* → packages/*/src (subpaths first)
├─ vitest.bench.config.ts
├─ .prettierrc.json             # singleQuote, printWidth 100, trailingComma all
├─ CHANGELOG.md                 # hand-written, "## Unreleased" on top
├─ LICENSE / NOTICE / README.md
├─ docker/compose.test.yaml     # test infra only: postgres, minio, clamav, gotenberg, meilisearch
├─ scripts/
│   ├─ validate-packages.mjs    # license, publishConfig, exports exist, publint, same version
│   ├─ pack.mjs                 # pnpm pack → artifacts/
│   ├─ check-packed-types.mjs   # attw --profile esm-only
│   ├─ packed-smoke.mjs         # install tarballs into work/, run examples against them
│   ├─ release-version.mjs      # lockstep version bump
│   ├─ api-reference.mjs        # docs/api-reference.md from the route registry
│   └─ link-better-iam.mjs      # dev: link ../better-iam packages until published
├─ packages/
│   ├─ better-files/               # umbrella: `better-files` + subpaths (like `better-iam`)
│   ├─ core/                    # types, errors, ports, ACL math, schema model, plugin contract, conformance kits
│   ├─ server/                  # betterFiles() factory, services, HTTP protocol, jobs, events
│   ├─ iam/                     # Better IAM integration: IAM plugin + providers + resolver + policy templates
│   ├─ adapter-kysely/          # shared SQL implementation (dialects below build on it)
│   ├─ adapter-postgres/
│   ├─ adapter-sqlite/
│   ├─ adapter-libsql/
│   ├─ adapter-drizzle/         # reuse the host's Drizzle db + generated schema
│   ├─ adapter-prisma/          # reuse the host's Prisma client + generated models
│   ├─ storage-s3/              # S3, R2, MinIO, B2, Wasabi
│   ├─ storage-gcs/
│   ├─ storage-azure/
│   ├─ storage-fs/              # local disk
│   ├─ crypto/                  # streaming segmented AEAD, envelope format, local key provider
│   ├─ client/                  # typed SDK, resumable uploader, download helper
│   ├─ react/                   # provider + hooks (headless)
│   ├─ vue/                     # plugin + composables
│   ├─ svelte/                  # stores (+ /kit helpers)
│   ├─ viewer/                  # <bf-viewer> secure viewer custom element (framework-agnostic)
│   ├─ next/                    # App Router handlers, server helpers, guards
│   ├─ nestjs/                  # module, guards, decorators, HTTP mount
│   ├─ middleware/              # /express, /hono, /fastify, framework-neutral helpers
│   ├─ react-router/            # middleware + loader/action guards
│   ├─ nuxt/                    # Nuxt module + /h3
│   ├─ cli/                     # `better-files` CLI: migrate, generate, doctor, reconcile, config as code
│   ├─ testing/                 # in-memory adapters, fake IAM, fixtures, seeders
│   │   # ── first-party plugins (each optional) ──
│   ├─ plugin-nda/
│   ├─ plugin-watermark/
│   ├─ plugin-processing/       # scan, convert, preview tiles, text/OCR extraction
│   ├─ plugin-links/            # Dropbox-style share links
│   ├─ plugin-qa/
│   ├─ plugin-tasks/            # checklists (DocuSign Rooms-style)
│   ├─ plugin-search/           # /sql, /meilisearch, /opensearch
│   ├─ plugin-templates/        # room templates + dynamic metadata fields
│   ├─ plugin-retention/        # legal holds, retention, trash, archival export
│   ├─ plugin-analytics/        # engagement, heatmaps, reports
│   ├─ plugin-notifications/    # digests, instant emails through the host's mailer
│   ├─ plugin-redaction/
│   ├─ plugin-esign/            # native e-signature + /docusign, /dropbox-sign providers
│   ├─ plugin-sync/             # delta cursors for CLI/desktop sync
│   ├─ plugin-connectors/       # /dropbox, /google-drive, /onedrive, /box, /sftp imports
│   ├─ plugin-ai/               # permission-aware RAG, summaries, Q&A drafts
│   └─ plugin-mcp/              # MCP tools gated by better-iam/mcp
├─ examples/                    # reference integrations, not products
│   ├─ sqlite-minimal/          # node:http, ~60 lines
│   ├─ nextjs/                  # App Router + better-iam/next + server actions + hooks
│   ├─ nestjs/
│   ├─ express/
│   ├─ hono/
│   ├─ fastify/
│   ├─ react-router/
│   ├─ sveltekit/
│   ├─ nuxt/
│   ├─ postgres-s3-queue/       # production-shaped: pg + S3 + host queue worker
│   ├─ drizzle-existing-db/     # tables generated into an existing Drizzle schema
│   ├─ custom-authz/            # implementing the ports without Better IAM
│   └─ shared/smoke.mjs
├─ tests/                       # all tests at the root (Better IAM convention)
│   ├─ unit/ integration/ conformance/ security/ frameworks/ e2e-examples/ bench/
│   └─ tsconfig.*.json          # per-surface typecheck projects (client, next, nestjs, …)
└─ docs/                        # markdown guides; no hosted docs app required
```

---

## 6. Package catalogue and import map

### 6.1 Import map (umbrella `better-files`)

| Import                                                                                                       | Purpose                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `better-files`                                                                                               | `betterFiles()` factory, `Capability`, presets, errors, plugin helpers                                                                                                              |
| `better-files/core`                                                                                          | Types, ports, plugin contract, schema model, ACL math                                                                                                                               |
| `better-files/server`                                                                                        | Services and HTTP protocol, for advanced composition                                                                                                                                |
| `better-files/iam`                                                                                           | `betterIamIntegration(iam)`, `betterFilesIamPlugin()`, resolver, policy templates                                                                                                   |
| `better-files/client`                                                                                        | Browser-safe typed SDK, uploader, downloads                                                                                                                                         |
| `better-files/react`                                                                                         | `BetterFilesProvider` and hooks                                                                                                                                                     |
| `better-files/vue`                                                                                           | Vue plugin and composables                                                                                                                                                          |
| `better-files/svelte`, `better-files/svelte/kit`                                                             | Stores and SvelteKit hooks/guards                                                                                                                                                   |
| `better-files/viewer`                                                                                        | `<bf-viewer>` custom element (plus a React wrapper at `better-files/viewer/react`)                                                                                                  |
| `better-files/next`, `better-files/next/edge`                                                                | App Router handlers, guards, server client; edge-safe ticket verification                                                                                                           |
| `better-files/nestjs`                                                                                        | `BetterFilesModule`, guards, decorators                                                                                                                                             |
| `better-files/express`, `better-files/hono`, `better-files/fastify`                                          | Mounts, `req.betterFiles`, route guards                                                                                                                                             |
| `better-files/react-router`                                                                                  | Middleware and loader/action guards                                                                                                                                                 |
| `better-files/middleware`                                                                                    | Framework-neutral request helpers                                                                                                                                                   |
| `better-files/adapter-postgres`, `/adapter-sqlite`, `/adapter-libsql`, `/adapter-drizzle`, `/adapter-prisma` | Database adapters                                                                                                                                                                   |
| `better-files/storage-s3`, `/storage-gcs`, `/storage-azure`, `/storage-fs`                                   | Storage adapters                                                                                                                                                                    |
| `better-files/plugins/*`                                                                                     | `nda`, `watermark`, `processing`, `links`, `qa`, `tasks`, `search`, `templates`, `retention`, `analytics`, `notifications`, `redaction`, `esign`, `sync`, `connectors`, `ai`, `mcp` |
| `better-files/testing`                                                                                       | In-memory adapters, fake IAM, fixtures                                                                                                                                              |
| `@better-files/nuxt`                                                                                         | Nuxt module (installed directly, like `@better-iam/nuxt`)                                                                                                                           |

Protocol and plugin packages load only when their subpath is imported. Heavy native dependencies (sharp, pdf-lib, tesseract.js, argon2, AWS/GCP/Azure SDKs) are **optional peer dependencies** of the adapter or plugin that needs them.

### 6.2 Packages in detail

**`@better-files/core`** has no vendor dependencies.

- **Domain types:** `Room`, `Node` (folder/document), `Document`, `DocumentVersion`, `Blob`, `PermissionGroup`, `AclEntry`, `Member` and `ActivityEvent`, plus the contracts plugins extend.
- **`BetterFilesError`:** codes `NOT_FOUND`, `FORBIDDEN`, `CONFLICT`, `ROOM_CLOSED`, `NDA_REQUIRED`, `MFA_REQUIRED`, `QUARANTINED`, `LEGAL_HOLD`, `QUOTA_EXCEEDED`, `UNSUPPORTED` and `RATE_LIMITED`, each with an HTTP status, mirroring `IamError`.
- **Ports:** every adapter interface listed in §2.
- **Schema model:** a declarative table and field definition (`defineTable`, `field.string()`, …). Core and plugins use it; adapters and the CLI read it to create tables, generate Drizzle or Prisma schema, and run migrations.
- **ACL math:** the `Capability` bitmask, presets and `resolveEffectiveMask()`, as pure functions covered by property tests.
- **Rules:** names, paths, collisions and auto-index numbering (1, 1.1, 1.1.2).
- **Plugin contract:** `BetterFilesPlugin` (§14).
- **`@better-files/core/conformance`:** `runDatabaseConformance`, `runStorageConformance`, `runJobRunnerConformance`, `runSearchConformance` and `runKeyProviderConformance`, so third-party adapters can prove compatibility.
- **Validation:** zod v4 schemas for every input. They drive runtime validation, client types and the OpenAPI output.

**`@better-files/server`**

- `betterFiles(options)` returns a `BetterFiles` instance (§7).
- **Core services:** `rooms`, `folders`, `documents`, `versions`, `uploads`, `downloads`, `members`, `groups`, `permissions` and `activity`.
- **HTTP:** a fetch `handler`, a Node `nodeHandler`, a route registry and an OpenAPI generator.
- **Infrastructure:** a job runner (in-process by default), an event bus with signed webhooks, an outbox, a reconciler and the plugin host.

**`@better-files/iam`** is the integration (§10):

- `betterIamIntegration(iam, options)` returns the identity, authz, key, audit, billing, guests and threats providers in one object;
- `betterFilesIamPlugin(options)` is the `IamPlugin` registered on the host's `betterIam({ plugins })`;
- `betterFilesResolver(getDr, { fallback })` is composed into the host's `resolveResource`;
- `policyTemplates` and `accessModel()` provide configuration-as-code bundles for Better IAM `plan`/`apply`;
- `commands` provides `defineCommand` entries for the host's `better-iam.config.mjs`.

**Database adapters**

- `adapter-kysely` holds the shared implementation. `adapter-postgres`, `adapter-sqlite` and `adapter-libsql` are dialect wrappers that match Better IAM's supported databases.
- **Bring your own connection:** `postgresAdapter({ pool })` or `kyselyAdapter(db)`, so Better Files uses the same database as the host app, with a configurable table prefix (default `better_files_`).
- `adapter-drizzle` and `adapter-prisma` run on the host's existing ORM client. `better-files generate --orm drizzle|prisma` emits schema files for the host to own and migrate.
- Postgres extras: optional RLS, monthly partitioned activity, FTS and trigram indexes. SQLite extras: FTS5 and WAL.

**Storage adapters.** `put(stream)`, `get(range?)`, `head`, `delete`, `copy`, `createMultipart` / `uploadPart` / `complete` / `abort`, and optionally `presignPut` / `presignGet`. Files are content-addressed per tenant. An adapter can be chosen per room (`storage: (room) => adapter`) to keep data in a given region.

**`@better-files/crypto`**

- Streaming **AES-256-GCM in 64 KiB segments** using the STREAM construction, so range reads work.
- A versioned envelope header.
- `localKeyProvider` for development. External BYOK providers (`/aws-kms`, `/gcp-kms`, `/azure-kv`, `/vault-transit`) arrive later as subpaths.

**Client-side packages**

- `@better-files/client`: `createBetterFilesClient<typeof dr>({ baseURL, iam? })` (§12), a resumable chunked uploader, a download helper and an SSE activity stream.
- `@better-files/react`, `/vue` and `/svelte`: providers and hooks with no styling (`useRoom`, `useFolder`, `useDocument`, `useUpload`, `useCapabilities`, `useMembers`, `useActivity`, plus plugin hooks such as `useQuestions`).
- `@better-files/viewer`: the `<bf-viewer>` custom element. It is the only UI piece shipped, because secure viewing needs client code. It shows server-watermarked page tiles and lets the host style it through CSS parts.

**Framework packages** are described in §13. **`@better-files/cli`** provides `better-files migrate | generate | doctor | reconcile | seed | templates apply | keys rewrap | export`, reads a `better-files.config.ts`, and reuses Better IAM CLI login profiles.

---

## 7. The `betterFiles()` instance API

```ts
const dr = betterFiles({
  // required
  iam: betterIamIntegration(iam), // or custom { identity, authz, keys?, audit? }
  database: postgresAdapter({ pool }),
  storage: s3Storage({ bucket }),

  // optional
  basePath: '/api/better-files',
  schema: {
    // dynamic schema (§8.3)
    tablePrefix: 'dr_',
    rooms: {
      additionalFields: {
        dealCode: field.string({ indexed: true }),
        sector: field.enum(['tech', 'health']),
      },
    },
    documents: {
      additionalFields: { confidentiality: field.enum(['public', 'internal', 'restricted']) },
    },
  },
  capabilities: { presets: { reviewer: ['LIST', 'VIEW', 'PRINT'] } },
  encryption: { mode: 'per-room-key' }, // 'per-tenant-key' | 'none' (dev only)
  jobs: { runner: 'inline' }, // 'inline' | 'deferred' | custom JobRunner (§15)
  limits: { maxFileSize: '5gb', maxUploadParts: 10_000 },
  hooks: { beforeUpload, afterDownload, onRoomStatusChange }, // app-level hooks (§14)
  plugins: [ndaPlugin(), watermarkPlugin(), processingPlugin(), qaPlugin()],
  trustedOrigins: ['https://app.example.com'],
  logger,
  telemetry, // OpenTelemetry spans + Prometheus metrics
});
```

| Member                                                                             | Purpose                                                                                                                                                         |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dr.api.<group>.<method>(credential, input)`                                       | Every operation, server side, with typing that includes plugins. The credential is `{ headers }`, `{ token }` or `{ session }` (a resolved Better IAM session). |
| `dr.handler(request)` / `dr.nodeHandler(req, res)`                                 | HTTP protocol (JSON routes plus streaming routes)                                                                                                               |
| `dr.require({ credential, tenantId, capability \| action, node })` / `dr.can(...)` | Server-side authorization for the host's own routes                                                                                                             |
| `dr.capabilities(credential, { tenantId, nodeIds })`                               | Batch effective masks for rendering the UI                                                                                                                      |
| `dr.plan(credential, { tenantId, roomId, capability })`                            | A filter the host can apply to its own queries (mirrors `planResources`)                                                                                        |
| `dr.events.subscribe(pattern, handler)` / `dr.events.dispatch()`                   | In-process events; webhooks are delivered by `dispatch`                                                                                                         |
| `dr.jobs.work({ kinds?, concurrency?, signal? })` / `dr.jobs.runOnce(id)`          | Runs deferred processing jobs in whatever process the host chooses                                                                                              |
| `dr.maintain()`                                                                    | Sweeps: expirations, trash purge, retention, digests, ticket cleanup, and guest sweeps if needed                                                                |
| `dr.reconcile({ tenantId? })`                                                      | Repairs drift between IAM and Better Files                                                                                                                      |
| `dr.initialize()` / `dr.migrations.plan()` / `dr.close()`                          | Lifecycle (the CLI wraps these)                                                                                                                                 |
| `dr.$Infer`                                                                        | Type helpers (`typeof dr.$Infer.Room` and so on, including additional fields)                                                                                   |

---

## 8. Data model and schema customization

### 8.1 Core tables

All tables have the prefix `better_files_` (configurable) and include `tenant_id`, `created_at` and `updated_at`. Ids are prefixed ULIDs (`room_…`, `nod_…`, `ver_…`, `blb_…`, `grp_…`).

| Table               | Key columns                                                                                                                                                      | Notes                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `rooms`             | id, tenant*id, name, slug, status (`provisioning/draft/live/closed/archived`), owner_id, settings json, kms_key_id, storage_ref, closes_at, \_additional fields* | Mirrored as the IAM managed resource `better-files-room/{id}`     |
| `nodes`             | id, tenant*id, room_id, parent_id, kind (`folder/document`), name, sort_key, index_label, deleted_at, \_additional fields*                                       | Folders and documents share one table                             |
| `node_closure`      | tenant_id, ancestor_id, descendant_id, depth                                                                                                                     | Constant-time ancestor lookups; one-statement subtree moves       |
| `documents`         | node_id, current_version_id, mime, size, page_count, flags (`view_only`, `no_print`, `no_copy`), checked_out_by                                                  | One-to-one with document nodes                                    |
| `versions`          | id, document_id, number, blob_id, status (`uploading/quarantined/processing/ready/failed/rejected`), sha256, size, uploaded_by                                   | Immutable                                                         |
| `blobs`             | id, tenant_id, sha256, size, storage_key, wrapped_dek, key_ref, enc_context_hash, refcount                                                                       | Deduplicated within a tenant only                                 |
| `renditions`        | version_id, kind, blob_id, meta                                                                                                                                  | PDFs, tiles and text produced by plugins                          |
| `uploads`           | id, tenant_id, room_id, parent_id, filename, size, sha256_expected, multipart_ref, parts, expires_at                                                             | Resumable sessions                                                |
| `permission_groups` | id, tenant_id, room_id, name, iam_group_id, kind, default_preset, expires_at                                                                                     | One IAM group each                                                |
| `acl_entries`       | id, tenant_id, room_id, node_id, subject_type (`group/identity/link`), subject_id, mask, locked, expires_at, granted_by                                          | The permission matrix                                             |
| `members`           | tenant_id, room_id, identity_id, status, guest, invited_by, last_seen_at                                                                                         | A cache of IAM facts, used for listings                           |
| `activity`          | id, tenant_id, room_id, seq, actor_id, action, node_id, meta, ip, ua, prev_hash, hash, at                                                                        | Per-room hash chain                                               |
| `tickets`           | nonce, expires_at, used_at                                                                                                                                       | Single use                                                        |
| `outbox`            | id, kind, payload, idempotency_key, attempts, next_at                                                                                                            | IAM writes, webhooks, emails                                      |
| `jobs`              | id, kind, payload, status, attempts, run_at, locked_by                                                                                                           | Built-in `JobRunner` only; skipped when the host supplies its own |
| `migrations`        | id, applied_at, checksum                                                                                                                                         | Includes plugin migrations                                        |

Plugins add their own tables (for example `qa_questions`, `nda_versions`, `esign_envelopes`) through the same schema model.

### 8.2 Room lifecycle

```
provisioning ─▶ draft ──publish──▶ live ──close──▶ closed ──archive──▶ archived ──purge──▶ ∅
                  │                  ▲    reopen    │
                  └── delete         └──────────────┘
```

The engine enforces the states. The host can add transition hooks (`onRoomStatusChange`), for example to lock the index or notify groups.

### 8.3 Schema customization ("dynamic")

- **Additional fields** on `rooms`, `nodes`, `documents`, `versions`, `members` and `permission_groups`:
  - they are typed end to end (the `dr.$Infer` types, `dr.api` inputs and outputs, the client and the hooks);
  - they can be validated with zod;
  - they are optionally indexed and searchable;
  - primitive fields can optionally be **exposed to IAM policies** as resolver attributes (`resource.meta_confidentiality`).
- **Table and field renaming** (`schema.rooms.tableName`, `fields: { name: 'title' }`) to fit existing naming conventions.
- **Runtime metadata** (the templates plugin) lets end users define fields per room template without code; these are stored as JSON with a typed registry.
- **Custom capabilities** from plugins or config (for example `ANNOTATE`), stored above bit 16 of the mask.
- **Custom presets and room relations**, with relations provisioned through Better IAM `resourceTypes` in `tenant-defined` mode.
- **Generated migrations:** `better-files generate` produces SQL, Drizzle or Prisma files that include plugins and additional fields, and `better-files migrate` applies them, or the host applies them with its own tool.

---

## 9. Authorization model

### 9.1 Two layers, both must allow

```
allowed(principal, op, node) =
      EngineACL(subjects(principal), node) ⊇ requiredCapability(op)      // hierarchical matrix, fast, indexed
  ∧   roomState & plugin guards allow op                                  // closed room, NDA pending, quarantine, hold
  ∧   BetterIAM.authorize(principal, action(op), better_files_room_* resource)     // membership + guardrail policies
```

Why two layers:

- IAM only inherits one level (G1) and scans all of a tenant's tuples on every check (G8).
- A data room has deep trees and per-folder overrides for each bidder group.
- The engine therefore owns the tree matrix, and IAM owns **who is in the room, in which role, under which conditions** (MFA, IP, device, guest boundary, terms, risk, time windows). The host's administrators can then govern data rooms with the same policy tools, access reviews and `whoCan` they already use for everything else.

The `AuthzProvider` port lets the boundary move as the upstream fixes land (§19).

### 9.2 Capabilities

```ts
export const Capability = {
  LIST: 1 << 0,
  VIEW: 1 << 1,
  PRINT: 1 << 2,
  COPY_TEXT: 1 << 3,
  DOWNLOAD_WATERMARKED: 1 << 4,
  DOWNLOAD_ORIGINAL: 1 << 5,
  UPLOAD: 1 << 6,
  EDIT: 1 << 7,
  DELETE: 1 << 8,
  MANAGE: 1 << 9,
  // bits 16+ reserved for plugins / config (e.g. ANNOTATE, QA_ASK, ESIGN_SEND)
} as const;

export const Presets = {
  hidden: [],
  view: ['LIST', 'VIEW'],
  viewPrint: ['LIST', 'VIEW', 'PRINT'],
  download: ['LIST', 'VIEW', 'PRINT', 'DOWNLOAD_WATERMARKED'],
  downloadOriginal: [
    'LIST',
    'VIEW',
    'PRINT',
    'COPY_TEXT',
    'DOWNLOAD_WATERMARKED',
    'DOWNLOAD_ORIGINAL',
  ],
  contributor: [/* download + */ 'UPLOAD'],
  editor: [/* contributor + */ 'EDIT', 'DELETE'],
  manager: ['*'],
};
```

### 9.3 Resolution rules

- **Subjects:** `identity:{id}`, plus `group:{g}` for every IAM group in `principal.groups` that is one of the room's permission groups, plus `link:{id}` for link sessions.
- **Per subject:** the **nearest explicit entry** walking up from the node wins, unless an ancestor entry is `locked`, in which case that ancestor's mask is final for the whole subtree. Expired entries are ignored.
- **Across subjects:** the masks are combined with a union. "Hidden" applies only to the subject it is set on.
- **Room-role floors** (from IAM relations): `owner` and `admin` get `manager` at the root. `auditor` gets `LIST | VIEW` everywhere, plus read access to activity.
- **Clamps:**
  - document flags: `view_only` removes download and print;
  - room settings: downloads or printing turned off;
  - closed rooms: write bits removed;
  - plugin clamps: the NDA gate, and quarantine.
- **Ancestors:** listing requires `LIST` on every ancestor, with an optional "breadcrumb reveal" setting.
- **Delegation ceiling:** a manager cannot grant a mask larger than their own effective mask on that node.

`resolveEffectiveMask()` is the reference implementation. The SQL implementation, a single query using the closure table and window functions, must match it in property tests over generated trees. **Performance target:** p95 under 15 ms for a 500-item folder listing in a room with 100,000 nodes and 50 groups.

### 9.4 IAM guardrail batching

- Resolver attributes are mostly room-level. For a listing, the engine checks **one representative per distinct attribute tuple** with a single `authorizeMany` call.
- For conditional policies, it uses `planResources` and `filterToSql` with a column mapper, and adds the result to the listing query.
- Room lists use `listAccessible({ type: 'better-files-room' })`.

### 9.5 Action catalog

The IAM plugin contributes these actions:

```
better-files:rooms:create|read|update|publish|close|reopen|archive|delete|export
better-files:members:read|invite|remove|manage      better-files:permissions:read|manage
better-files:documents:list|view|print|copy|download|download-original|upload|edit|delete|restore|checkout
better-files:versions:read|manage                   better-files:activity:read|export
better-files:admin
# plugins add: better-files:links:*, better-files:qa:*, better-files:tasks:*, better-files:esign:*, better-files:ai:query, …
```

A single `OPERATION_MATRIX` in core maps each operation to its IAM action and required capability. It is the single source for the engine, the generated API reference, client-side gating helpers, and a test that fails if any route is unmapped.

---

## 10. Better IAM integration in detail

### 10.1 Wiring in the host app

```ts
// iam.ts: the host's existing Better IAM setup, plus the Better Files plugin and resolver
import { betterIam } from 'better-iam';
import { betterFilesIamPlugin, betterFilesResolver } from 'better-files/iam';

export const iam = betterIam({
  database,
  secret,
  baseURL,
  permissions: {
    mode: 'tenant-defined',
    resourceTypes: {
      /* the app's own types */
    },
  },
  plugins: [betterFilesIamPlugin()],
  resolveResource: betterFilesResolver(() => dr, { fallback: appResolver }),
});

// better-files.ts
export const dr = betterFiles({ iam: betterIamIntegration(iam), database, storage });
```

`betterIamIntegration(iam)` checks at startup that the plugin is registered and that the resolver is composed. If either is missing, it throws with a clear error.

### 10.2 What `betterFilesIamPlugin` contributes

- **Actions:** the §9.5 catalog, plus any plugin-contributed actions (collected at build time through `betterFilesIamPlugin({ plugins })`, or automatically when the same plugin list is passed to both).
- **`resourceTypes`:**
  - `better-files-room` (`managed: true`), with relations `owner, admin, publisher, editor, contributor, viewer, auditor` and attributes `status`, `requireMfa`, `requireNda`, `downloadsEnabled`, `classification` and `closesAt`;
  - `better-files-folder` and `better-files-document`, owned by the application and resolved by `betterFilesResolver`. Their `parent` is `better-files-room`, and their attributes are `roomId`, `roomStatus`, `classification`, `viewOnly` and any exposed additional fields.
- **`endpoints`:** IAM-authoritative operations that benefit from IAM's built-in authorize-and-audit, namely `members/grant-role`, `members/revoke-role`, `groups/attach` and `rooms/security-settings`.
- **`resolveContext`:** adds `principal.betterFilesNdaAccepted`, so the NDA plugin can also be enforced in IAM policy.
- **`afterAudit`:** mirrors IAM events into Better Files, for example `guest:removed` suspends the member, `identity:disabled` invalidates caches, and `privacy:erasure` pseudonymizes activity.
- **`purge`:** when IAM purges a tenant, Better Files schedules a purge of that tenant's rows, files, search entries and vectors.

### 10.3 Mapping

| Better Files concept   | Better IAM object                                                                         | Authoritative source                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Tenant scope           | IAM tenant                                                                                | IAM                                                                          |
| Room                   | Managed resource `better-files-room/{id}`, created with `resources.register`              | Existence as an authz object lives in IAM; the content lives in Better Files |
| Room role              | Relationship tuple on the room, for an identity or group, optionally expiring             | IAM                                                                          |
| Permission group       | IAM group `dr:{roomSlug}:{name}` plus a tuple on the room                                 | IAM owns membership; Better Files owns the matrix                            |
| External participant   | Guest (`guests.invite` with `groupIds`, `accessDays`, sponsor)                            | IAM                                                                          |
| Folder or document     | Application-owned resource, resolved by the Better Files resolver                         | Better Files                                                                 |
| Room security settings | Templated policy documents attached to room roles and groups                              | Rendered by Better Files; stored and evaluated by IAM                        |
| File keys              | A KMS key per room (`better-files-room/{roomId}` alias), with DEKs from `generateDataKey` | IAM KMS                                                                      |
| Tickets                | `assertions.issue`, 60 seconds, audience `better-files-files`                             | IAM                                                                          |
| Security audit         | `protocolHost.recordAudit`                                                                | IAM chain                                                                    |
| Engagement activity    | The `activity` table with a per-room chain                                                | Better Files                                                                 |

### 10.4 Room security settings compiled to IAM policies

Settings are typed (`requireMfaForDownload`, `allowedIpRanges`, `requireManagedDevice`, `guestsViewOnly`, `closedIsReadOnly`, `blockHighRisk`). They are rendered from templates into versioned policies on the room, for example:

```jsonc
{
  "sid": "bf-guest-ip",
  "effect": "deny",
  "actions": ["better-files:*"],
  "resources": ["better-files-room/room_01J…", "better-files-document/*", "better-files-folder/*"],
  "conditions": {
    "StringEquals": { "resource.roomId": "room_01J…" },
    "Bool": { "principal.guest": true },
    "NotIpAddress": { "request.sourceIp": ["203.0.113.0/24"] },
  },
}
```

- **MFA freshness windows** are enforced by the engine through `principal.mfaTime`, and step-up goes through Better IAM's MFA flow.
- **Guest boundary:** a tenant-wide template for `guests.configure({ guestBoundary })`.
- **Invariants and access reviews:** optional helpers that call `invariants.create` and `certifications.create` for room roles.

### 10.5 Credentials

- **User-initiated IAM writes** (invite, grant role, attach group, register the room) run with the caller's credential, so IAM authorizes them and the audit trail names the person.
- **System writes** (reconcile, sweeps, purge) run as a per-tenant `better-files-system` service account with a least-privilege policy. It is provisioned lazily or with `better-files provision --tenant`.
- **File streaming** holds no credential. It verifies tickets offline, so `better-files/next/edge` can serve downloads from edge or serverless routes, and its decrypts use a KMS grant restricted to `purpose: 'better-files-blob'`.

### 10.6 Consistency between IAM and Better Files tables

IAM cannot join a Better Files SQL transaction, even when both are in the same database, because the adapter doesn't expose its handle. Instead:

- **Ordered writes.** For example, a room is created as `provisioning`, then the IAM resource, owner tuple and KMS key are created, then the room moves to `draft`.
- **Outbox.** Side effects are written with idempotency keys.
- **Reconciler.** `dr.reconcile()` and `better-files doctor` compare IAM resources and tuples with Better Files rooms and members, and report or repair differences.
- **IAM is authoritative for membership.** The Better Files `members` rows are a cache, and access fails closed when the two disagree.

The shared-transaction hook in §19 would remove this complexity when both live in one database.

### 10.7 Where each audit event goes

| Class                                                                                                                                       | Destination                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Security and governance: room lifecycle, settings, membership, permissions, original downloads, exports, holds, NDA versions, link creation | IAM audit chain, which also triggers IAM webhooks                                                           |
| Engagement: page views, time on page, watermarked downloads, searches                                                                       | Better Files `activity` chain (`dr.api.activity.verify`, JSONL export)                                      |
| Everything                                                                                                                                  | The Better Files event bus: `dr.events.subscribe`, signed webhooks (same HMAC scheme as Better IAM) and SSE |

---

## 11. Files: storage, encryption, processing

### 11.1 Uploads

- **Proxy mode** (the default): the client calls `uploads.create`, then sends `PUT {base}/uploads/{id}/parts/{n}` as a stream. The server encrypts each segment and uploads it as a multipart part. `uploads.complete` verifies the SHA-256.
- **Direct mode** (optional): presigned multipart PUTs with **client-side encryption** in a web worker, for very large files and serverless hosts that can't proxy big bodies. This is important for Next.js on Vercel-style platforms.
- **Folder uploads** send a manifest, and the engine creates folders idempotently.
- **Deduplication** happens within a tenant only, after the client proves it holds the file.
- **Limits and checks:** size limits per config or per plan hook, filename sanitization, and MIME/extension consistency.
- **Quarantine:** new versions stay `quarantined` until the processing plugin's scan passes. Without the plugin they go straight to `ready`, and `requireScan: true` is rejected at startup if no scanner is configured.

### 11.2 Encryption

- There is a **KMS key per room** (the default) or per tenant. Each blob gets a fresh DEK from `keys.generateDataKey` with `encryptionContext { tenantId, roomId, blobId, purpose }`, and the wrapped DEK is stored on the blob row.
- **Rotation:** KMS rotation plus a lazy re-wrap (`keys.reEncrypt`), with no blob rewrite. `better-files keys rewrap` forces it.
- **Crypto-shredding:** deleting a room schedules its KMS key for deletion.
- **BYOK:** KeyProvider adapters for customers who require their own cloud KMS.

### 11.3 Viewing and downloading

- **View only:** server-rendered page tiles with the watermark **burned in** per viewer. `<bf-viewer>` never receives the original file. Tiles are cached, encrypted, per (version, profile, viewer, day).
- **Watermarked download:** streaming PDF watermarking. Office files are converted to PDF first, unless the user has `DOWNLOAD_ORIGINAL`.
- **Original download:** stream decryption only. It always writes a security audit record.
- **Bulk download:** a job that builds a zip of permitted items only, each watermarked per requester, delivered through a ticket.
- **Anomaly detection:** a sliding-window rule on downloads calls `threats.reportSuspicious` and can optionally trigger `threats.respond` and suspend the member.

### 11.4 Processing (`plugin-processing`)

| Step          | Default engine                    | Notes                                              |
| ------------- | --------------------------------- | -------------------------------------------------- |
| Scan          | ClamAV over INSTREAM              | `Scanner` port; VirusTotal and Defender adapters   |
| Convert       | Gotenberg (LibreOffice/Chromium)  | `Converter` port; runs outside the host, over HTTP |
| Preview tiles | pdf.js/mupdf, sharp               | Optional peer dependencies                         |
| Text and OCR  | pdf text extraction, tesseract.js | Feeds search and AI                                |
| Thumbnails    | sharp                             |                                                    |

Each step is a job kind that runs through the host-controlled runner (§15).

---

## 12. HTTP protocol, client SDK and typing

### 12.1 Protocol (aligned with Better IAM)

- `POST {basePath}/{group}/{method}` with JSON, an `X-Better-Files: 1` header (for CSRF) and an exact trusted Origin for cookie requests.
- **Envelope:** `{ data }` or `{ error: { code, message, requestId, details? } }`, with `cache-control: no-store`.
- **Credentials:** the host's Better IAM cookies or bearer tokens. There is no separate login.
- **Streaming routes:**
  - `PUT {base}/uploads/{id}/parts/{n}`;
  - `GET {base}/files/{ticket}` (supports `Range`);
  - `GET {base}/viewer/{ticket}/tiles/{page}/{z}/{x}/{y}.webp`;
  - `GET {base}/events` (SSE, filtered by permissions).
- `{base}/openapi.json` is generated from the zod schemas, including plugins.
- **Mounting options:** standalone via framework packages, or inside the IAM handler with `iam.useProtocol({ basePath: '/api/better-files', nodeHandler: dr.nodeHandler })` so everything shares one handler.

### 12.2 Core API groups

`rooms` · `folders` · `documents` · `versions` · `uploads` · `downloads` · `viewer` · `members` · `groups` · `permissions` · `activity`. Plugins add groups such as `ndas`, `links`, `qa`, `tasks`, `search`, `templates`, `holds`, `retention`, `exports`, `analytics`, `esign`, `changes` and `ai`.

Examples:

- `permissions.getMatrix`, `setEntries`, `preview` ("view as" a group or identity) and `explain`. `explain` returns the engine ACL path plus IAM `policies.simulate`.
- `members.invite` routes internal users to IAM identities and external users to IAM guests.

### 12.3 Typed client, including plugins

Better IAM has no plugin typings (G4). Better Files builds them in from day one:

```ts
import { createIamClient } from 'better-iam/client';
import { createBetterFilesClient } from 'better-files/client';
import type { dr } from '@/server/better-files';

const iam = createIamClient({ baseURL });
export const rooms = createBetterFilesClient<typeof dr>({ baseURL, iam }); // shares 401 handling, request ids

await rooms.qa.ask({ tenantId, roomId, text }); // typed because qaPlugin() is in dr's plugin list
const up = rooms.uploads.start({ tenantId, roomId, parentId, files });
up.on('progress', (p) => setProgress(p.ratio));
await up.done;
```

The type inference walks `typeof dr` (core groups, plus `plugins[number]['endpoints']`, plus additional fields), following the Better Auth and Better IAM `$Infer` style.

---

## 13. Framework integrations

Each package follows its Better IAM counterpart and **reuses the IAM session already resolved by the Better IAM adapter**, so each request authenticates once.

| Package                                 | Surface                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `better-files/next`                     | `createBetterFilesNext(dr, opts)` returns: `handlers()` (`GET`/`POST`/`PUT`/`OPTIONS` for `app/api/better-files/[...path]/route.ts`); `server` (a typed server client for RSC and server actions that reads `cookies()`/`headers()`); `page(fn, { room, capability })` and `action(fn, { capability })` guards; `redirectIfNdaPending`. `better-files/next/edge` provides edge-safe ticket verification for file routes. |
| `better-files/nestjs`                   | `BetterFilesModule.forRoot({ dr, mount: true, guard: true })`, `BetterFilesService` (injectable `dr`), `@RequireCapability('VIEW', { node: 'params.documentId' })`, `@CurrentRoom()`, `@CurrentCapabilities()`, and an exception filter that maps `BetterFilesError` to HTTP. Works with Express and Fastify platforms.                                                                                                  |
| `better-files/express`                  | `createBetterFilesExpress(dr, { serve })` returns `middleware` (mounts the protocol and adds `req.betterFiles`), `requireCapability(cap, { node: req => … })` and `errorHandler`.                                                                                                                                                                                                                                        |
| `better-files/hono`                     | Middleware, `c.get('betterFiles')` and guards. Uses the fetch `handler`, so it runs on Bun or Deno for JSON routes and Node for streaming encryption.                                                                                                                                                                                                                                                                    |
| `better-files/fastify`                  | A plugin that adds `request.betterFiles` and `preHandler` guards.                                                                                                                                                                                                                                                                                                                                                        |
| `better-files/react-router`             | Middleware and loader/action guards.                                                                                                                                                                                                                                                                                                                                                                                     |
| `better-files/svelte/kit`               | `handle`, `locals.betterFiles`, and load/action guards.                                                                                                                                                                                                                                                                                                                                                                  |
| `@better-files/nuxt`                    | A module that mounts the protocol in Nitro, auto-imports composables and adds `definePageMeta({ betterFiles: { capability } })`.                                                                                                                                                                                                                                                                                         |
| `better-files/middleware`               | Framework-neutral `resolveBetterFilesRequest(dr, { headers, iamSession? })`.                                                                                                                                                                                                                                                                                                                                             |
| `better-files/react`, `/vue`, `/svelte` | Provider, `useRoom`, `useFolder`, `useCapabilities` (batched), `useUpload`, `useActivity`, and plugin hooks.                                                                                                                                                                                                                                                                                                             |
| `better-files/viewer`                   | The `<bf-viewer>` element, plus a thin React wrapper.                                                                                                                                                                                                                                                                                                                                                                    |

Every framework package gets its own `tests/tsconfig.<framework>.json` typecheck project and an integration test that boots a real framework instance, as Better IAM does.

---

## 14. Plugin system and first-party plugins

### 14.1 Contract

This is designed to cover the gaps Better IAM plugins have: plugins can own tables, stream, and get client typings.

```ts
export interface BetterFilesPlugin<Id extends string = string> {
  id: Id;
  schema?: Record<string, TableDefinition>; // own tables; also generated into Drizzle/Prisma
  extendSchema?: Partial<Record<CoreTable, { additionalFields: Record<string, FieldDefinition> }>>;
  migrations?: Migration[];
  capabilities?: Record<string, { bit: number; description: string }>;
  actions?: string[]; // forwarded to the IAM plugin catalog
  endpoints?: Record<string, EndpointDefinition>; // JSON: dr.api[pluginGroup][method] + typed client
  streams?: StreamRoute[]; // raw routes (uploads, tiles, exports)
  jobs?: Record<string, JobHandler>;
  hooks?: Partial<{
    beforeUpload;
    afterUpload;
    afterVersionReady;
    beforeView;
    beforeDownload;
    afterDownload;
    beforePermissionChange;
    afterPermissionChange;
    beforeInvite;
    afterMemberJoined;
    onRoomStatusChange;
    beforeDelete;
    clampCapabilities; // clamp = subtract bits (e.g. NDA pending)
  }>;
  events?: string[]; // declared event names for typing
  resolverAttributes?(node): Record<string, string | number | boolean>; // exposed to IAM policies
  maintain?(ctx): Promise<void>; // called by dr.maintain()
  init?(ctx): void | Promise<void>; // validates config and dependencies on other plugins
  $Infer?: unknown; // type-only helpers
}
```

- `before*` hooks run inside the engine transaction and can veto an operation with a `BetterFilesError`.
- Plugins may declare `dependsOn: ['processing']`.
- The host's own `hooks` option uses the same shape. That lets an app add DLP, custom classification or ERP linking without writing a plugin.

### 14.2 First-party plugins

| Plugin          | What it adds                                                                                                                                                                                                                                                             | Notable integrations                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nda`           | Versioned per-room NDAs, click-through or e-signed, per-group requirement, re-acceptance, `clampCapabilities` until accepted                                                                                                                                             | IAM `resolveContext` attribute; `esign` for signed NDAs                                                                                            |
| `watermark`     | Watermark profiles with variables (`{email}`, `{name}`, `{ip}`, `{time}`, `{room}`, `{index}`), tiled or diagonal; applied to tiles and downloads; forensic IDs later                                                                                                    | pdf-lib and sharp as optional peers                                                                                                                |
| `processing`    | Scan, convert, preview tiles, text and OCR, thumbnails                                                                                                                                                                                                                   | ClamAV, Gotenberg, tesseract.js                                                                                                                    |
| `links`         | Dropbox-style share links: target, preset, expiry, view cap, password (argon2id), email verification, NDA                                                                                                                                                                | Each link is an IAM service identity; visitors get an STS session with `visitorEmail`/`linkId` session tags; disabling a link revokes its sessions |
| `qa`            | Question → triage → assign → draft → approve → publish/close; per-group limits; categories; SLAs; Excel import and export                                                                                                                                                | `ai` drafts; `notifications`                                                                                                                       |
| `tasks`         | Milestone checklists (DocuSign Rooms-style), requirements satisfied by documents, reminders, ICS                                                                                                                                                                         | `templates`                                                                                                                                        |
| `search`        | `/sql` (PG FTS / FTS5), `/meilisearch`, `/opensearch`; permission-filtered results and snippets                                                                                                                                                                          | `processing` text                                                                                                                                  |
| `templates`     | Room templates (folder skeleton, groups, presets, settings, NDA, checklists, metadata fields); built-ins for M&A sell-side, fundraising, board portal, real estate, audit evidence and litigation                                                                        | Configuration as code via the CLI                                                                                                                  |
| `retention`     | Legal holds (room, subtree, custodian), retention rules, trash, archival export (encrypted zip plus manifest and offline index)                                                                                                                                          | IAM security audit; `privacy:erasure`                                                                                                              |
| `analytics`     | Engagement by group, member, document and page; "who hasn't viewed"; exports                                                                                                                                                                                             | `activity`                                                                                                                                         |
| `notifications` | Instant or digest emails through the host's mailer or Better IAM delivery; per-member preferences                                                                                                                                                                        | Host `Mailer`                                                                                                                                      |
| `redaction`     | Manual, pattern and AI-suggested redaction, burned into a new version                                                                                                                                                                                                    | `ai`, `processing`                                                                                                                                 |
| `esign`         | Envelopes, recipients, routing, fields, ceremony helpers (headless), PAdES sealing with a KMS key or Better IAM private-CA certificate, certificate of completion; `/docusign` and `/dropbox-sign` providers                                                             | IAM email/SMS codes for signer verification                                                                                                        |
| `sync`          | `changes.list({ cursor })` delta feed, content hashes, conflict rules; CLI `better-files sync`                                                                                                                                                                           |                                                                                                                                                    |
| `connectors`    | Imports from Dropbox, Google Drive, OneDrive, Box and SFTP, keeping structure; tokens kept in the Better IAM secrets vault                                                                                                                                               | SSRF guard                                                                                                                                         |
| `ai`            | Permission-aware RAG (the ACL filter runs **before** retrieval), summaries, Q&A drafts, classification, PII detection; `AiProvider` port with a Claude default (`claude-sonnet-5`; `claude-haiku-4-5-20251001` for tagging); vector adapters for pgvector and sqlite-vec | Better IAM inference budgets and metering                                                                                                          |
| `mcp`           | MCP tools (`rooms.list`, `documents.search`, `documents.readText`, `qa.draftAnswer`), gated by `better-iam/mcp` and run as delegated agent identities                                                                                                                    |                                                                                                                                                    |

---

## 15. Background work without a worker app

A library can't assume it has its own processes. Better Files follows Better IAM's model (`iam.events.dispatch()`, `iam.guests.sweep()`, `iam.auth.dispatchOutbox()`), where the **host schedules the work**:

| Runner option                                                                       | Behavior                                                                                                                         | Good for                                                    |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `jobs: { runner: 'inline' }` (default)                                              | Jobs run in the background of the same process after the request's transaction commits, with retries tracked in the `jobs` table | Development, small apps, single-server deployments          |
| `jobs: { runner: 'deferred' }`                                                      | Jobs are only enqueued; the host calls `dr.jobs.work()` from its own worker process, cron job or queue consumer                  | Serverless (Vercel/Netlify), apps that already have workers |
| `jobs: { runner: bullmqRunner(queue) }` / `pgBossRunner(boss)` / custom `JobRunner` | Jobs go to the host's existing queue                                                                                             | Apps with Redis/BullMQ, pg-boss, SQS, Inngest, Trigger.dev  |

Maintenance is a single call to `dr.maintain()`, run every few minutes. It handles expirations, retention, trash, digests, ticket cleanup, reconciliation samples and plugin `maintain` hooks.

The examples show how to call it from:

- a Next.js cron route;
- a NestJS `@Cron()` job;
- a node-cron job in Express;
- a BullMQ repeatable job.

---

## 16. Security model

| Threat                                  | Control                                                                                                                                                                                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IDOR or cross-tenant reads              | `tenant_id` on every row, re-checked on every `get`; optional Postgres RLS; tests over `OPERATION_MATRIX` that try every tenant crossing                                                                                     |
| Privilege escalation through the matrix | `MANAGE` is required on the subtree, and grants are capped at the granter's own effective mask                                                                                                                               |
| Guests over-reaching                    | IAM guest boundary, room policy templates and invariants; guests cannot create rooms, links or groups by default                                                                                                             |
| Link leakage                            | Short, checksummed, revocable `bfl_…` tokens; per-link identity and sessions; optional password, email check and view cap                                                                                                    |
| Ticket replay                           | 60-second TTL, single-use nonce, audience binding, optional IP binding                                                                                                                                                       |
| Malicious uploads                       | Quarantine until scanned, content sniffing, zip-bomb limits, converters isolated behind HTTP (Gotenberg); file routes send `nosniff`, `attachment` and a CSP; hosts are told to serve tiles and files from a separate origin |
| XSS through documents                   | Uploaded HTML or SVG is never rendered inline; SVGs are rasterized                                                                                                                                                           |
| SSRF (connectors, webhooks)             | Allow-lists, blocking of private address ranges, DNS-rebinding-safe fetch (the same approach as Better IAM)                                                                                                                  |
| Insider exfiltration                    | Identity watermarks, the anomaly detector feeding IAM threat response, per-group caps, "view only" presets, an audit record for every original download                                                                      |
| Key compromise                          | Rotation and re-wrap, per-room keys, crypto-shredding                                                                                                                                                                        |
| Audit tampering                         | IAM hash chain for security events; the activity hash chain, whose head is periodically anchored into the IAM chain                                                                                                          |
| Session theft                           | Better IAM device-bound sessions, `request.deviceAssurance`, step-up MFA before downloads                                                                                                                                    |
| DoS and cost abuse                      | Rate limits per identity, room and link; quota hooks; job concurrency caps                                                                                                                                                   |
| Supply chain                            | Pinned lockfile, npm provenance, `allowBuilds` allow-list, SBOM attached to releases                                                                                                                                         |

---

## 17. Tooling, testing, CI and releases

### Conventions (identical to Better IAM)

- pnpm 11.x, Node 22.12 or later, ESM only, TypeScript 5.9, `tsc -b` with project references.
- Each package has `rootDir: src` and `outDir: dist`, and exports `{ types, import }` pairs.
- Each manifest sets `files: [dist, README.md, LICENSE]`, `sideEffects: false`, `publishConfig.access: public`, `repository.directory` and Apache-2.0, with all packages on the same version.
- Prettier: single quotes, width 100, trailing commas. The changelog is hand-written.

### Better IAM during development

`better-iam` 0.3.0 is on npm (since 2026-10-07), and the workspace develops and tests against it (a dev dependency,
`^0.3.0`). It is a **peer dependency** of `@better-files/iam` (optional on the umbrella), `>=0.2.0 <0.4.0`, and
`validate-packages` checks every peer range admits the installed release.

- `node scripts/better-iam.mjs link ../better-iam` switches the workspace to a local checkout (built with
  `pnpm build`) to try unreleased Better IAM changes; `node scripts/better-iam.mjs npm` switches back.
- CI's `better-iam-main` job does the same with Better IAM's `main` branch on every push, and `better-iam-0.2`
  runs the suite on 0.2.0, the oldest supported release.
- Features newer than the npm release are detected at runtime (`betterIamFeatures(iam)`), never assumed. Today that
  is **guests** (0.3.0 and later): on 0.2.x, outsiders get member invitations only when the host passes `externalInvites: 'members'`;
  they join the `Better Files outsiders` group, which keeps them `guest: true` for Better Files. Otherwise inviting an
  outsider reports `UNSUPPORTED`. `systemPolicy(iam)` names only the actions that release knows.

### Tests

| Layer                                   | Scope                                                                                                                                                             |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit and property (Vitest + fast-check) | ACL resolution (pure and SQL equivalence), capability math, crypto segmenting, schema model, policy rendering, type inference (with `expectTypeOf`)               |
| Conformance                             | Every database, storage, job runner, search and key adapter                                                                                                       |
| Integration                             | Real Better IAM (`sqliteAdapter(':memory:')`) plus Better Files (SQLite) plus `storage-fs`: room, then invite guest, NDA, view, download, audit verification      |
| Postgres                                | CI service `postgres:17-alpine`: adapter, RLS, partitions, FTS, concurrency                                                                                       |
| Infrastructure (compose)                | MinIO multipart, ClamAV, Gotenberg, Meilisearch                                                                                                                   |
| Frameworks                              | Boot Next.js (route handler test harness), NestJS (`@nestjs/testing`), Express, Hono, Fastify, React Router and SvelteKit, and run the same scenario through each |
| Security                                | Matrix fuzzing across `OPERATION_MATRIX` × roles × guests × tenants × links                                                                                       |
| Examples                                | Each `examples/*` is built and smoke-tested in CI (`examples/shared/smoke.mjs`)                                                                                   |
| Packed                                  | `pack.mjs`, `attw --profile esm-only`, and `packed-smoke.mjs`, which installs the tarballs into a clean Next.js and a clean Nest app                              |
| Bench                                   | 100,000-node rooms, listing p95, upload throughput, watermark throughput                                                                                          |

### CI

- `test`: Ubuntu and Windows × Node 22 and 24, against `better-iam` from npm. Runs `pnpm check`, examples smoke, pack, packed types and packed smoke.
- `postgres` and `infra` jobs.
- `better-iam-main`: typecheck and tests against Better IAM's `main` branch, linked with `scripts/better-iam.mjs`.
- `publish`, on `main`: runs `pnpm publish -r --provenance` if the version isn't on npm yet, then creates a GitHub release.

---

## 18. Phased roadmap

Estimates assume 2–4 senior engineers. Each phase ends with a tagged pre-release and working examples.

### Phase 0: Foundation (1–2 weeks)

- Scaffold the repository exactly as in §5 and §17: scripts, CI, Vitest aliases, `link-better-iam`, test compose.
- `core` skeleton: errors, ids, ports, schema model, plugin contract, the `OPERATION_MATRIX` stub.
- `testing` fakes and the first conformance kit.
- ADRs:
  - ADR-001: two-layer authorization;
  - ADR-002: own tables and consistency;
  - ADR-003: schema model and code generation;
  - ADR-004: crypto format;
  - ADR-005: plugin contract and type inference.
- **Exit:** `pnpm check` passes on Windows and Linux, and `betterFiles()` boots with Better IAM in a test.

#### Implementation status (2026-09-26)

`pnpm check` passes on Windows: typecheck of packages, tests and examples; 50 test files and 277 tests, including
Better IAM end to end; package validation. CI runs the same on Ubuntu and Windows with Node 22 and 24, plus the
conformance suite on PostgreSQL.

| Area               | Delivered                                                                                                                                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core and server    | Rooms, folders, documents, versions, resumable uploads, tickets, trash and retention, exports (streamed ZIP), the two-layer access engine, events and outbox, the hash-chained activity log, `maintain()`                                                                             |
| Better IAM         | Plugin, integration (identity, authz, directory, KMS keys, audit), resolver, access-model and system policies, guests                                                                                                                                                                 |
| Adapters           | SQLite, PostgreSQL, libSQL, PGlite, Prisma and Drizzle over a shared SQL layer, with `better-files generate` for Prisma/Drizzle/SQL migrations; memory; file system, S3-compatible storage, and a storage cluster of your own servers (control plane plus `better-files-node` agents) |
| Client side        | Typed client with parallel resumable uploads and a shared query cache; React hooks, Vue composables and Svelte stores with `<Can>`; the `<bf-viewer>` secure viewer (server-rendered, watermarked pages)                                                                              |
| Frameworks         | Next.js, NestJS, Express, Hono, Fastify, SvelteKit, Nuxt/Nitro (h3 v1 and v2), and any fetch runtime (React Router, Bun, Deno) through `dr.handler`; an OpenAPI 3.1 document (`dr.openapi()`, `better-files openapi`) from Standard JSON Schema                                       |
| Plugins            | nda, watermark, scan, guard, links, qa, webhooks, search, retention, tasks, templates, analytics, notifications, esign, sync, ai, redaction, connectors, processing, quotas, audit, annotations, inbound email                                                                        |
| Agents and tooling | `@better-files/mcp` (MCP server, tools and `mcpPlugin`), `@better-files/cli` (`migrate`, `maintain`, `verify`, `doctor`, `sync pull/push/status`; `npx better-files` from the umbrella)                                                                                               |
| Examples           | quickstart (runs in the test suite), Better IAM + Express, Next.js, NestJS, MCP stdio, CLI config                                                                                                                                                                                     |

Every item in the plan's package map is built. Direct-mode uploads encrypt in the browser (WebCrypto, the server's segment format) and go straight to presigned S3 parts; the server verifies by reading back.

#### Phase 0 status

**Done (2026-09-24).** `pnpm check` passes on Windows: typecheck, 44 tests, and package validation.

Packages:

| Package                 | Contents                                                                                                                                                                                                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `better-files`          | Umbrella: `betterFiles`, `Capability`, `definePlugin`, `endpoint`, `field`; subpaths `/core`, `/server`, `/iam`, `/testing`                                                                                                                                                                               |
| `@better-files/core`    | Errors, ids, capability registry and presets, the reference resolver (`resolveAccess`), schema model with typed additional fields, core tables, ports, Standard Schema validation, operation matrix, plugin contract, `databaseConformanceCases()`                                                        |
| `@better-files/server`  | `betterFiles()`, plugin and schema validation, the access engine (layer A, with room and document clamps and the `better-files:admin` room floor), the endpoint pipeline (both layers), the fetch and Node HTTP handlers, `capabilitiesFor`, `resolveForIam`, type inference for `dr.api` and `dr.$Infer` |
| `@better-files/iam`     | `betterFilesIamPlugin()`, `betterIamIntegration()`, `betterFilesResolver()`                                                                                                                                                                                                                               |
| `@better-files/testing` | `memoryDatabase()` (passes the conformance cases), `memoryStorage()`, `fakeIam()`, `seedRoom()`                                                                                                                                                                                                           |

Not done yet from the Phase 0 list: CI workflow, ADR documents, the Docker test infrastructure, and `link-better-iam`. Better IAM is linked with `link:../better-iam/packages/better-iam` dev dependencies instead.

Findings from integrating with the real Better IAM:

- Resource type names must match `^[a-z][a-z0-9-]{0,63}$`, so the types are `better-files-room`, `better-files-folder` and `better-files-document`.
- When a host sets `resolveResource`, Better IAM also sends external checks on `iam/{tenantId}` to it. `betterFilesResolver` answers those itself before calling the host fallback.
- Checks on `better-files-room/{roomId}` throw `NOT_FOUND` until the room is registered with `resources.register`, so `rooms.create` must register the room before any access check.
- The tenant owner holds every permission, including `better-files:admin`, so owners are room administrators unless a policy says otherwise.
- The `pnpm` shim on this machine fails (`CommandNotFound`) when the workspace root `package.json` has `engines` or `packageManager`. Those fields stay in the packages only. Better IAM's own repository hits the same problem here.

### Phase 1: Core engine and Better IAM integration (4–6 weeks)

- `adapter-kysely`, `adapter-sqlite` and `adapter-postgres`, with migrations for the core tables and support for bringing your own connection.
- `storage-fs` and `storage-s3`; proxy-mode resumable uploads; streaming downloads.
- Core services and ACL resolution (pure and SQL, with property tests).
- `@better-files/iam`:
  - the IAM plugin and resolver;
  - identity and authz providers;
  - room registration;
  - room roles as tuples, and groups mapped to permission groups;
  - guest invitations;
  - `listAccessible` and `authorizeMany` batching.
- HTTP protocol and typed `@better-files/client` (plugin-aware inference from day one).
- `better-files/express`, `better-files/hono` and the `sqlite-minimal`, `express` and `hono` examples.
- **Exit:** create a room, folders and groups; invite an internal user and a guest; upload; list with a correct matrix; download. IAM `whoCan` agrees with the engine at room level. Tests pass on SQLite and Postgres.

### Phase 2: Next.js, NestJS and the client side (3–4 weeks)

- `better-files/next` (handlers, server client, guards, edge ticket verification) and `better-files/nestjs` (module, guard, decorators, mount).
- `better-files/fastify`, `better-files/react-router` and `better-files/react` hooks.
- The `nextjs` and `nestjs` examples, as full reference integrations using `better-iam/next` and `better-iam/nestjs`.
- The `adapter-drizzle` / `adapter-prisma` bridges and `better-files generate`.
- **Exit:** a new Next.js or Nest app gets working data rooms in under 30 lines of integration code, verified by packed-smoke tests.

### Phase 3: Security features (4–5 weeks)

- `crypto` with KMS envelope encryption through Better IAM, per-room keys and crypto-shredding.
- Tickets with `assertions.issue` and single-use nonces.
- Job runners (inline, deferred, BullMQ, pg-boss) and `dr.maintain()`.
- Plugins: `processing`, `watermark`, `nda` and `links`.
- The `<bf-viewer>` element.
- Room security settings compiled to IAM policies; guest boundary and invariants helpers.
- Activity chain; security audit into the IAM chain; the anomaly detector feeding IAM threats.
- **Exit:** the security suite passes. A guest in a restricted room can only see watermarked tiles, and only after MFA, NDA acceptance and connecting from an allowed IP.

### Phase 4: Collaboration plugins (4 weeks)

- Plugins: `qa`, `tasks`, `templates` (with dynamic metadata), `search` (sql, then meilisearch), `retention`, `analytics` and `notifications`.
- `better-files/vue`, `better-files/svelte` and `@better-files/nuxt`.
- **Exit:** a full M&A sell-side scenario (three bidder groups, Q&A, staged publishing, closing and archival export) runs in integration tests through at least two frameworks.

### Phase 5: E-signature (4–6 weeks)

- The `esign` plugin: native envelopes, headless ceremony helpers plus hooks, PAdES sealing with a KMS key or a Better IAM private-CA certificate, and a certificate of completion.
- `/docusign` and `/dropbox-sign` providers.
- **Exit:** a signed PDF validates in Adobe Reader against a test CA.

### Phase 6: Dropbox-like reach and AI (6–8 weeks)

- Plugins: `sync` (plus CLI sync), `connectors`, `redaction`, `ai` and `mcp`.
- **Exit:** adversarial retrieval tests show the AI never cites pages the user can't see, and sync handles offline edits and conflicts.

### Phase 7: Hardening and 1.0 (4–6 weeks)

- Performance targets met; Postgres partitioning; BYOK key providers (done: `@better-files/kms` for AWS KMS, Cloud KMS, Azure Key Vault and Vault Transit, with provider migration); per-room storage for data residency; forensic watermarks.
- Complete docs (a guide per framework and plugin, plus the API reference), an external security review and the 1.0 release.

---

## 19. Upstream Better IAM work track

Since you own Better IAM, these changes (in priority order) would simplify Better Files and also benefit other Better IAM users:

1. **N-level ancestor relations** and **self-parenting types** (G1).
2. **Indexed tuple loading** for the resource's own chain instead of all tenant tuples (G8).
3. **A plugin audit API** (`ctx.audit(action, resource, metadata)`) and opt-in auditing of allowed decisions for chosen actions (G5).
4. **Plugin client typings** in `createIamClient<typeof iam>` (G4).
5. **A shared-transaction hook**, so a companion library in the same database can commit atomically with IAM writes (G2). This removes most of the reconciler.
6. **Streaming and GET plugin routes** (G3).
7. **Resource-scoped agreements** without the 50 limit (G6).
8. **Link principals** (G7).
9. **Custom threat rules** and **resource legal holds** (G9, G10).
10. **Resource re-parenting**, and **external KMS backends**.
11. **Optional framework peers.** `better-iam` depends on `@better-iam/{next,react,vue,svelte,nestjs,react-router}`, whose
    framework peers (`next`, `react`, `vue`, `svelte`, `@nestjs/core`, …) are required, so `npm install better-iam`
    installs every framework plus `sharp` (through `next`). Marking them optional in each binding's
    `peerDependenciesMeta` fixes it. **Done in better-iam 0.3.0**; `pnpm smoke:packed` no longer warns.

Better Files keeps a fallback for each until its minimum supported Better IAM version includes the change.

---

## 20. Risks and mitigations

| Risk                                                              | Mitigation                                                                                                                             |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| IAM and Better Files tables drift apart                           | IAM is authoritative for membership; ordered writes, outbox and reconciler; access fails closed; upstream item 5                       |
| IAM's global write lock under heavy churn                         | Keep IAM writes coarse (room and group level); batch invites; benchmark; upstream item 2                                               |
| Serverless hosts can't stream large bodies or run long jobs       | Direct upload mode with client-side encryption, the deferred runner, and edge ticket verification                                      |
| Heavy native dependencies (sharp, pdf tools) make installs harder | Optional peer dependencies loaded lazily; the Gotenberg HTTP converter keeps LibreOffice out of the host                               |
| Type inference becomes slow or brittle with many plugins          | A type-performance benchmark (`tsc --extendedDiagnostics`) in CI; explicit `$Infer` helpers                                            |
| Better IAM 0.x API churn                                          | Pinned peer range, a compat CI job, and the provider ports as a buffer                                                                 |
| Scope creep (VDR + Dropbox + DocuSign + AI)                       | Everything beyond the core is a plugin with its own exit criteria                                                                      |
| Legal validity of e-signatures                                    | Start with simple or advanced electronic signature evidence; use provider connectors for qualified signatures; legal review before 1.0 |

---

## 21. Decisions

### Decided

- **npm naming:** the library is **`better-files`**, the package apps install, with subpath imports (`better-files/next`, `/iam`, `/testing`, …). The separately publishable parts are `@better-files/<part>` (`-core`, `-server`, `-iam`, `-testing`, and later `-next`, `-nestjs`, `-adapter-postgres`, `-plugin-qa`, …). This mirrors `better-iam` plus `@better-iam/*`.
- **Factory name:** `betterFiles()`, mirroring `betterIam()`.
- **Better IAM dependency:** a peer dependency of `@better-files/iam` (optional on the umbrella package). Core and server depend only on the ports.
- **Validation:** endpoint inputs accept any [Standard Schema](https://standardschema.dev) validator (zod, valibot, arktype). Better Files does not depend on one.

### Open

1. **Default adapter core:** Kysely (recommended), with Drizzle and Prisma bridges.
2. **Default NDA mode:** the native per-room plugin (recommended) or IAM agreements.
3. **Viewer default:** server tiles only (recommended), or also allow a pdf.js client render for users who can download.
4. **Which frameworks ship in Phase 2** beyond Next.js and NestJS.
5. **Upstream appetite:** which §19 items should land before Better Files 1.0.

---

## 22. Appendix: integration sketches

### 22.1 Next.js (App Router)

```ts
// lib/better-files.ts
export const dr = betterFiles({ iam: betterIamIntegration(iam), database: postgresAdapter({ pool }), storage, plugins });
export const drNext = createBetterFilesNext(dr, { loginPath: '/login' });

// app/api/better-files/[...path]/route.ts
export const { GET, POST, PUT, OPTIONS } = drNext.handlers();

// app/rooms/[roomId]/page.tsx — a server component using the typed server client
export default drNext.page(async ({ params }, { server }) => {
  const folder = await server.folders.list({ roomId: params.roomId });
  return <MyFileTable items={folder.items} />;              // your own UI
}, { capability: 'LIST', node: ({ params }) => params.roomId });

// app/rooms/[roomId]/actions.ts
export const renameDocument = drNext.action(async ({ documentId, name }, { server }) =>
  server.documents.rename({ documentId, name }), { capability: 'EDIT', node: (i) => i.documentId });
```

### 22.2 NestJS

```ts
@Module({
  imports: [
    IamModule.forRoot({ iam, guard: true, mount: true }),
    BetterFilesModule.forRoot({ dr, mount: true }),
  ],
})
export class AppModule {}

@Controller('deals/:dealId/documents')
export class DealDocumentsController {
  constructor(private readonly rooms: BetterFilesService) {}

  @Get(':documentId/download')
  @RequireCapability('DOWNLOAD_WATERMARKED', { node: 'params.documentId' })
  download(@Param('documentId') id: string, @CurrentIdentity() who: Identity) {
    return this.rooms.api.documents.requestDownload(
      { session: who.session },
      { documentId: id, variant: 'watermarked' },
    );
  }
}
```

### 22.3 Express

```ts
const iamExpress = createIamExpress(iam);
const drExpress = createBetterFilesExpress(dr);
app.use(iamExpress.middleware);
app.use(drExpress.middleware); // mounts /api/better-files, adds req.betterFiles
app.post(
  '/deals/:id/publish',
  drExpress.requireCapability('MANAGE', { node: (req) => req.params.id }),
  async (req, res) => res.json(await req.betterFiles.api.rooms.publish({ roomId: req.params.id })),
);
app.use(drExpress.errorHandler);
```

### 22.4 React (headless)

```tsx
<IamProvider client={iamClient}>
  <BetterFilesProvider client={roomsClient} tenantId={tenantId}>
    <MyRoomPage roomId={roomId} />
  </BetterFilesProvider>
</IamProvider>;

function MyRoomPage({ roomId }) {
  const { items, isLoading } = useFolder({ roomId });
  const caps = useCapabilities(items.map((i) => i.id)); // one batched call
  const upload = useUpload({ roomId });
  return (
    <YourDesignSystemTable
      rows={items}
      canDownload={(id) => caps.has(id, 'DOWNLOAD_WATERMARKED')}
      onDrop={upload.start}
    />
  );
}
```

### 22.5 A custom plugin in the host app

```ts
const dealCodePlugin = definePlugin({
  id: 'deal-code',
  extendSchema: {
    rooms: { additionalFields: { dealCode: field.string({ indexed: true, required: true }) } },
  },
  hooks: {
    async beforeDownload({ room, principal }) {
      if (room.dealCode.startsWith('RESTRICTED') && principal.guest)
        throw forbidden('Restricted deal');
    },
  },
  endpoints: {
    byDealCode: endpoint({
      input: z.object({ dealCode: z.string() }),
      action: 'better-files:rooms:read',
      handler: ({ db, tenantId }, { dealCode }) => db.rooms.findOne({ tenantId, dealCode }),
    }),
  },
});
// → dr.api.dealCode.byDealCode(...) and rooms.dealCode.byDealCode(...) are typed automatically
```

---

### Immediate next steps

1. Settle §21 (naming, factory name, Kysely, NDA default).
2. Phase 0: scaffold the monorepo per §5 and §17, and wire `link-better-iam`.
3. Write ADR-001 to ADR-005 before any service code.
4. Open Better IAM issues for upstream items 1–5.
