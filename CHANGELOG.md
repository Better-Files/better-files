# Changelog

## Unreleased

- **better-iam 0.3.** Better Files now supports `better-iam` `>=0.2.0 <0.4.0` and develops against 0.3.0. On 0.3,
  outsiders are invited as Better IAM guests by default, and `systemPolicy(iam)` includes the guest actions: update
  the service account's role after upgrading. 0.3 also stops installing every framework through Better IAM's
  bindings. CI runs the suite against 0.3, 0.2.0 and Better IAM's `main` branch. See the docs' release compatibility
  page for the upgrade notes.
- **Railway.** `railway.json` deploys the docs site with `apps/docs/Dockerfile`.

- **Renamed to Better Files.** The umbrella package is `better-files` (was `@better-iam/datarooms`). The parts are
  `@better-files/<name>` (was `@better-iam/datarooms-<name>`), and the CLI is `better-files`. APIs follow:
  - `betterFiles()` (was `dataRooms()`), `BetterFilesError`, `BetterFilesPlugin`, `betterFilesIamPlugin`, and so on.
  - The identity-system action namespace is `better-files:` (was `datarooms:`), and the resource types are
    `better-files-room`, `better-files-folder` and `better-files-document`.
  - The CSRF header is `X-Better-Files`, and the default base path is `/api/better-files`.
  - Table prefixes are `better_files_`, environment variables `BETTER_FILES_*`, and the viewer element
    `<bf-viewer>`.
  - "Data room" stays the name of the concept (`Room`, `DataRoomNode`).
- Core: ids made in the same millisecond now sort in creation order (monotonic ULIDs), so records inserted together
  list back in that order. This fixes a flaky e-signature provider test.
- Core: plugins can refuse room and node operations with a `gateRoom` hook once both authorization layers pass. The
  NDA plugin uses it to keep plugin room features closed until the NDA is accepted. Operations marked `ungated`
  (`network.status`) skip it.
- `@better-files/telemetry` is marked private until it is finished, and private packages are left out of the
  umbrella and of publishing.

- Security (webhooks): deliveries now go through Node's HTTP client with a connect-time address check, which closes a
  DNS-rebinding SSRF (the host was checked, then resolved again by `fetch`). The address policy now also covers
  IPv4-mapped IPv6 in hex, NAT64, 6to4, Teredo, multicast, reserved and benchmarking ranges. Each delivery is claimed
  before it is sent, so immediate delivery and `dr.maintain()` (or several instances) no longer send it twice.
  `rotateSecret` keeps signing with the old secret for `secretRotationGraceMs` (default 24 h), and
  `verifyWebhookSignature` accepts any `v1` in the header. Response bodies are discarded instead of leaking sockets.
  A custom `fetch` option still works, but gets only the pre-check.
- Security fix: earlier versions of a document now need `EDIT` on it. Before, anyone who could view or download
  the current version could open any earlier one by `versionId`, including the unredacted original that
  `redaction.apply` replaced. `versions.list` shows readers only the current version. `documents.request*`,
  `viewer.open` and `viewer.pages` refuse earlier versions for them with `FORBIDDEN`.
- Security tests: `tests/server/security-matrix.test.ts` tries every core operation as another tenant, a
  same-tenant stranger, and a removed or suspended member, and checks that nothing changes or leaks. It also checks
  every room relation against the access model, and fails when an operation has no case. File tickets are tested
  for tampering, expiry, the use cap, deleted documents and refusal headers.

- Cloud storage: `@better-files/storage-gcs` (`gcsStorage`) and `@better-files/storage-azure`
  (`azureBlobStorage`, `parseConnectionString`) run over `fetch`, with no Google or Azure SDK. Both pass the storage
  conformance suite and serve normal and direct (browser-encrypted) uploads end to end.
  - GCS mints service-account tokens and signs V4 URLs. Its multipart uploads compose temporary part objects in
    rounds of 32, with generation preconditions.
  - Azure signs Shared Key requests and service SAS URLs. Its multipart uploads map onto staged blocks, and it polls
    pending copies.
  - Signatures are cross-checked against `@azure/storage-blob` and `@google-cloud/storage`.
  - The client accepts `Content-MD5` when a store answers a direct part upload without an `ETag` (Azure `Put Block`).
