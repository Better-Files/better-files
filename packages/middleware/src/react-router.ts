/**
 * React Router (framework mode, v7+) and Remix, without importing either: loaders and actions receive a web
 * `Request`, and a thrown `Response` reaches the route's error boundary (`isRouteErrorResponse`).
 *
 * ```ts
 * // app/better-files.server.ts
 * export const drRouter = createBetterFilesRouter(dr);
 * // app/routes/api.better-files.$.ts (a resource route)
 * export const loader = drRouter.api;
 * export const action = drRouter.api;
 * // app/routes/rooms.$roomId.docs.$nodeId.tsx
 * export const loader = drRouter.guard(
 *   ['VIEW'],
 *   (args, { api }) => api.documents.get({ tenantId: tenantOf(args.request), nodeId: args.params.nodeId! }),
 *   { tenantId: (args) => tenantOf(args.request) },
 * );
 * ```
 */
import type { Credential } from '@better-files/core';
import {
  bindApi,
  errorResponse,
  requireCapabilities,
  type BoundApi,
  type BetterFilesLike,
} from './index.js';

type MaybePromise<T> = T | Promise<T>;

/** The loader and action arguments these helpers read. */
export interface RouteArgs {
  request: Request;
  params: Readonly<Record<string, string | undefined>>;
}

export interface BetterFilesRouteHelpers<D extends BetterFilesLike> {
  credential: Credential;
  /** `api.rooms.list({ tenantId })` with the request's cookies or bearer token. */
  api: BoundApi<D['api']>;
  capabilities(input: {
    tenantId: string;
    roomId: string;
    nodeIds: readonly string[];
  }): Promise<Record<string, string[]>>;
}

/** Where a guard reads the ids from; each defaults to the route param of the same name. */
export type NodeSelector<A extends RouteArgs> = Partial<
  Record<'tenantId' | 'roomId' | 'nodeId', (args: A) => MaybePromise<string | undefined>>
>;

export interface BetterFilesRouterOptions {
  /** The client address for rate limits and IP rules; React Router does not expose the socket. */
  ip?: (request: Request) => string | undefined;
}

/** A JSON `Response` in the protocol's error envelope, for throwing from loaders. */
export function errorAsResponse(error: unknown): Response {
  const { status, body } = errorResponse(error);
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * React Router / Remix integration. `api` is the loader and action of a resource route under the base path,
 * `helpers` binds the API to a request, and `guard` / `action` wrap loaders and actions on the permission matrix
 * (layer A; the Better Files operations they call still check both layers).
 */
export function createBetterFilesRouter<D extends BetterFilesLike>(
  dr: D,
  options: BetterFilesRouterOptions = {},
) {
  const helpers = (args: Pick<RouteArgs, 'request'>): BetterFilesRouteHelpers<D> => {
    const credential: Credential = { headers: args.request.headers };
    return {
      credential,
      api: bindApi(dr, credential),
      capabilities: (input) => dr.capabilitiesFor(credential, input),
    };
  };

  const ids = async <A extends RouteArgs>(args: A, select: NodeSelector<A>) => {
    const read = async (name: 'tenantId' | 'roomId' | 'nodeId') =>
      (select[name] ? await select[name]!(args) : args.params[name]) ?? '';
    return {
      tenantId: await read('tenantId'),
      roomId: await read('roomId'),
      nodeId: await read('nodeId'),
    };
  };

  /** Throws a 404 / 403 `Response` unless the request holds every capability on the node. */
  async function require<A extends RouteArgs>(
    args: A,
    capabilities: readonly string[],
    select: NodeSelector<A> = {},
  ): Promise<string[]> {
    try {
      return await requireCapabilities(
        dr,
        { headers: args.request.headers },
        {
          ...(await ids(args, select)),
          capabilities,
        },
      );
    } catch (error) {
      throw errorAsResponse(error);
    }
  }

  return {
    /** Loader and action for the `api/better-files/*` resource route: the Better Files HTTP protocol. */
    api({ request }: { request: Request }): Promise<Response> {
      const ip = options.ip?.(request);
      return dr.handler(request, ip ? { ip } : {});
    },
    helpers,
    require,
    /**
     * Wraps a loader: it runs with the bound helpers once the request holds `capabilities` on the node. Refusals and
     * Better Files errors thrown inside are thrown as JSON `Response`s for the error boundary.
     */
    guard<A extends RouteArgs, R>(
      capabilities: readonly string[],
      loader: (args: A, helpers: BetterFilesRouteHelpers<D> & { held: string[] }) => R,
      select: NodeSelector<A> = {},
    ): (args: A) => Promise<Awaited<R>> {
      return async (args): Promise<Awaited<R>> => {
        const held = await require(args, capabilities, select);
        try {
          return (await loader(args, { ...helpers(args), held })) as Awaited<R>;
        } catch (error) {
          if (error instanceof Response || errorResponse(error).status === 500) throw error;
          throw errorAsResponse(error);
        }
      };
    },
    /**
     * Wraps an action. Refusals and Better Files errors come back as `{ error: { code, message } }` with their status
     * (as a `Response`), for `useActionData`/`fetcher.data`; redirects and unexpected errors propagate.
     */
    action<A extends RouteArgs, R>(
      fn: (args: A, helpers: BetterFilesRouteHelpers<D>) => R,
      spec: { capabilities?: readonly string[]; select?: NodeSelector<A> } = {},
    ): (args: A) => Promise<Awaited<R> | Response> {
      return async (args): Promise<Awaited<R> | Response> => {
        try {
          if (spec.capabilities) await require(args, spec.capabilities, spec.select);
          return (await fn(args, helpers(args))) as Awaited<R>;
        } catch (error) {
          if (error instanceof Response) {
            if (error.status >= 300 && error.status < 400) throw error;
            return error;
          }
          if (errorResponse(error).status === 500) throw error;
          return errorAsResponse(error);
        }
      };
    },
  };
}

export type BetterFilesRouter<D extends BetterFilesLike = BetterFilesLike> = ReturnType<
  typeof createBetterFilesRouter<D>
>;
