# @better-files/middleware

Framework integrations for Better Files: Express, Hono, Fastify, Koa, React Router / Remix, h3 (Nuxt, Nitro)
and framework-neutral request helpers. None of them imports its framework, so any recent version works.

Part of [Better Files](../../README.md). Most applications install `better-files` and import this package through its subpaths.

| Subpath         | Entry point                                                         |
| --------------- | ------------------------------------------------------------------- |
| `/express`      | `createBetterFilesExpress(dr)`: middleware, guard, error handler    |
| `/hono`         | `createBetterFilesHono(dr)`: handler, middleware, guard             |
| `/fastify`      | `betterFilesFastify` plugin, `requireCapability` pre-handler        |
| `/koa`          | `createBetterFilesKoa(dr)`: middleware, guard, error handler        |
| `/react-router` | `createBetterFilesRouter(dr)`: resource route, loader/action guards |
| `/h3`           | `betterFilesH3(dr)`: an h3 v1 or v2 event handler                   |

## Koa

```ts
import { createBetterFilesKoa } from 'better-files/middleware/koa';

const drKoa = createBetterFilesKoa(dr);
app.use(drKoa.errorHandler); // first: protocol-shaped errors for Better Files refusals thrown downstream
app.use(drKoa.middleware); // answers /api/better-files/*, sets ctx.state.betterFiles elsewhere
router.get(
  '/deals/:roomId/docs/:nodeId',
  drKoa.requireCapability(['VIEW'], { tenantId: tenantOf }),
  async (ctx) => {
    ctx.body = await drKoa
      .helpers(ctx)
      .api.documents.get({ tenantId: tenantOf(ctx), nodeId: ctx.params.nodeId });
  },
);
```

Protocol requests bypass Koa's response handling (`ctx.respond = false`), so uploads and downloads stream. A body
parser mounted earlier is fine: its parsed JSON body is passed on.

## React Router (framework mode) and Remix

```ts
// app/better-files.server.ts
export const drRouter = createBetterFilesRouter(dr);

// app/routes/api.better-files.$.ts: the protocol, as a resource route
export const loader = drRouter.api;
export const action = drRouter.api;

// app/routes/rooms.$roomId.docs.$nodeId.tsx
export const loader = drRouter.guard(
  ['VIEW'],
  ({ params, request }, { api }) =>
    api.documents.get({ tenantId: tenantOf(request), nodeId: params.nodeId! }),
  { tenantId: ({ request }) => tenantOf(request) },
);
export const action = drRouter.action(
  ({ params, request }, { api }) =>
    api.folders.create({ tenantId: tenantOf(request), parentId: params.nodeId!, name: 'New' }),
  { capabilities: ['UPLOAD'], select: { tenantId: ({ request }) => tenantOf(request) } },
);
```

Guards read `tenantId`, `roomId` and `nodeId` from route params unless selectors are given. A loader guard throws a
404 or 403 JSON `Response` for the error boundary (a node the visitor cannot list is "not found", so its existence is
not confirmed). An action returns refusals as a `Response` with `{ error: { code, message } }` for `useActionData`,
and lets redirects through.

These guards check the permission matrix (layer A). The Better Files operations called inside still check both layers.
