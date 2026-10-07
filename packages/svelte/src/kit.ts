/**
 * SvelteKit server helpers. Structural types only, so this module imports neither SvelteKit nor the server package.
 *
 * ```ts
 * // src/hooks.server.ts
 * export const handle = betterFilesHandle(dr);                   // or sequence(betterFilesHandle(dr), yourHandle)
 * // or a route: src/routes/api/better-files/[...path]/+server.ts
 * export const { GET, HEAD, POST, PUT, OPTIONS } = betterFilesHandlers(dr);
 * ```
 */

interface BetterFilesLike {
  handler(request: Request, info?: { ip?: string }): Promise<Response>;
  readonly options: object;
}

interface RequestEventLike {
  request: Request;
  url: URL;
  getClientAddress(): string;
}

const clientAddress = (event: RequestEventLike) => {
  try {
    return event.getClientAddress();
  } catch {
    return undefined;
  }
};

const serve = (dr: BetterFilesLike, event: RequestEventLike) => {
  const ip = clientAddress(event);
  return dr.handler(event.request, ip ? { ip } : {});
};

/** Route handlers for a catch-all `+server.ts` under the base path. */
export function betterFilesHandlers(dr: BetterFilesLike) {
  const handler = (event: RequestEventLike) => serve(dr, event);
  return { GET: handler, HEAD: handler, POST: handler, PUT: handler, OPTIONS: handler };
}

/** A `handle` hook that answers the protocol under the base path and passes everything else on. */
export function betterFilesHandle(dr: BetterFilesLike) {
  const configured = (dr.options as { basePath?: string }).basePath;
  const base = (configured ?? '/api/better-files').replace(/\/+$/, '');
  return async <E extends RequestEventLike>(input: {
    event: E;
    resolve: (event: E) => Response | Promise<Response>;
  }): Promise<Response> => {
    const path = input.event.url.pathname;
    if (path === base || path.startsWith(`${base}/`)) return serve(dr, input.event);
    return input.resolve(input.event);
  };
}
