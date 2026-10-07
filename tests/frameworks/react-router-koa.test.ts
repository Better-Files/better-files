import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createBetterFilesKoa, type KoaContext } from '@better-files/middleware/koa';
import { createBetterFilesRouter } from '@better-files/middleware/react-router';
import { BetterFilesError } from '@better-files/core';
import { fixture, TENANT } from '../fixtures.js';

const protocolHeaders = (who: string) => ({
  authorization: `Bearer ${who}`,
  'x-better-files': '1',
  'content-type': 'application/json',
});

describe('React Router / Remix', () => {
  const args = (url: string, who: string, params: Record<string, string>) => ({
    request: new Request(url, { headers: { authorization: `Bearer ${who}` } }),
    params,
  });

  it('serves the protocol from a resource route', async () => {
    const f = await fixture();
    const room = await f.room();
    const drRouter = createBetterFilesRouter(f.dr, { ip: () => '198.51.100.9' });
    const response = await drRouter.api({
      request: new Request('http://app.test/api/better-files/rooms/get', {
        method: 'POST',
        headers: protocolHeaders('alice'),
        body: JSON.stringify({ tenantId: TENANT, roomId: room.id }),
      }),
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { data: { id: string } }).data.id).toBe(room.id);
  });

  it('guards loaders on the permission matrix and throws refusals as Responses', async () => {
    const f = await fixture();
    const room = await f.room();
    const { document } = await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'rr.txt',
      content: f.bytes(10),
    });
    const drRouter = createBetterFilesRouter(f.dr);
    const loader = drRouter.guard(
      ['VIEW'],
      async ({ params }, { api, held }) => {
        const doc = await api.documents.get({ tenantId: TENANT, nodeId: params.nodeId! });
        return { name: doc.name, canView: held.includes('VIEW') };
      },
      { tenantId: () => TENANT },
    );
    const params = { roomId: room.id, nodeId: document.id };

    await expect(loader(args('http://app.test/d', 'alice', params))).resolves.toEqual({
      name: 'rr.txt',
      canView: true,
    });
    // Bob holds nothing in the room: the guard does not confirm the document exists.
    const refused = await loader(args('http://app.test/d', 'bob', params)).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(Response);
    expect((refused as Response).status).toBe(404);
    expect(await (refused as Response).json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('returns action refusals as data and lets redirects through', async () => {
    const f = await fixture();
    const room = await f.room();
    const drRouter = createBetterFilesRouter(f.dr);
    const params = { roomId: room.id, nodeId: room.rootNodeId };

    const create = drRouter.action(
      ({ params: p }, { api }) =>
        api.folders.create({ tenantId: TENANT, parentId: p.nodeId!, name: 'From an action' }),
      { capabilities: ['UPLOAD'], select: { tenantId: () => TENANT } },
    );
    const made = await create(args('http://app.test/a', 'alice', params));
    expect(made).not.toBeInstanceOf(Response);
    expect((made as { name: string }).name).toBe('From an action');

    const denied = await create(args('http://app.test/a', 'bob', params));
    expect(denied).toBeInstanceOf(Response);
    expect((denied as Response).status).toBe(404);

    const failing = drRouter.action(() => {
      throw new BetterFilesError('CONFLICT', 'Taken');
    });
    expect(((await failing(args('http://app.test/a', 'alice', params))) as Response).status).toBe(
      409,
    );

    const redirecting = drRouter.action(() => {
      throw new Response(null, { status: 302, headers: { location: '/login' } });
    });
    await expect(redirecting(args('http://app.test/a', 'alice', params))).rejects.toBeInstanceOf(
      Response,
    );
  });
});

describe('Koa', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  type Middleware = (ctx: KoaContext, next: () => Promise<unknown>) => Promise<unknown>;

  /** A Koa-shaped app (context, cascading middleware, one `:param` route), enough to drive the integration. */
  async function listen(stack: Middleware[], route: { pattern: string; stack: Middleware[] }) {
    const matcher = new RegExp(`^${route.pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`);
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const ctx: KoaContext = {
        req,
        res,
        path: url.pathname,
        method: req.method ?? 'GET',
        originalUrl: req.url,
        state: {},
        status: 404,
        body: undefined,
        set: (field, value) => res.setHeader(field, value),
      };
      const match = matcher.exec(url.pathname);
      const chain = [...stack, ...(match ? route.stack : [])];
      if (match) ctx.params = { ...match.groups };
      const dispatch = (i: number): Promise<unknown> =>
        chain[i] ? chain[i]!(ctx, () => dispatch(i + 1)) : Promise.resolve();
      try {
        await dispatch(0);
      } catch {
        ctx.status = 500;
        ctx.body = 'boom';
      }
      if (ctx.respond === false) return;
      res.statusCode = ctx.status;
      if (Buffer.isBuffer(ctx.body) || typeof ctx.body === 'string') res.end(ctx.body);
      else {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(ctx.body));
      }
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('answers the protocol, streams files, binds ctx.state and guards routes', async () => {
    const f = await fixture();
    const room = await f.room();
    const { document } = await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'k.bin',
      content: f.bytes(4000),
    });
    const drKoa = createBetterFilesKoa(f.dr);
    const base = await listen([drKoa.errorHandler, drKoa.middleware], {
      pattern: '/t/:tenantId/r/:roomId/n/:nodeId',
      stack: [
        drKoa.requireCapability(['VIEW']),
        async (ctx) => {
          const doc = await drKoa
            .helpers(ctx)
            .api.documents.get({ tenantId: TENANT, nodeId: ctx.params!.nodeId! });
          ctx.status = 200;
          ctx.body = { name: doc.name, bound: ctx.state.betterFiles !== undefined };
        },
      ],
    });

    const listed = await fetch(`${base}/api/better-files/rooms/list`, {
      method: 'POST',
      headers: protocolHeaders('alice'),
      body: JSON.stringify({ tenantId: TENANT }),
    });
    expect(((await listed.json()) as { data: { id: string }[] }).data.map((r) => r.id)).toEqual([
      room.id,
    ]);

    const ticket = await f.dr.api.documents.requestOriginal(
      { headers: new Headers({ authorization: 'Bearer alice' }) },
      { tenantId: TENANT, nodeId: document.id },
    );
    const file = await fetch(`${base}${ticket.url}`);
    expect((await file.arrayBuffer()).byteLength).toBe(4000);

    const path = `/t/${TENANT}/r/${room.id}/n/${document.id}`;
    const guarded = await fetch(`${base}${path}`, { headers: { authorization: 'Bearer alice' } });
    expect(await guarded.json()).toEqual({ name: 'k.bin', bound: true });
    const hidden = await fetch(`${base}${path}`, { headers: { authorization: 'Bearer bob' } });
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('accepts bodies a body parser already consumed', async () => {
    const f = await fixture();
    const room = await f.room();
    const drKoa = createBetterFilesKoa(f.dr);
    const bodyParser: Middleware = async (ctx, next) => {
      if (ctx.method === 'POST') {
        let raw = '';
        for await (const chunk of ctx.req) raw += chunk;
        ctx.request = { body: JSON.parse(raw) };
      }
      await next();
    };
    const base = await listen([bodyParser, drKoa.middleware], { pattern: '/none', stack: [] });
    const response = await fetch(`${base}/api/better-files/rooms/get`, {
      method: 'POST',
      headers: protocolHeaders('alice'),
      body: JSON.stringify({ tenantId: TENANT, roomId: room.id }),
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { data: { id: string } }).data.id).toBe(room.id);
  });
});