- PostgreSQL partitioning (PLAN Phase 7): `postgresAdapter({ partitions: { activity: { interval: 'month' } } })` (and
  `pgliteAdapter`) creates range-partitioned tables with a default partition. `partitionsPlugin(database)` keeps
  ranges ready from `dr.maintain()`, moves stray rows out of the default partition, and detaches or drops partitions
  beyond `retain`. `database.partitions.convert()` converts an existing table, and `status()` reports on partitions.
  `generateSchema` emits the same DDL. Tables whose unique indexes would weaken need `relaxUnique`, and the conformance
  suite passes on a partitioned table.
- Network rules: `@better-files/plugin-network` adds per-room IP allow-lists (PLAN §10.4 `allowedIpRanges`)
  for guests or everyone. From any other address a restricted participant gets no capabilities in the room, not even
  names. An unknown address is refused unless `unknownAddress: 'allow'` is set. Owners and administrators are exempt,
  and `network.status` lets clients explain an empty room. IPv4, IPv6 and IPv4-mapped addresses are supported, and
  `ipInRanges` is exported.
- Fix (security): a folder ZIP of originals (`folders.requestDownload({ variant: 'original' })`) no longer skips the
  room's `requireMfaForDownload`.
- `dr.api` calls are typed with the optional third `request` argument (`{ ip, userAgent }`) the runtime already took,
  so server actions and controllers can pass the client's address to the activity log and network rules.
- Tests: the Phase 3 exit scenario. A guest is gated by network, NDA and MFA, sees watermarked viewer pages and never
  originals (`tests/integration/restricted-guest-scenario.test.ts`).

- Metering in Better IAM billing: `betterIamMetering(iam)` (`@better-files/plugin-quotas`) records
  usage on Better IAM meters after each change commits: stored and served bytes, downloads (ZIPs per file), views,
  rooms, and active participants. Usage is written by durable `metering.record` jobs that retry while Better IAM is
  down, and it is idempotent per event and tagged with the room. `meteringMeters()` lists
  the meter definitions for `billing.createMeter`. `enforceBudgets` refuses work once an enforced Better IAM budget
  is spent. `quotas` counts per-person Better IAM quota plans (for example, downloads a day for guests). Tested
  against better-iam 0.2.0 from npm.

