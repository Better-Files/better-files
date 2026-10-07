import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Credential } from '@better-files/core';
import {
  basePathOf,
  bindApi,
  errorResponse,
  requireCapabilities,
  toHeaders,
  type BoundApi,
  type BetterFilesLike,
} from './index.js';

/** The slice of Koa's context the integration uses, so Koa 2 and 3 (and `@koa/router` params) work. */
export interface KoaContext {
  req: IncomingMessage;
  res: ServerResponse;
  path: string;
  method: string;
  originalUrl?: string;
  ip?: string;
  params?: Record<string, string | undefined>;
  state: Record<string, unknown>;
  request?: { body?: unknown };
  status: number;
  body: unknown;
  respond?: boolean;
  set?(field: string, value: string): void;
}
type Next = () => Promise<unknown>;

export interface KoaBetterFiles<D extends BetterFilesLike> {
  credential: Credential;
  /** `ctx.state.betterFiles.api.rooms.list({ tenantId })` with the request's cookies or bearer token. */
  api: BoundApi<D['api']>;
  capabilities(input: {
    tenantId: string;
    roomId: string;
    nodeIds: readonly string[];
  }): Promise<Record<string, string[]>>;
}

/**
 * Koa integration. `middleware` answers requests under the protocol's base path (streaming uploads and downloads,
 * bypassing Koa's response handling) and puts the bound API on `ctx.state.betterFiles` for the rest.
 * `requireCapability` guards routes on the permission matrix, reading `tenantId`, `roomId` and `nodeId` from
 * `ctx.params` unless selectors are given.
 *
 * ```ts
 * const drKoa = createBetterFilesKoa(dr);
 * app.use(drKoa.middleware);
 * router.get('/deals/:roomId/docs/:nodeId', drKoa.requireCapability(['VIEW'], { tenantId: () => TENANT }), handler);
 * ```
 */
export function createBetterFilesKoa<D extends BetterFilesLike>(dr: D) {
  const base = basePathOf(dr);
  const helpers = (ctx: Pick<KoaContext, 'req'>): KoaBetterFiles<D> => {
    const credential: Credential = { headers: toHeaders(ctx.req.headers) };
    return {
      credential,
      api: bindApi(dr, credential),
      capabilities: (input) => dr.capabilitiesFor(credential, input),
    };
  };
  const reject = (ctx: KoaContext, error: unknown) => {
    const { status, body } = errorResponse(error);
    if (status === 500) throw error;
    ctx.status = status;
    ctx.body = body;
    ctx.set?.('cache-control', 'no-store');
  };

  async function middleware(ctx: KoaContext, next: Next) {
    if (ctx.path === base || ctx.path.startsWith(`${base}/`)) {
      const url = ctx.originalUrl ?? ctx.req.url ?? ctx.path;
      const ip = ctx.ip ?? ctx.req.socket?.remoteAddress;
      // A body parser mounted earlier has consumed the stream; hand Better Files the parsed body instead.
      if (ctx.method === 'POST' && ctx.request?.body !== undefined && ctx.req.readableEnded) {
        const response = await dr.handler(
          new Request(`http://${ctx.req.headers.host ?? 'localhost'}${url}`, {
            method: 'POST',
            headers: toHeaders(ctx.req.headers),
            body: JSON.stringify(ctx.request.body),
          }),
          ip ? { ip } : {},
        );
        ctx.status = response.status;
        response.headers.forEach((value, key) => ctx.set?.(key, value));
        ctx.body = Buffer.from(await response.arrayBuffer());
        return;
      }
      ctx.respond = false;
      const originalUrl = ctx.req.url;
      ctx.req.url = url;
      try {
        await dr.nodeHandler(ctx.req, ctx.res);
      } finally {
        ctx.req.url = originalUrl;
      }
      return;
    }
    ctx.state.betterFiles = helpers(ctx);
    await next();
  }

  function requireCapability(
    capabilities: readonly string[],
    select: Partial<
      Record<'tenantId' | 'roomId' | 'nodeId', (ctx: KoaContext) => string | undefined>
    > = {},
  ) {
    return async (ctx: KoaContext, next: Next) => {
      const read = (name: 'tenantId' | 'roomId' | 'nodeId') =>
        (select[name] ? select[name]!(ctx) : ctx.params?.[name]) ?? '';
      try {
        await requireCapabilities(
          dr,
          { headers: toHeaders(ctx.req.headers) },
          {
            tenantId: read('tenantId'),
            roomId: read('roomId'),
            nodeId: read('nodeId'),
            capabilities,
          },
        );
      } catch (error) {
        reject(ctx, error);
        return;
      }
      await next();
    };
  }

  /** Put first: renders Better Files and Better IAM errors thrown downstream in the protocol's envelope. */
  async function errorHandler(ctx: KoaContext, next: Next) {
    try {
      await next();
    } catch (error) {
      reject(ctx, error);
    }
  }

  return { basePath: base, middleware, requireCapability, errorHandler, helpers };
}
