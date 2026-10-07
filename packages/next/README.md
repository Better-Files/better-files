# @better-files/next

Next.js App Router integration for Better Files: route handlers, server-side calls and page guards. It does
not import Next itself.

```ts
// lib/better-files.ts
import { createIamNext } from 'better-iam/next';
import { createBetterFilesNext } from 'better-files/next';

export const iamNext = createIamNext(iam);
export const drNext = createBetterFilesNext(dr, { iamNext });

// app/api/better-files/[...path]/route.ts
export const runtime = 'nodejs';
export const { GET, HEAD, POST, PUT, OPTIONS } = drNext.handlers();
```

## With Better IAM's Next helpers

Pass `iamNext` (from `better-iam/next`) and server components, route handlers and server actions read the visitor's
credential through Better IAM (Next's `headers()` and `cookies()`), with the tenant their session acts in:

```tsx
export default async function RoomPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  const { tenant, tenantId } = await drNext.request(); // UNAUTHENTICATED when signed out
  const room = await tenant.rooms.get({ roomId }); // tenantId filled in from the session
  const held = await drNext.capabilities(undefined, {
    roomId,
    nodeId: room.rootNodeId,
    capabilities: ['UPLOAD'],
  });
  // …
}
```

- `request()` returns `{ tenantId, identityId, credential, api, tenant }`: `api` takes `tenantId` in every input as
  usual, `tenant` fills it in (an explicit `tenantId` still wins). `session()` is the same but returns `null` when the
  request is signed out, so a page can redirect.
- `capabilities(headers?, { roomId, nodeId, capabilities, tenantId? })` checks the permission matrix: it returns the
  held capabilities, `null` when the node is hidden or missing (call `notFound()`), and throws FORBIDDEN when it is
  visible but not allowed.
- For assumed roles the tenant is the role session's, as Better IAM decides.
- Redirecting signed-out visitors stays with Better IAM: wrap pages in `iamNext.page(...)` or call
  `iamNext.requireSession()` first.

## Without them

Pass the request headers and the tenant yourself:

```ts
import { headers } from 'next/headers';
const api = drNext.api(await headers());
const index = await api.rooms.index({ tenantId, roomId });
```

Part of [Better Files](../../README.md). Most applications install `better-files` and import this package through its subpaths.