- E-signature providers: `esignPlugin({ provider })` runs signing ceremonies at DocuSign (`docusignProvider`, with
  `docusignJwtAuth`) or Dropbox Sign (`dropboxSignProvider`), over `fetch` with no SDKs. Envelopes are still
  prepared and tracked in the room. `esignWebhook(dr, provider)` verifies the provider's webhook signature and calls
  the new `esign.sync`, which reads the envelope's state from the provider's API (it never trusts the webhook's
  contents), records recipient progress in the evidence chain, and on completion stores the provider-sealed PDF (and
  DocuSign's certificate) next to the original, exactly once even under a burst of webhooks. `esign.void` and
  `esign.remind` act at the provider. `deliver` is now optional when a provider is configured.

- Queue runners: `@better-files/jobs` (`better-files/jobs`) runs `dr.jobs` on BullMQ
  (`bullmqRunner`, `bullmqProcessor`) or pg-boss (`pgBossRunner`, `pgBossHandler`) with the host's own `Queue`,
  `Worker` or `PgBoss`. It does not depend on either library. The queue only delivers: its retries are off, and a
  message carries just the job's id, tenant and name, so the queue never holds room data. Attempts, backoff and
  failures stay in the Better Files `jobs` table. A retry is a new delivery, and `dr.maintain()` runs anything the
  queue loses after `recoverAfterMs` (5 minutes by default).

- Data residency: `@better-files/storage-regional` routes each room's files to the storage of its region.
  `rooms.create({ region })` picks the region (or the per-tenant `defaultRegion`, limited by `allows`), and the room
  records it (`rooms.region`). Its files' keys start with `g/{region}/`, so routing needs no lookups. `moveRoom()`
  relocates a room's files resumably. `KeyProvider.createRoomKey` receives the region.
- Bring your own key: `@better-files/kms` (`better-files/kms`) wraps data keys with AWS KMS,
  Google Cloud KMS, Azure Key Vault / Managed HSM or HashiCorp Vault Transit over `fetch`, with no SDKs. Each data key
  is bound to its blob's encryption context, `perRoomKeys` gives every room its own key that is retired when the
  room is deleted, and key references are checked against the configured vault or key ring before a token is sent.
  `regionalKeys` keeps each room's keys in its data-residency region's KMS, `migratingKeys` moves an installation to
  another provider without re-encrypting files, and `cachingKeys` keeps unwrapped keys in memory for a bounded time.

- Search backends: `searchPlugin({ backend })` takes a `SearchBackend`. `sqlSearchBackend()` is the default and
  behaves as before. `meilisearchBackend({ host, apiKey, index })` keeps the index and extracted text in Meilisearch
  over HTTP, with no SDK, and adds typo tolerance, prefix matching and ranking. It creates and configures the index
  on first use, keeps text across renames and drops deleted rooms. Results are still checked against Better Files'
  tables (tenant, room, trash, `LIST`/`VIEW`), so a stale or shared index can't leak anything.
  `search.reindex` no longer builds a full `MaintenanceContext`. Search snippets are left out for documents
  flagged `viewOnly` or `noCopy` unless the caller has `COPY_TEXT`.
- AI security fixes (`plugin-ai`), with adversarial retrieval tests for the Phase 6 exit
  (`tests/plugins/ai-adversarial.test.ts`):
  - Retrieval goes through the search plugin's backend instead of reading `searchEntries`, so it also works with
    Meilisearch.
  - Candidates must belong to the asked room. Before, a stale or poisoned index row could pull in a document from
    another room the asker could view.
  - View-only and no-copy documents reach the model only for people with `COPY_TEXT`. New option:
    `requireCopyText`.
  - Citations are kept only when they quote a document the asker was given.

- Retention rules: `retention.addRule` keeps documents in a room or folder for a minimum number of days. Deleting
  them, purging them from the trash and deleting the room are refused until then, and `locked` rules cannot be
  removed. Fix: `closedRoomRetentionDays` notifications no longer stall when 100 or more closed rooms are on hold.
- Fix: moving a document or folder out of a held folder (or a folder under a retention rule) is refused with
  `LEGAL_HOLD`. Before, a move released the content, which could then be deleted.

- Koa and React Router: `better-files/middleware/koa` (`createBetterFilesKoa`: streaming protocol middleware,
  `ctx.state.betterFiles`, route guards, an error handler) and `/middleware/react-router` (`createBetterFilesRouter`: a
  resource route for the protocol, plus `guard` and `action` wrappers that check the permission matrix, for React Router
  framework mode and Remix). Neither imports its framework.
- Access reviews: `@better-files/plugin-reviews` runs room access certifications. A review snapshots the
  participants (role, groups, guest status and last activity) with keep or revoke recommendations. Reviewers decide
  per person but never on their own access. Completion removes revoked people from the room and from Better IAM's
  groups and tuples. `dr.maintain()` can start reviews on a schedule and reports overdue ones. With
  `betterIamAccess(iam)`, Better IAM's `policies.whoCan` adds people who reach the room outside its roster. Revoking
  them is flagged for a policy change (`review.iam-access-flagged`).
- Guard and Better IAM threats: `betterIamThreats(iam, { credential, actions })` raises a bulk downloader's
  Better IAM risk (`threats.setRisk`, read by policies as `principal.riskLevel`) and runs `threats.respond` actions
  (end sessions, notify, block the network). With the guard's new `risk` gate, people Better IAM rates high risk,
  for any reason, are refused downloads and views in every room. It fails open if the lookup fails. Tested against
  Better IAM 0.2.0 from npm with a service account key (`threatsPolicy()`).
- Fix (guard): every file in a folder ZIP now counts toward the download limit, within one request and across
  requests (before, ZIPs bypassed it). The "report once per window" rule now holds across servers.

- IAM reconciler: `reconcileIam(dr, { tenantId, repair })` (`@better-files/cli`) and `better-files reconcile`
  compare Better IAM room relations and permission-group memberships with the room rosters. They report missing,
  stale and lingering relations, missing and lingering group memberships, orphan relations, unregistered rooms and
  rooms stuck provisioning, and repair them (orphans only with `--revoke-orphans`). Tested on Better IAM 0.2.0 from
  npm.
- Next.js on `better-iam/next`: `createBetterFilesNext(dr, { iamNext: createIamNext(iam) })` reads the visitor's
  credential through Better IAM. `drNext.request()` / `session()` return the API bound to it and to the tenant the
  session acts in (`tenant.rooms.get({ roomId })`), and `capabilities()` takes the tenant from the session. The
  Next.js example drops its pinned tenant.
- MCP on `better-iam/mcp`: `betterIamToolRules(dr, { tenantId })` gives Better IAM's MCP gate a rule per Better Files
  tool (its Better Files action on `better-files-room/…`, `better-files-document/…`, `better-files-folder/…` or `iam/{tenant}`). Agent
  policies, delegation confirmations and `tools/list` filtering then apply to Better Files tools. `sessionTenant(iam)`
  takes the MCP server's tenant from the caller's session.

- Faster access checks: `createAccessIndex({ entries, subjects, now })` prepares a principal's permission cells once,
  so resolving many paths costs O(subjects × depth) each. The access engine uses it and groups closure rows by node,
  so listing a large folder is no longer quadratic in its size. Property tests check the resolver against the written
  rules and the index against the resolver on random trees.

- Packed smoke test: `pnpm smoke:packed` (also in CI) installs the packed tarballs with npm into a clean app with
  `better-iam` from the registry, checks for required heavy peers, typechecks the packed declarations, runs
  Better Files on Better IAM end to end and imports every subpath. `validate-packages` now refuses required
  third-party peers.
- Fix: `vue` (`-vue`) and `@electric-sql/pglite` (`-adapter-pglite`) are optional peers, so installing
  `better-files` with npm no longer installs Vue and PGlite into every app.
- Better IAM from npm: the workspace now installs `better-iam` 0.2.0 from npm instead of a sibling checkout, and
  `betterIamFeatures(iam)` detects what a release offers. `scripts/better-iam.mjs link <path>` switches to a local
  checkout, and CI's `better-iam-main` job tests against Better IAM's `main` branch.
- Outsiders on Better IAM without guests: `betterIamIntegration(iam, { externalInvites: 'members' })` invites them
  as tenant members into the room's groups and a `Better Files outsiders` group, which keeps them `guest: true`. Without
  that option, such invitations report `UNSUPPORTED` instead of failing on a missing API.
- `systemPolicy(iam)` names only the actions the release knows (0.2.0 refuses roles naming `iam:guests:*`), and now
  includes `iam:identities:create` and `iam:guests:manage`.
- Fix: removing a member who has not accepted yet now withdraws their invitation (`IamDirectory.revokeInvitation`),
  so an old link no longer adds them to the room's groups.
- Fix: `dr.maintain()` now also takes members whose access window ended out of the room's groups and relations in the
  identity system, not only in the roster.
- Fix: the storage node agent no longer sends two heartbeats with the same timestamp, which the control plane refused
  as replays.
- Tests: the Phase 4 exit scenario (an M&A sell-side process with three bidder groups, team-private Q&A, staged
  publishing, closing, an archival export and archiving) runs end to end through the typed client on Express, Hono
  and Next.js (`tests/integration/sell-side-scenario.test.ts`).

- Email to a room: `@better-files/plugin-inbound` adds per-folder drop addresses with sender allow-lists,
  expiry and provider authentication (with a Postmark adapter).
- Room duplication: `templates.capture` makes a template from a room (folders, per-folder group access, groups,
  settings, checklists) and `templates.duplicateRoom` creates a room from it; templates can now carry folder access.
- Bulk invitations: `members.inviteMany` accepts a list or CSV and reports each row.

- Schedules: `dr.maintain()` closes rooms when their `closesAt` passes (as the system, recorded in the activity
  log) and marks members whose access window ended as `expired`; reopening clears a past close date.
- Annotations: `@better-files/plugin-annotations` adds page-anchored notes and highlights, private,
  group-shared or room-wide, with replies and resolution.

- Live activity: `GET {basePath}/rooms/{roomId}/events` (Server-Sent Events from the hash-chained log, resumable with
  `Last-Event-ID`, filtered per person), `client.subscribe()`, and `useLiveRoom` (React, Vue) / `live()` (Svelte),
  which keep cached views fresh.
- Folder downloads: `folders.requestDownload` zips what the requester may take, watermarked for them (or originals),
  listing what was left out.
- Quotas: `@better-files/plugin-quotas` enforces byte, document and file-size limits per room and tenant.
- Audit reports: `@better-files/plugin-audit` produces participants, access by group and folder,
  engagement and chain integrity as JSON or PDF.
- Storage cluster: lock-step fan-out writes (bounded memory), a reconcile lease across control-plane instances,
  fleet events on `dr.events`, and zone-aware placement for repairs and multipart copies.

- Storage cluster: `@better-files/storage-cluster` is a control plane (in the style of better-compute)
  that turns servers' local disks into Better Files storage. It handles join tokens, signed outbound heartbeats and
  commands, zone-spread weighted placement, quorum writes, failover reads, repair after a lost node, drain and
  removal, checksum scrubbing and index rebuild from node inventories. `@better-files/storage-node` is the
  node agent (`better-files-node start`), and `better-files storage …` operates the fleet.

- AI: `@better-files/plugin-ai` answers questions and summarizes documents on Claude, grounded only in
  documents the asker may view, with citations and server-side refusal fallbacks.
- MCP: `@better-files/mcp` exposes rooms to agents as MCP tools running with the caller's permissions;
  `mcpPlugin()` serves document text for view-only access.
- Sync: `@better-files/plugin-sync` adds snapshots and a permission-aware changes feed.
- CLI: `@better-files/cli` (`better-files migrate · maintain · verify · doctor · sync`); the umbrella package
  ships the `better-files` bin.
- Core: `folders.restore`; `v` schemas implement Standard JSON Schema; `toJsonSchema()`; `errorStatus`.
- Server: `dr.openapi()` builds an OpenAPI 3.1 document of every core and plugin operation (`better-files openapi`).
- Viewer: `@better-files/viewer` renders pages on the server to watermarked WebP images (`viewerPlugin`)
  and shows them in the `<bf-viewer>` custom element.
- Direct uploads: `client.upload({ direct: true })` encrypts in the browser (WebCrypto, the server's segment format)
  and PUTs parts to presigned object-storage URLs (`MultipartStorage.presignPart`, implemented for S3); the server
  reads the result back and refuses parts that do not decrypt.
- Processing: `@better-files/plugin-processing` converts Office and other formats to PDF renditions
  (LibreOffice or any `Converter`) and makes thumbnails; the viewer and watermark plugins use the PDF rendition.
- Core: `PluginContext.renditions` / `MaintenanceContext.renditions(tenantId)` store encrypted derived artifacts
  per version; `addDocument` runs `afterUpload` hooks (scanning and processing cover imported and generated files).
- h3 (Nuxt, Nitro): `better-files/middleware/h3` for h3 v1 and v2.
- Databases: `@better-files/adapter-prisma` (the host's PrismaClient), `-adapter-drizzle` (the host's drizzle
  db over node-postgres, postgres.js, PGlite, better-sqlite3 or libSQL) and `-adapter-pglite` (embedded PostgreSQL);
  `generateSchema()` and `better-files generate --format sql|prisma|drizzle` so the host's migration tool owns the
  tables. PostgreSQL placeholders now carry explicit casts. The PostgreSQL path (conformance and a full engine flow)
  runs locally on PGlite.
- Connectors: `@better-files/plugin-connectors` imports from Google Drive, Dropbox, OneDrive/SharePoint and
  Box in the background, keeping folder structure and re-importing changed files as new versions.
- Redaction: `@better-files/plugin-redaction` finds sensitive text in PDFs and burns it out (rasterizing
  only redacted pages) as a new version or a copy.
- Fix: `PluginContext.addDocument` joins the caller's transaction instead of opening its own, which deadlocked when
  called from a mutating endpoint.
- Vue (`@better-files/vue`) and Svelte (`@better-files/svelte`, with SvelteKit hooks) bindings; the
  query cache moved into the client package and React shares it.
- Examples (typechecked; the quickstart runs in the tests), CI workflow, formatting across the repository.

- Workspace scaffold (Phase 0): `better-files` umbrella, `-core`, `-server`, `-iam` and `-testing` packages.
- Core: capability bitmask and presets, the reference permission resolver (`resolveAccess`), the schema model with
  typed additional fields, ports (database, storage, identity, authorization, keys, audit), the plugin contract,
  the operation matrix and the database conformance cases.
- Server: `betterFiles()` factory, schema and plugin validation, the HTTP envelope and handlers, `initialize` and `close`.
- IAM: `betterFilesIamPlugin()` (actions and the `better-files-room`, `better-files-folder` and `better-files-document` resource types),
  `betterIamIntegration()` and `betterFilesResolver()`.
- Testing: in-memory database and storage adapters, a fake identity/authorization integration.
