# Next.js (App Router)

`better-files/next` serves the protocol from one catch-all route handler. In server components and server
actions it gives you the API bound to the signed-in person. It does not import Next itself.

## 1. The instance

```ts
// lib/better-files.ts
import 'server-only';
import { createIamNext } from 'better-iam/next';
import { createBetterFilesNext } from 'better-files/next';
import { dr, iam } from './better-files-instance';

export const iamNext = createIamNext(iam);
export const drNext = createBetterFilesNext(dr, { iamNext });
```

`iamNext` is optional, but recommended. With it, Better Files reads the request through Better IAM (Next's `headers()` and
`cookies()`) and takes the tenant from the session. Without it, pass `await headers()` yourself and give `tenantId`
explicitly.

## 2. The protocol

```ts
// app/api/better-files/[...path]/route.ts
import { drNext } from '@/lib/better-files';

export const runtime = 'nodejs'; // streamed uploads, encryption and storage need Node
export const { GET, HEAD, POST, PUT, OPTIONS } = drNext.handlers();
```

If you set `basePath` on `betterFiles()`, the route folder must match it.

## 3. Server components

```tsx
// app/rooms/[roomId]/page.tsx
import { notFound, redirect } from 'next/navigation';
import { drNext } from '@/lib/better-files';

export default async function RoomPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  const context = await drNext.session(); // null when signed out
  if (!context) redirect('/login');
  const room = await context.tenant.rooms.get({ roomId }); // tenantId comes from the session
  return <h1>{room.name}</h1>;
}
```

- `drNext.session()` returns `{ tenantId, identityId, credential, api, tenant }`, or `null` if no one is signed in.
- `drNext.request()` returns the same context, but throws `UNAUTHENTICATED` instead of returning `null`.
- `tenant` is the API with the session's tenant already applied. `api` takes `tenantId` explicitly. Use `api` when a
  page works across tenants.
- Without `iamNext`: `const api = drNext.api(await headers())`.

## 4. Guarding a page on a document

```tsx
const held = await drNext.capabilities(undefined, { roomId, nodeId, capabilities: ['VIEW'] });
if (!held) notFound(); // hidden or missing; a FORBIDDEN error is thrown when visible but not allowed
```

The first argument is the request headers. Leave it `undefined` when `iamNext` reads them. `held` lists every capability
the person has on the node, so you can show or hide download buttons without a second call.

## 5. Server actions

```ts
'use server';
import { revalidatePath } from 'next/cache';
import { drNext } from '@/lib/better-files';

export async function renameDocument(nodeId: string, name: string) {
  const { tenant } = await drNext.request();
  await tenant.documents.rename({ nodeId, name });
  revalidatePath('/rooms');
}
```

The operation checks both authorization layers itself, so the action does not need a separate guard.

## 6. Client components

```tsx
'use client';
import { createBetterFilesClient } from 'better-files/client';
import { createBetterFilesReact } from 'better-files/react';
import type { dr } from '@/lib/better-files-instance';

export const { BetterFilesProvider, useRoomIndex, useUpload, Can } =
  createBetterFilesReact<typeof dr>();
const client = createBetterFilesClient<typeof dr>({ tenantId });
```

The client calls `/api/better-files` on the page's origin. Session cookies travel by default.

## Maintenance on Vercel and similar hosts

Run `dr.maintain()` from a cron route that only your scheduler can call:

```ts
// app/api/cron/better-files/route.ts
export async function GET(request: Request) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`)
    return new Response('Unauthorized', { status: 401 });
  await dr.maintain();
  return Response.json({ ok: true });
}
```

On serverless hosts with body size limits, upload large files with `rooms.upload({ ..., direct: true })`. The
browser encrypts the parts and sends them straight to S3-compatible storage. See the main README.

A complete example lives in [`examples/nextjs`](../../../examples/nextjs).
