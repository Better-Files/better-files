# Fastify

`better-files/middleware/fastify` answers the protocol in an `onRequest` hook, which runs before Fastify
parses the body, so uploads stream. It decorates every other request with `request.betterFiles`.

```ts
import Fastify from 'fastify';
import { betterFilesFastify, requireCapability } from 'better-files/middleware/fastify';
import { dr } from './better-files';

await dr.initialize();

const app = Fastify({ trustProxy: true });
await app.register(betterFilesFastify, { dr }); // or: await betterFilesFastify(app, { dr })

app.get<{ Params: { tenantId: string; roomId: string; nodeId: string } }>(
  '/deals/:tenantId/:roomId/documents/:nodeId',
  {
    preHandler: requireCapability(dr, ['VIEW'], {
      tenantId: (request) => (request.params as { tenantId: string }).tenantId,
      roomId: (request) => (request.params as { roomId: string }).roomId,
      nodeId: (request) => (request.params as { nodeId: string }).nodeId,
    }),
  },
  async (request) =>
    request.betterFiles!.api.documents.get({
      tenantId: request.params.tenantId,
      nodeId: request.params.nodeId,
    }),
);

await app.listen({ port: 3000 });
```

- The plugin is not encapsulated (it sets `skip-override`, as `fastify-plugin` does), so `request.betterFiles` exists
  in every route, including routes registered in child contexts.
- `request.betterFiles` holds `{ credential, api }`.
- `requireCapability(dr, capabilities, select)` is a `preHandler`. On failure it replies with the protocol's error
  envelope and status, and your handler does not run.
- Errors thrown from your own `dr.api` calls carry `status` and `code`. Map them in `setErrorHandler`, for example with
  `errorResponse(error)` from `better-files/middleware`.

Fastify's own `trustProxy` does not change what Better Files sees. Set `trustProxy: true` on `betterFiles()` as well.
