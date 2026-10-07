# Koa

`better-files/middleware/koa` works with Koa 2 and 3, and with `@koa/router` params.

```ts
import Koa from 'koa';
import Router from '@koa/router';
import { createBetterFilesKoa } from 'better-files/middleware/koa';
import { dr } from './better-files';

const rooms = createBetterFilesKoa(dr);
const app = new Koa();
const router = new Router();

app.use(rooms.errorHandler); // first: renders Better Files errors thrown downstream
app.use(rooms.middleware); // the protocol under /api/better-files; ctx.state.betterFiles elsewhere

router.get(
  '/deals/:roomId/documents/:nodeId',
  rooms.requireCapability(['VIEW'], { tenantId: (ctx) => ctx.state.tenantId as string }),
  async (ctx) => {
    ctx.body = await ctx.state.betterFiles.api.documents.get({
      tenantId: ctx.state.tenantId,
      nodeId: ctx.params.nodeId,
    });
  },
);

app.use(router.routes());
app.listen(3000);
```

- **`middleware`** streams protocol requests straight through Node's request and response (it sets `ctx.respond =
false`). A body that `koa-bodyparser` or `@koa/bodyparser` already parsed is handed on. Other requests get
  `ctx.state.betterFiles` (`{ credential, api, capabilities }`).
- **`requireCapability(capabilities, select?)`** reads `tenantId`, `roomId` and `nodeId` from `ctx.params` unless
  selectors are given. A refusal sets the status and the JSON error body.
- **`errorHandler`** turns Better Files and Better IAM errors into the protocol's envelope. It rethrows anything that
  would be a 500.
- **`helpers(ctx)`** builds `{ credential, api, capabilities }` for any context.
