import type { Credential } from '@better-files/core';
import {
  basePathOf,
  bindApi,
  errorResponse,
  requireCapabilities,
  type BoundApi,
  type BetterFilesLike,
} from './index.js';

/** The slice of Hono's context the integration uses, so any Hono version works. */
interface HonoContext {
  req: { raw: Request; path: string; param(name: string): string | undefined };
  env?: { incoming?: { socket?: { remoteAddress?: string } } };
  set(key: string, value: unknown): void;
  get(key: string): unknown;
  json(body: unknown, status?: number): Response;
}
type Next = () => Promise<void>;

export interface HonoBetterFiles<D extends BetterFilesLike> {
  credential: Credential;
  api: BoundApi<D['api']>;
}

/**
 * Hono integration: `handler` answers the protocol (mount it on `${basePath}/*`), `middleware` puts the bound API on
 * `c.get('betterFiles')`, and `requireCapability` guards routes on the permission matrix.
 *
 * ```ts
 * const drHono = createBetterFilesHono(dr);
 * app.all('/api/better-files/*', drHono.handler);
 * app.use('*', drHono.middleware);
 * app.get('/deals/:roomId/:nodeId', drHono.requireCapability(['VIEW']), (c) => …);
 * ```
 */
export function createBetterFilesHono<D extends BetterFilesLike>(dr: D) {
  const base = basePathOf(dr);
  const ip = (c: HonoContext) => c.env?.incoming?.socket?.remoteAddress;
  return {
    basePath: base,
    handler(c: HonoContext): Promise<Response> {
      const address = ip(c);
      return dr.handler(c.req.raw, address ? { ip: address } : {});
    },
    async middleware(c: HonoContext, next: Next) {
      const credential: Credential = { headers: c.req.raw.headers };
      c.set('betterFiles', {
        credential,
        api: bindApi(dr, credential),
      } satisfies HonoBetterFiles<D>);
      await next();
    },
    /** Reads `tenantId`, `roomId` and `nodeId` from route params unless selectors are given. */
    requireCapability(
      capabilities: readonly string[],
      select: Partial<
        Record<'tenantId' | 'roomId' | 'nodeId', (c: HonoContext) => string | undefined>
      > = {},
    ) {
      return async (c: HonoContext, next: Next) => {
        const read = (name: 'tenantId' | 'roomId' | 'nodeId') =>
          (select[name] ? select[name]!(c) : c.req.param(name)) ?? '';
        try {
          await requireCapabilities(
            dr,
            { headers: c.req.raw.headers },
            {
              tenantId: read('tenantId'),
              roomId: read('roomId'),
              nodeId: read('nodeId'),
              capabilities,
            },
          );
        } catch (error) {
          const { status, body } = errorResponse(error);
          return c.json(body, status);
        }
        await next();
        return undefined;
      };
    },
  };
}
