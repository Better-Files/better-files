# Express

`better-files/middleware/express` works with Express 4 and 5, and with Connect.

```ts
import express from 'express';
import { createBetterFilesExpress } from 'better-files/middleware/express';
import { dr } from './better-files';

await dr.initialize();

const app = express();
const rooms = createBetterFilesExpress(dr);

app.use(express.json());
app.use(rooms.middleware); // the protocol under /api/better-files; req.betterFiles everywhere else

app.get(
  '/deals/:roomId/documents/:nodeId',
  rooms.requireCapability(['VIEW'], {
    tenantId: (req) => req.session.tenantId, // however your app knows the tenant
    roomId: (req) => req.params.roomId,
    nodeId: (req) => req.params.nodeId,
  }),
  async (req, res) => {
    const document = await req.betterFiles!.api.documents.get({
      tenantId: req.session.tenantId,
      nodeId: req.params.nodeId,
    });
    res.json(document);
  },
);

app.use(rooms.errorHandler); // after your routes
app.listen(3000);
```

## What each piece does

- **`middleware`** answers every request under `basePath`. Uploads and downloads stream through untouched, even when
  `express.json()` runs first: when a JSON body parser has already consumed a protocol request, the middleware passes
  the parsed body on. Every other request gets `req.betterFiles`:
  - `credential`: the request's cookies and bearer token;
  - `api`: `dr.api` bound to that credential;
  - `capabilities({ tenantId, roomId, nodeIds })`: capability names per node, in one batched call.
- **`requireCapability(capabilities, select)`** checks the permission matrix on one node before your handler runs.
  Failures go to `next(error)`.
- **`errorHandler`** renders Better Files and Better IAM errors as `{ error: { code, message } }` with the matching status
  (401, 403, 404, 409, 423 …). It passes anything else, such as your own 500s, to the next error handler.
- **`helpers(req)`** builds the same `{ credential, api, capabilities }` for a request the middleware did not see.

## With Better IAM's Express helpers

Mount `createIamExpress(iam).middleware` from `better-iam/express` before the Better Files middleware if your routes also
use Better IAM directly. The two are independent: Better Files reads the same cookies itself.

## Maintenance

```ts
setInterval(
  () => void dr.maintain().catch((error) => console.error('maintain failed', error)),
  5 * 60_000,
);
```

In multi-instance deployments, run it from one scheduler instead, or use `npx better-files maintain --every 300`.

A complete example lives in [`examples/express-better-iam`](../../../examples/express-better-iam).
