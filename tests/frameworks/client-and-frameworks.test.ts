import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import express from 'express';
import { Hono } from 'hono';
import Fastify from 'fastify';
import { createBetterFilesClient, BetterFilesClientError } from '@better-files/client';
import { createBetterFilesExpress } from '@better-files/middleware/express';
import { createBetterFilesHono } from '@better-files/middleware/hono';
import { betterFilesFastify, requireCapability } from '@better-files/middleware/fastify';
import { createBetterFilesNext } from '@better-files/next';
import type { BoundApi } from '@better-files/middleware';
import { as, fixture, TENANT } from '../fixtures.js';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('typed client', () => {
  it('calls operations, uploads in parallel parts and reports errors', async () => {
    const f = await fixture();
    type Server = typeof f.dr;
    const client = createBetterFilesClient<Server>({
      baseURL: 'http://app.test',
      tenantId: TENANT,
      headers: () => ({ authorization: 'Bearer alice' }),
      fetch: (input, init) => f.dr.handler(new Request(input, init)),
      requestId: true,
    });
    const room = await client.rooms.create({ name: 'Client room' });
    expectTypeOf(room.name).toEqualTypeOf<string>();
    const folder = await client.folders.create({ parentId: room.rootNodeId, name: 'Docs' });
    const content = f.bytes(200_000, 3);
    const seen: number[] = [];
    const result = await client.upload({
      parentId: folder.id,
      file: new Blob([content]),
      filename: 'big.bin',
      concurrency: 2,
      onProgress: (p) => seen.push(p.ratio),
    });
    expect(result.version.number).toBe(1);
    expect(seen.at(-1)).toBe(1);
    const listing = await client.folders.list({ nodeId: folder.id });
    expect(listing.items.map((item) => item.name)).toEqual(['big.bin']);
    const ticket = await client.documents.requestOriginal({ nodeId: result.document.id });
    const download = await f.dr.handler(new Request(client.fileUrl(ticket.url)));
    expect(Buffer.from(await download.arrayBuffer()).equals(Buffer.from(content))).toBe(true);

    const error = await client.folders
      .create({ parentId: folder.id, name: 'a/b' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BetterFilesClientError);
    expect(error).toMatchObject({ code: 'INVALID_INPUT', status: 400 });
    let unauthenticated = 0;
    const anonymous = createBetterFilesClient<Server>({
      baseURL: 'http://app.test',
      tenantId: TENANT,
      fetch: (input, init) => f.dr.handler(new Request(input, init)),
      onUnauthenticated: () => unauthenticated++,
    });
    await expect(anonymous.rooms.list({})).rejects.toMatchObject({ status: 401 });
    expect(unauthenticated).toBe(1);
  });
});

describe('Express', () => {
  it('serves the protocol and streams files through the middleware, with body parsers and guards', async () => {
    const f = await fixture();
    const room = await f.room();
    const { document } = await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'x.bin',
      content: f.bytes(5000),
    });
    const app = express();
    const drExpress = createBetterFilesExpress(f.dr);
    app.use(express.json());
    app.use(drExpress.middleware);
    app.get(
      '/rooms/:roomId/docs/:nodeId',
      drExpress.requireCapability(['VIEW'], {
        tenantId: () => TENANT,
        roomId: (req) => req.params!.roomId!,
        nodeId: (req) => req.params!.nodeId!,
      }),
      async (req, res) => {
        // `helpers(req)` is typed from the instance; `req.betterFiles` is the same object for untyped code.
        const doc = await drExpress
          .helpers(req)
          .api.documents.get({ tenantId: TENANT, nodeId: req.params!.nodeId! });
        res.json({ name: doc.name });
      },
    );
    app.use(drExpress.errorHandler);
    const base = await listen(app);
    const headers = {
      authorization: 'Bearer alice',
      'x-better-files': '1',
      'content-type': 'application/json',
    };

    const listed = await fetch(`${base}/api/better-files/rooms/list`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tenantId: TENANT }),
    });
    expect(((await listed.json()) as { data: { id: string }[] }).data.map((r) => r.id)).toEqual([
      room.id,
    ]);

    const session = await f.dr.api.uploads.create(as('alice'), {
      tenantId: TENANT,
      parentId: room.rootNodeId,
      filename: 'y.bin',
      size: 3000,
    });
    const put = await fetch(`${base}${session.contentUrl}`, {
      method: 'PUT',
      headers: { authorization: 'Bearer alice', 'x-better-files': '1' },
      body: f.bytes(3000),
    });
    expect(put.status).toBe(200);

    const ticket = await f.dr.api.documents.requestOriginal(as('alice'), {
      tenantId: TENANT,
      nodeId: document.id,
    });
    const file = await fetch(`${base}${ticket.url}`);
    expect((await file.arrayBuffer()).byteLength).toBe(5000);

    const guarded = await fetch(`${base}/rooms/${room.id}/docs/${document.id}`, {
      headers: { authorization: 'Bearer alice' },
    });
    expect(await guarded.json()).toEqual({ name: 'x.bin' });
    const hidden = await fetch(`${base}/rooms/${room.id}/docs/${document.id}`, {
      headers: { authorization: 'Bearer bob' },
    });
    // Bob holds nothing in the room: the guard does not confirm the document exists.
    expect(hidden.status).toBe(404);
  });
});

