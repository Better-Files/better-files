# Guides

Better Files is a library that runs inside your own server. These guides show how to wire one `betterFiles()` instance into
each supported framework. For the design behind it, see [PLAN.md](../../PLAN.md). For the decisions, see the
[ADRs](../adr/README.md).

## Frameworks

| Framework                                  | Import                                 | Guide                                         |
| ------------------------------------------ | -------------------------------------- | --------------------------------------------- |
| Next.js (App Router)                       | `better-files/next`                    | [nextjs.md](frameworks/nextjs.md)             |
| NestJS                                     | `better-files/nestjs`                  | [nestjs.md](frameworks/nestjs.md)             |
| Express, Connect                           | `better-files/middleware/express`      | [express.md](frameworks/express.md)           |
| Fastify                                    | `better-files/middleware/fastify`      | [fastify.md](frameworks/fastify.md)           |
| Hono                                       | `better-files/middleware/hono`         | [hono.md](frameworks/hono.md)                 |
| Koa                                        | `better-files/middleware/koa`          | [koa.md](frameworks/koa.md)                   |
| React Router (framework mode), Remix       | `better-files/middleware/react-router` | [react-router.md](frameworks/react-router.md) |
| SvelteKit                                  | `better-files/svelte/kit`              | [sveltekit.md](frameworks/sveltekit.md)       |
| Nuxt, Nitro and other h3 apps              | `better-files/middleware/h3`           | [nuxt.md](frameworks/nuxt.md)                 |
| Bun, Deno, Cloudflare-style fetch runtimes | `dr.handler`                           | [fetch.md](frameworks/fetch.md)               |

## What every integration does

Each framework integration provides the same three things, adapted to the framework's own conventions:

1. **The protocol.** The integration serves Better Files' HTTP protocol under `basePath` (default `/api/better-files`). This
   covers JSON operations (`POST {basePath}/{group}/{method}`), streamed resumable uploads, and file tickets for
   downloads and the viewer. The browser client, the React, Vue and Svelte bindings, `<bf-viewer>`, `better-files sync` and
   the MCP tools all talk to this endpoint. Upload and download bodies are streamed. Mount the protocol where your
   framework has not already read the body, or let the integration handle a body that was already parsed (Express and
   Koa do this).
2. **The bound API.** Your own routes, pages and actions call `dr.api` as the signed-in person. The integration takes
   the request's cookies or bearer token, which Better IAM reads, and binds them as the credential:
   `api.documents.get({ tenantId, nodeId })`. Every call still passes both authorization layers, the permission matrix
   and the Better IAM decision. Nothing is ever checked for "the server".
3. **A capability guard.** Before your own handler runs, the guard checks the permission matrix on one folder or
   document, for example `['VIEW']` or `['DOWNLOAD_ORIGINAL']`. A node the person cannot `LIST` answers 404. A node they
   can see but not use answers 403. Use the guard for your own pages around a node. Better Files operations already check
   for themselves.

## One instance per process

Create the instance once, in a module the rest of the server imports:

```ts
// lib/better-files.ts
export const dr = betterFiles({
  iam: betterIamIntegration(iam, { iamPlugin, systemCredential }),
  database,
  storage,
  secret,
  plugins,
});
```

- Run `await dr.initialize()` (or `npx better-files migrate`) at deploy time. It creates and updates the tables.
- Call `await dr.maintain()` every few minutes, from a cron route, a scheduler or `npx better-files maintain --every 300`.
  It expires tickets and uploads, empties the trash after retention, delivers the outbox and runs plugin sweeps.
- Behind a proxy you control, set `trustProxy: true` so rate limits, IP rules and the activity log see the client's
  address.
- If the browser app runs on another origin, list that origin in `trustedOrigins`. Cookie-bearing requests from any
  other origin are refused.
- To mount the protocol elsewhere, set `basePath` both on `betterFiles()` and on the client
  (`createBetterFilesClient({ basePath })`).

## On the client

```ts
const rooms = createBetterFilesClient<typeof dr>({ tenantId }); // same origin: no baseURL needed
await rooms.rooms.create({ name: 'Project Falcon' });
```

`typeof dr` carries every plugin's endpoints, so the client is typed end to end, including your own plugins. Import
only the type: `import type { dr } from '../server/better-files'`.
