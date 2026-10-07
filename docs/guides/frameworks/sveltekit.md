# SvelteKit

`better-files/svelte/kit` serves the protocol from a `handle` hook or a catch-all `+server.ts`. The
`better-files/svelte` stores cover the browser side.

## The protocol

Pick one of these:

```ts
// src/hooks.server.ts
import { sequence } from '@sveltejs/kit/hooks';
import { betterFilesHandle } from 'better-files/svelte/kit';
import { dr } from '$lib/server/better-files';

export const handle = sequence(betterFilesHandle(dr), yourHandle);
```

```ts
// src/routes/api/better-files/[...path]/+server.ts
import { betterFilesHandlers } from 'better-files/svelte/kit';
import { dr } from '$lib/server/better-files';

export const { GET, HEAD, POST, PUT, OPTIONS } = betterFilesHandlers(dr);
```

The hook answers everything under `basePath` before your routes. The route form needs its folder to match
`basePath`. Both forms pass `event.getClientAddress()` as the client address.

## Load functions and form actions

Bind the API to the request's cookies:

```ts
// src/routes/rooms/[roomId]/+page.server.ts
import { error } from '@sveltejs/kit';
import { bindApi } from 'better-files/middleware';
import { dr } from '$lib/server/better-files';

export async function load({ request, params, locals }) {
  const api = bindApi(dr, { headers: request.headers });
  const held = await dr.capabilitiesFor(
    { headers: request.headers },
    {
      tenantId: locals.tenantId,
      roomId: params.roomId,
      nodeIds: [params.roomId],
    },
  );
  if (!held[params.roomId]?.includes('LIST')) error(404, 'Not found');
  return { room: await api.rooms.get({ tenantId: locals.tenantId, roomId: params.roomId }) };
}
```

`requireCapabilities(dr, credential, { tenantId, roomId, nodeId, capabilities })` from the same module throws
`NOT_FOUND` or `FORBIDDEN` for a single node.

## The browser

```ts
import { createBetterFilesClient } from 'better-files/client';
import { createBetterFilesSvelte } from 'better-files/svelte';
```

The stores have no runtime dependency beyond Svelte's store contract.
