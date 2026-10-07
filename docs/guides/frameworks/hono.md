# Hono

`better-files/middleware/hono` works with any Hono version, on Node (`@hono/node-server`), Bun and Deno.

```ts
import { Hono } from 'hono';
import { createBetterFilesHono } from 'better-files/middleware/hono';
import { dr } from './better-files';

const rooms = createBetterFilesHono(dr);
const app = new Hono();

app.all(`${rooms.basePath}/*`, rooms.handler); // the protocol
app.use('*', rooms.middleware); // c.get('betterFiles') everywhere else

app.get(
  '/deals/:tenantId/:roomId/documents/:nodeId',
  rooms.requireCapability(['VIEW']),
  async (c) => {
    const { api } = c.get('betterFiles') as HonoBetterFiles<typeof dr>;
    return c.json(
      await api.documents.get({
        tenantId: c.req.param('tenantId')!,
        nodeId: c.req.param('nodeId')!,
      }),
    );
  },
);

export default app;
```

- **`handler`** passes the raw `Request` to `dr.handler`. Register it before any middleware that reads the body.
- **`middleware`** sets `betterFiles` (`{ credential, api }`) on the context.
- **`requireCapability(capabilities, select?)`** reads `tenantId`, `roomId` and `nodeId` from route params by default.
  Pass selectors to read them from elsewhere, for example `{ tenantId: (c) => c.get('session').tenantId }`. A refusal
  returns the protocol's JSON error and status.
- On `@hono/node-server`, the client address comes from the socket. On other runtimes, put the client address in a
  header you trust and set `trustProxy: true` on `betterFiles()`.

`HonoBetterFiles` is exported from the same module, so `c.get('betterFiles')` can be typed. You can also declare it in your
app's `Variables`.
