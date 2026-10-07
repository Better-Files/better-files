# React Router (framework mode) and Remix

`better-files/middleware/react-router` targets React Router v7 framework mode and Remix. Both give loaders
and actions a web `Request`. The module imports neither framework.

```ts
// app/better-files.server.ts
import { createBetterFilesRouter } from 'better-files/middleware/react-router';
import { dr } from './better-files-instance.server';

export const drRouter = createBetterFilesRouter(dr, {
  // React Router does not expose the socket; read the address your proxy sets.
  ip: (request) => request.headers.get('x-forwarded-for')?.split(',')[0]?.trim(),
});
```

## The protocol: a resource route

```ts
// app/routes/api.better-files.$.ts
import { drRouter } from '~/better-files.server';

export const loader = drRouter.api;
export const action = drRouter.api;
```

The route path must match `basePath` (`/api/better-files/*` by default).

## Loaders guarded on a document

```ts
// app/routes/rooms.$roomId.docs.$nodeId.tsx
export const loader = drRouter.guard(
  ['VIEW'],
  async (args, { api, held }) => ({
    document: await api.documents.get({
      tenantId: await tenantOf(args.request),
      nodeId: args.params.nodeId!,
    }),
    canDownload: held.includes('DOWNLOAD_ORIGINAL'),
  }),
  { tenantId: (args) => tenantOf(args.request) },
);
```

- `guard(capabilities, loader, select?)` throws a JSON `Response` (404 or 403) for the route's error boundary
  (`isRouteErrorResponse`). Better Files errors thrown inside the loader are converted the same way.
- `held` lists every capability the person has on the node.
- Selectors default to route params with the same names (`tenantId`, `roomId`, `nodeId`) and may be async.

## Actions

```ts
export const action = drRouter.action(
  async (args, { api }) => {
    const form = await args.request.formData();
    return api.documents.rename({
      tenantId: await tenantOf(args.request),
      nodeId: args.params.nodeId!,
      name: String(form.get('name')),
    });
  },
  { capabilities: ['EDIT'] },
);
```

`action` returns refusals as `{ error: { code, message } }` with their status, for `useActionData` and `fetcher.data`.
Redirects and unexpected errors propagate.

## Other helpers

- `drRouter.helpers({ request })` returns `{ credential, api, capabilities }` for any loader.
- `drRouter.require(args, capabilities, select?)` runs the check alone and returns `held`.
- `errorAsResponse(error)` builds the JSON error `Response` for your own code paths.
