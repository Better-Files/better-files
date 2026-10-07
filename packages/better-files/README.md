# Better Files

Embeddable data rooms for TypeScript applications, built on [Better IAM](https://better-iam.com). Install it, call a
factory with your database and storage, and mount it into your own Next.js, NestJS, Express, Hono or Fastify app. It
covers rooms, folders, versions, a hierarchical permission matrix, guests, NDA gating, watermarking, share links,
Q&A, search, e-signature, legal holds, exports, webhooks, sync, permission-aware AI and MCP, and a tamper-evident
activity log. It is a library, not a hosted service.

See [PLAN.md](https://github.com/Better-Files/better-files/blob/main/PLAN.md) for the design and roadmap.

```sh
npm install better-files better-iam
```

Works with `better-iam` 0.2.x from npm. With pnpm 10 or later, allow better-iam's password hashing to build
(`pnpm approve-builds`, or `allowBuilds: { argon2: true }` in `pnpm-workspace.yaml`).

## Set up

```ts
import { betterIam } from 'better-iam';
import { betterFiles } from 'better-files';
import { betterIamIntegration, betterFilesIamPlugin, betterFilesResolver } from 'better-files/iam';
import { postgresAdapter } from 'better-files/adapter-postgres';
import { s3Storage } from 'better-files/storage-s3';
import { ndaPlugin } from 'better-files/plugin-nda';
import { watermarkPlugin } from 'better-files/plugin-watermark';

const plugins = [ndaPlugin(), watermarkPlugin()] as const;
const iamPlugin = betterFilesIamPlugin({ plugins });

export const iam = betterIam({
  database,
  secret: process.env.BETTER_IAM_SECRET!,
  baseURL: 'https://app.example.com',
  plugins: [iamPlugin],
  resolveResource: betterFilesResolver(() => dr, { fallback: appResolver }),
});

export const dr = betterFiles({
  // systemCredential: a per-tenant service account for identity-system writes (see systemPolicy()).
  iam: betterIamIntegration(iam, {
    iamPlugin,
    systemCredential: (tenantId) => serviceKeys.get(tenantId),
  }),
  database: postgresAdapter({ pool }), // or sqliteAdapter, libsqlAdapter
  storage: s3Storage({ bucket: 'rooms', region: 'eu-west-1', credentials }), // or fileStorage
  secret: process.env.BETTER_FILES_SECRET!, // signs download tickets
  plugins,
});
await dr.initialize(); // creates the tables; run at deploy time
```

The service account behind `systemCredential` needs a role with `systemPolicy(iam)`: the directory, KMS and
invitation actions, limited to the ones your Better IAM release knows.

Files are encrypted at rest with Better IAM's KMS (a key per room, so deleting a room destroys its keys). Pass
`encryption: { keys: localKeyProvider({ secret }) }` for development without KMS.

## Mount it

```ts
// Next.js: app/api/better-files/[...path]/route.ts
export const { GET, HEAD, POST, PUT, OPTIONS } = createBetterFilesNext(dr).handlers();
// Server components and actions
const api = createBetterFilesNext(dr).api(await headers());
const index = await api.rooms.index({ tenantId, roomId });

// Express (Hono and Fastify are the same shape)
const drExpress = createBetterFilesExpress(dr);
app.use(drExpress.middleware);

// NestJS
@Module({ imports: [BetterFilesModule.forRoot({ dr })] })
export class AppModule {}

// Nuxt / Nitro: server/routes/api/better-files/[...path].ts
export default defineEventHandler(betterFilesH3(dr)); // better-files/middleware/h3

// SvelteKit: src/hooks.server.ts
export const handle = betterFilesHandle(dr); // better-files/svelte/kit

// React Router / Remix, Bun, Deno, Cloudflare-style fetch runtimes: dr.handler is a fetch handler
export const loader = ({ request }: { request: Request }) => dr.handler(request);
export const action = loader;
```

## Use it from the browser

```tsx
const rooms = createBetterFilesClient<typeof dr>({ tenantId });
await rooms.rooms.create({ name: 'Project Falcon' });
await rooms.upload({ parentId: folderId, file, onProgress: (p) => setProgress(p.ratio) });

export const { BetterFilesProvider, useRoomIndex, useUpload, Can } =
  createBetterFilesReact<typeof dr>();
<Can roomId={roomId} nodeId={doc.id} capability="DOWNLOAD_ORIGINAL">
  <DownloadButton />
</Can>;
```

Large files on serverless hosts: `rooms.upload({ ..., direct: true })` encrypts in the browser and sends parts
straight to S3-compatible storage through presigned URLs (the bucket's CORS rules must allow `PUT` and expose
`ETag`). The server reads the result back and accepts it only when every segment decrypts.

Live views: `useLiveRoom(roomId)` (or `client.subscribe(roomId, { onActivity })`) follows the room's activity as
Server-Sent Events and refreshes cached queries as documents arrive, move or change. Each person sees only changes
to what they may list, and a dropped connection resumes after the last entry. "Download folder" is
`folders.requestDownload({ nodeId })`: a ZIP of what the person may take, watermarked for them.

## How access is decided

Every folder and document operation must pass two layers:

1. **The permission matrix** (Better Files). Each permission group or person gets a capability mask on a folder or
   document: `LIST`, `VIEW`, `PRINT`, `COPY_TEXT`, `DOWNLOAD_WATERMARKED`, `DOWNLOAD_ORIGINAL`, `UPLOAD`, `EDIT`,
   `DELETE` or `MANAGE`.
   - Masks are inherited down the tree. A deeper entry can narrow or widen access, and a locked entry is final for
     its subtree.
   - Room settings, document flags and plugins (NDA pending, quarantine) then remove bits.
   - A node the caller cannot `LIST` is reported as not found.
2. **A Better IAM decision** on the Better Files action for the resolved resource. Room roles are Better IAM
   relationship tuples, and a generated "Better Files participant" role maps them to actions. MFA, IP ranges, device
   posture, guest boundaries and your own policies apply here.

### Better IAM releases

`betterIamIntegration` checks what the instance offers (`betterIamFeatures(iam)`) instead of assuming it:

| Feature                        | npm 0.2.0                          | Better IAM `main`         |
| ------------------------------ | ---------------------------------- | ------------------------- |
| Sessions, groups, room roles   | yes                                | yes                       |
| Policies, `listAccessible`     | yes                                | yes                       |
| KMS keys per room, audit chain | yes                                | yes                       |
| Inviting people from outside   | member invitations, opt-in (below) | guests (sponsored, timed) |
| Withdrawing unaccepted invites | yes                                | yes                       |

Better IAM 0.2.0 has no guests. Inviting someone from outside the organization reports `UNSUPPORTED` until you choose
the fallback:

```ts
betterIamIntegration(iam, { iamPlugin, systemCredential, externalInvites: 'members' });
```

Outsiders then get a Better IAM member invitation into the room's groups. They also join a `Better Files outsiders`
group, so Better Files still treats them as guests: "external" NDAs apply, and audit reports mark them. They are
regular tenant identities, though, so make sure your own roles give tenant members nothing by default. A member
invitation has no access window, so `accessDays` is enforced by `dr.maintain()`, which takes people out of the room
when their window ends.

## Packages

| Import (`better-files/…`)                                                            | What it is                                                                                                  |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `.`                                                                                  | `betterFiles()`, `definePlugin`, `endpoint`, `v` (validation), `Capability`, `localKeyProvider`             |
| `/iam`                                                                               | Better IAM: plugin, integration (directory, KMS keys, audit), resolver, `accessModelPolicy`, `systemPolicy` |
| `/adapter-sqlite`, `/adapter-postgres`, `/adapter-libsql`, `/adapter-sql`            | Databases (the Better Files tables can live in your app's database)                                         |
| `/adapter-prisma`, `/adapter-drizzle`, `/adapter-pglite`                             | Your PrismaClient or drizzle db (with `better-files generate` for their migrations); embedded PostgreSQL    |
| `/storage-cluster` (+ `better-files-node`)                                           | Your own servers' disks as storage: join tokens, replication across zones, repair, drain, scrub             |
| `/storage-s3`, `/storage-fs`                                                         | S3, R2, MinIO, B2 and Wasabi (SigV4 over fetch, no AWS SDK), or local disk                                  |
| `/client`, `/react`                                                                  | Typed browser client with a parallel resumable uploader; React hooks and `<Can>`                            |
| `/vue`, `/svelte`, `/svelte/kit`                                                     | Vue composables and `<Can>`; Svelte stores (no runtime dependency) and SvelteKit hooks                      |
| `/viewer`, `/viewer/server`                                                          | `<bf-viewer>` and its plugin: server-rendered, watermarked page images; the file never reaches the browser  |
| `/next`, `/nestjs`, `/middleware/express`, `/middleware/hono`, `/middleware/fastify` | Framework integrations                                                                                      |
| `/plugin-nda`                                                                        | Per-room NDAs: content withheld until accepted, re-acceptance on new versions                               |
| `/plugin-watermark`                                                                  | Watermarked downloads and views (PDF, images) with a forensic code                                          |
| `/plugin-links`                                                                      | Share links: password, email capture, expiry, use caps                                                      |
| `/plugin-qa`                                                                         | Due-diligence Q&A with team-scoped visibility                                                               |
| `/plugin-search`                                                                     | Search names and (opt-in) text, filtered by permission                                                      |
| `/plugin-scan`                                                                       | ClamAV scanning with quarantine                                                                             |
| `/plugin-guard`                                                                      | Download rate limits and anomaly reporting                                                                  |
| `/plugin-retention`                                                                  | Legal holds                                                                                                 |
| `/plugin-webhooks`                                                                   | Signed, retried webhooks with SSRF protection                                                               |
| `/plugin-esign`                                                                      | E-signature envelopes: routing, fields, signed PDF with a certificate of completion                         |
| `/plugin-templates`                                                                  | Room templates (M&A, fundraising, board portal, …) and configuration as code                                |
| `/plugin-tasks`                                                                      | Diligence checklists and requests tied to folders and documents                                             |
| `/plugin-analytics`                                                                  | Engagement by document, person and group                                                                    |
| `/plugin-notifications`                                                              | Digests and alerts for new documents, answers and deadlines                                                 |
| `/plugin-processing`                                                                 | Office to PDF (LibreOffice) so every format can be viewed and watermarked; thumbnails                       |
| `/plugin-inbound`                                                                    | Email to a room: per-folder drop addresses, sender allow-lists, provider authentication                     |
| `/plugin-annotations`                                                                | Page-anchored notes and highlights: private, shared with your group, or room-wide; replies, resolution      |
| `/plugin-quotas`                                                                     | Byte, document and file-size limits per room and tenant, enforced before upload, with warnings              |
| `/plugin-audit`                                                                      | Audit reports: participants, access by group and folder, engagement, chain integrity (JSON or PDF)          |
| `/plugin-reviews`                                                                    | Access reviews: keep/revoke certifications with recommendations, no self-review, scheduled campaigns        |
| `/plugin-connectors`                                                                 | Import from Google Drive, Dropbox, OneDrive, SharePoint and Box, with re-import of changes                  |
| `/plugin-redaction`                                                                  | Find emails, IDs and terms in PDFs; burn them out as a new version or a redacted copy                       |
| `/plugin-sync`                                                                       | Snapshots and a permission-aware changes feed for desktop and CLI mirrors                                   |
| `/plugin-ai`                                                                         | Questions and summaries on Claude, grounded only in documents the asker may view, with citations            |
| `/mcp`                                                                               | MCP server and tools: agents browse, search, read and ask as the signed-in user                             |
| `/cli`                                                                               | `better-files migrate · maintain · verify · doctor · openapi · sync pull/push/status`                       |
| `/crypto`, `/testing`, `/core`                                                       | Encryption primitives, in-memory adapters and fakes, the core contracts                                     |

Core operations: `rooms.*` (create, list, get, index, update, publish, close, reopen, archive, delete, trash, export),
`folders.*`, `documents.*` (including `requestView`, `requestDownload`, `requestOriginal`), `versions.*`,
`uploads.*`, `members.*` (invite, including Better IAM guests; roles; suspend), `groups.*`, `permissions.*` (matrix,
explain) and `activity.*` (hash-chained log, verify).

## AI and agents

`aiPlugin` answers questions over a room on Claude. Retrieval runs as the asker: only documents they may view are
sent to the model, answers cite the passages they rely on, and every question is in the activity log. Server-side
refusal fallbacks are on by default (`claudeProvider({ fallbacks: false })` turns them off).

```ts
import { aiPlugin, claudeProvider } from 'better-files/plugin-ai';
const plugins = [
  searchPlugin({ indexContent: true }),
  aiPlugin({ provider: claudeProvider() }),
] as const;
const { answer, citations } = await api.ai.ask({
  tenantId,
  roomId,
  question: 'What are the change-of-control terms?',
});
```

`better-files/mcp` turns an instance into MCP tools (`list_rooms`, `get_room_index`, `read_document`,
`search`, `ask_room`, `list_activity`, and opt-in write tools), each running as the caller with their permissions.
Add `mcpPlugin()` so agents can read the text of view-only documents without receiving the files.

```ts
const server = await createBetterFilesMcpServer(dr, { credential: { token }, tenantId: 'acme' });
await server.connect(new StdioServerTransport());
```

## Command line and sync

```sh
npx better-files migrate                 # loads better-files.config.ts (default export: your instance)
npx better-files doctor --tenant acme    # secret, database, storage and a KMS round trip
npx better-files maintain --every 300
npx better-files sync pull --url https://app.example.com/api/better-files --tenant acme --room rom_… --dir ./falcon
```

`sync` mirrors a room into a folder using `syncPlugin`'s changes feed. Remote renames and moves become local renames,
withdrawn access removes files, a local edit is never overwritten (it is kept as a "conflicted copy" and uploaded),
and `push --delete` is required before local deletions reach the server.

## Examples

[`examples/`](https://github.com/Better-Files/better-files/blob/main/examples) holds an in-memory [quickstart](https://github.com/Better-Files/better-files/blob/main/examples/quickstart/index.ts), a production-shaped
[Better IAM + Express](https://github.com/Better-Files/better-files/blob/main/examples/express-better-iam) setup, and [Next.js](https://github.com/Better-Files/better-files/blob/main/examples/nextjs), [NestJS](https://github.com/Better-Files/better-files/blob/main/examples/nestjs)
and [MCP](https://github.com/Better-Files/better-files/blob/main/examples/mcp-stdio/server.ts) integrations. They are typechecked with the workspace, and the quickstart
runs in the test suite.

## Develop

The workspace installs `better-iam` from npm.

```sh
pnpm install
pnpm build
pnpm check   # typecheck, tests (including real Better IAM end to end), package validation
```

To try unreleased Better IAM changes, link a checkout that you have built with `pnpm build`. Switch back before
committing:

```sh
node scripts/better-iam.mjs link ../better-iam
pnpm install --no-frozen-lockfile
node scripts/better-iam.mjs npm
pnpm install
```

CI runs the suite against npm and, in a separate job, against Better IAM's `main` branch.

`pnpm smoke:packed` checks what users actually install. It packs the packages and installs them with npm into a
clean app, with `better-iam` from the registry. It then checks that no framework, native tool or SDK is a required
peer, typechecks against the packed declarations, runs Better Files on Better IAM end to end, and imports every
subpath.

Workspace scripts:

- `scripts/new-package.mjs` scaffolds a package.
- `scripts/sync-workspace.mjs` updates project references and test paths.
- `scripts/sync-umbrella.mjs` updates the `better-files` subpaths.
- `scripts/better-iam.mjs` switches between Better IAM from npm and a linked checkout.

Apache-2.0. See [LICENSE](https://github.com/Better-Files/better-files/blob/main/LICENSE) and [NOTICE](https://github.com/Better-Files/better-files/blob/main/NOTICE).
