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

interface FastifyRequest {
  raw: IncomingMessage;
  url: string;
  headers: IncomingMessage['headers'];
  params?: unknown;
  betterFiles?: { credential: Credential; api: BoundApi<object> };
}
interface FastifyReply {
  raw: ServerResponse;
  hijack(): void;
  code(status: number): FastifyReply;
  send(body: unknown): FastifyReply;
}
interface FastifyInstance {
  addHook(
    name: 'onRequest',
    hook: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
  ): void;
  decorateRequest(name: string, value: unknown): void;
}

/**
 * Fastify integration: answers the protocol in an `onRequest` hook (before Fastify parses bodies, so uploads stream)
 * and decorates other requests with `request.betterFiles`. Register it with `fastify-plugin` semantics (it does not
 * encapsulate), or call it on the root instance: `await betterFilesFastify(app, { dr })`.
 */
export async function betterFilesFastify<D extends BetterFilesLike>(
  app: FastifyInstance,
  options: { dr: D },
) {
  const { dr } = options;
  const base = basePathOf(dr);
  app.decorateRequest('betterFiles', null);
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0]!;
    if (path === base || path.startsWith(`${base}/`)) {
      reply.hijack();
      await dr.nodeHandler(request.raw, reply.raw);
      return;
    }
    const credential: Credential = { headers: toHeaders(request.headers) };
    request.betterFiles = { credential, api: bindApi(dr, credential) };
  });
}

/** A `preHandler` guard on the permission matrix. */
export function requireCapability<D extends BetterFilesLike>(
  dr: D,
  capabilities: readonly string[],
  select: {
    tenantId: (request: FastifyRequest) => string;
    roomId: (request: FastifyRequest) => string;
    nodeId: (request: FastifyRequest) => string;
  },
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await requireCapabilities(
        dr,
        { headers: toHeaders(request.headers) },
        {
          tenantId: select.tenantId(request),
          roomId: select.roomId(request),
          nodeId: select.nodeId(request),
          capabilities,
        },
      );
    } catch (error) {
      const { status, body } = errorResponse(error);
      // An async hook that replies must return the reply, or Fastify goes on to the route handler.
      return reply.code(status).send(body);
    }
    return undefined;
  };
}

/** `Symbol.for('skip-override')` lets Fastify apply the hook to the whole app, like fastify-plugin does. */
(betterFilesFastify as unknown as Record<symbol, boolean>)[Symbol.for('skip-override')] = true;