describe('Hono', () => {
  it('mounts the handler and guards routes', async () => {
    const f = await fixture();
    const room = await f.room();
    const { document } = await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'h.txt',
      content: f.bytes(10),
    });
    const drHono = createBetterFilesHono(f.dr);
    const app = new Hono();
    app.all('/api/better-files/*', (c) => drHono.handler(c as never));
    app.use('*', (c, next) => drHono.middleware(c as never, next));
    app.get('/t/:tenantId/r/:roomId/n/:nodeId', drHono.requireCapability(['VIEW']) as never, (c) =>
      c.text('ok'),
    );
    const created = await app.request('/api/better-files/folders/create', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'x-better-files': '1',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ tenantId: TENANT, parentId: room.rootNodeId, name: 'Via Hono' }),
    });
    expect(created.status).toBe(200);
    expect(
      (
        await app.request(`/t/${TENANT}/r/${room.id}/n/${document.id}`, {
          headers: { authorization: 'Bearer alice' },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(`/t/${TENANT}/r/${room.id}/n/${document.id}`, {
          headers: { authorization: 'Bearer bob' },
        })
      ).status,
    ).toBe(404);
  });
});

describe('Fastify', () => {
  it('answers the protocol before body parsing and decorates requests', async () => {
    const f = await fixture();
    const room = await f.room();
    const app = Fastify();
    await betterFilesFastify(app as never, { dr: f.dr });
    app.get('/whoami', async (request) => {
      const { api } = (request as unknown as { betterFiles: { api: BoundApi<typeof f.dr.api> } })
        .betterFiles;
      const rooms = await api.rooms.list({ tenantId: TENANT });
      return { rooms: rooms.length };
    });
    app.get(
      '/guard/:nodeId',
      {
        preHandler: requireCapability(f.dr, ['MANAGE'], {
          tenantId: () => TENANT,
          roomId: () => room.id,
          nodeId: (r) => (r.params as { nodeId: string }).nodeId,
        }) as never,
      },
      async () => ({ ok: true }),
    );
    await app.ready();
    const base = await new Promise<string>((resolve) =>
      app.listen({ port: 0, host: '127.0.0.1' }, (_, address) => resolve(address)),
    );
    try {
      const session = await f.dr.api.uploads.create(as('alice'), {
        tenantId: TENANT,
        parentId: room.rootNodeId,
        filename: 'f.bin',
        size: 70_000,
      });
      const put = await fetch(`${base}${session.partUrl.replace('{part}', '2')}`, {
        method: 'PUT',
        headers: {
          authorization: 'Bearer alice',
          'x-better-files': '1',
          'content-type': 'application/octet-stream',
        },
        body: f.bytes(70_000 - 65_536),
      });
      expect(put.status).toBe(200);
      expect(
        await (
          await fetch(`${base}/whoami`, { headers: { authorization: 'Bearer alice' } })
        ).json(),
      ).toEqual({ rooms: 1 });
      expect(
        (
          await fetch(`${base}/guard/${room.rootNodeId}`, {
            headers: { authorization: 'Bearer alice' },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await fetch(`${base}/guard/${room.rootNodeId}`, {
            headers: { authorization: 'Bearer bob' },
          })
        ).status,
      ).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe('Next.js', () => {
  it('exposes route handlers, a bound server API and page guards', async () => {
    const f = await fixture();
    const room = await f.room();
    const drNext = createBetterFilesNext(f.dr);
    const { POST } = drNext.handlers();
    const response = await POST(
      new Request('http://app.test/api/better-files/rooms/get', {
        method: 'POST',
        headers: {
          authorization: 'Bearer alice',
          'x-better-files': '1',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ tenantId: TENANT, roomId: room.id }),
      }),
    );
    expect(response.status).toBe(200);
    const api = drNext.api({ authorization: 'Bearer alice' });
    const index = await api.rooms.index({ tenantId: TENANT, roomId: room.id });
    expect(index).toEqual([]);
    expect(
      await drNext.capabilities(
        { authorization: 'Bearer bob' },
        { tenantId: TENANT, roomId: room.id, nodeId: room.rootNodeId, capabilities: ['VIEW'] },
      ),
    ).toBeNull();
    expect(
      await drNext.capabilities(
        { authorization: 'Bearer alice' },
        { tenantId: TENANT, roomId: room.id, nodeId: room.rootNodeId, capabilities: ['VIEW'] },
      ),
    ).toContain('MANAGE');
  });
});
