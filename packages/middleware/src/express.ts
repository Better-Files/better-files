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

type Request = IncomingMessage & {
  path?: string;
  originalUrl?: string;
  params?: Record<string, string>;
  body?: unknown;
  betterFiles?: BetterFilesRequest<BetterFilesLike>;
};
type Response = ServerResponse & { status?(code: number): Response; json?(body: unknown): void };
type Next = (error?: unknown) => void;

export interface BetterFilesRequest<D extends BetterFilesLike> {
  credential: Credential;
  /** `req.betterFiles.api.rooms.list({ tenantId })` with the request's cookies or bearer token. */
  api: BoundApi<D['api']>;
  capabilities(input: {
    tenantId: string;
    roomId: string;
    nodeIds: readonly string[];
  }): Promise<Record<string, string[]>>;
}

const send = (res: Response, status: number, body: unknown) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
};

/**
 * Express (and Connect) integration. Mount `middleware` before body parsers, or anywhere: requests under the
 * protocol's base path are answered by Better Files (streaming uploads and downloads), others get `req.betterFiles`.
 *
 * ```ts
 * const drExpress = createBetterFilesExpress(dr);
 * app.use(drExpress.middleware);
 * app.get('/deals/:roomId/docs/:nodeId', drExpress.requireCapability(['VIEW'], { … }), handler);
 * app.use(drExpress.errorHandler);
 * ```
 */
export function createBetterFilesExpress<D extends BetterFilesLike>(dr: D) {
  const base = basePathOf(dr);
  const helpers = (req: Request): BetterFilesRequest<D> => {
    const credential: Credential = { headers: toHeaders(req.headers) };
    return {
      credential,
      api: bindApi(dr, credential),
      capabilities: (input) => dr.capabilitiesFor(credential, input),
    };
  };

  async function middleware(req: Request, res: Response, next: Next) {
    const path = (req.originalUrl ?? req.url ?? '/').split('?')[0]!;
    if (path === base || path.startsWith(`${base}/`)) {
      try {
        // A JSON body parser mounted earlier has consumed the stream; hand Better Files the parsed body instead.
        if (req.method === 'POST' && req.body !== undefined && req.readableEnded) {
          const request = new globalThis.Request(
            `http://${req.headers.host ?? 'localhost'}${req.originalUrl ?? req.url}`,
            {
              method: 'POST',
              headers: toHeaders(req.headers),
              body: JSON.stringify(req.body),
            },
          );
          const response = await dr.handler(
            request,
            req.socket.remoteAddress ? { ip: req.socket.remoteAddress } : {},
          );
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          res.end(Buffer.from(await response.arrayBuffer()));
          return;
        }
        const originalUrl = req.url;
        req.url = req.originalUrl ?? req.url;
        try {
          await dr.nodeHandler(req, res);
        } finally {
          req.url = originalUrl;
        }
      } catch (error) {
        next(error);
      }
      return;
    }
    req.betterFiles = helpers(req) as unknown as BetterFilesRequest<BetterFilesLike>;
    next();
  }

  /** Route guard on the permission matrix; the three functions read the ids from the request. */
  function requireCapability(
    capabilities: readonly string[],
    select: {
      tenantId: (req: Request) => string;
      roomId: (req: Request) => string;
      nodeId: (req: Request) => string;
    },
  ) {
    return async (req: Request, _res: Response, next: Next) => {
      try {
        await requireCapabilities(
          dr,
          { headers: toHeaders(req.headers) },
          {
            tenantId: select.tenantId(req),
            roomId: select.roomId(req),
            nodeId: select.nodeId(req),
            capabilities,
          },
        );
        next();
      } catch (error) {
        next(error);
      }
    };
  }

  /** Renders Better Files and Better IAM errors in the protocol's envelope; passes anything else on. */
  function errorHandler(error: unknown, _req: Request, res: Response, next: Next) {
    const { status, body } = errorResponse(error);
    if (status === 500) return next(error);
    send(res, status, body);
  }

  return { middleware, requireCapability, errorHandler, helpers };
}

declare module 'node:http' {
  interface IncomingMessage {
    /** Set by `createBetterFilesExpress().middleware`. */
    betterFiles?: BetterFilesRequest<BetterFilesLike>;
  }
}
