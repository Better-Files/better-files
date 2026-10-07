/**
 * h3 (Nuxt, Nitro, Analog, SolidStart) without importing h3: h3 v2 events carry a web `Request` (`event.req`);
 * h3 v1 events carry Node's request and response (`event.node`).
 *
 * ```ts
 * // server/routes/api/better-files/[...path].ts (Nuxt)
 * export default defineEventHandler(betterFilesH3(dr));
 * ```
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

interface BetterFilesLike {
  handler(request: Request, info?: { ip?: string }): Promise<Response>;
  nodeHandler(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

interface H3EventLike {
  req?: unknown;
  node?: { req: IncomingMessage; res: ServerResponse };
}

const isRequest = (value: unknown): value is Request =>
  typeof value === 'object' &&
  value !== null &&
  'headers' in value &&
  typeof (value as Request).headers?.get === 'function' &&
  'url' in value;

/** An h3 event handler serving the Better Files protocol. Returns a `Response` (h3 v2) or writes to Node's response (v1). */
export function betterFilesH3(
  dr: BetterFilesLike,
  options: { ip?: (event: H3EventLike) => string | undefined } = {},
) {
  return async (event: H3EventLike): Promise<Response | undefined> => {
    if (isRequest(event.req)) {
      const ip = options.ip?.(event);
      return dr.handler(event.req, ip ? { ip } : {});
    }
    if (event.node) {
      await dr.nodeHandler(event.node.req, event.node.res);
      return undefined;
    }
    throw new Error('betterFilesH3: unsupported h3 event');
  };
}
