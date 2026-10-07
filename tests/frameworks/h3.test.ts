import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { betterFilesH3 } from '@better-files/middleware/h3';
import { fixture, TENANT } from '../fixtures.js';

const post = (roomId: string) => ({
  method: 'POST',
  headers: {
    authorization: 'Bearer alice',
    'x-better-files': '1',
    'content-type': 'application/json',
  },
  body: JSON.stringify({ tenantId: TENANT, roomId }),
});

describe('h3 (Nuxt, Nitro)', () => {
  it('answers h3 v2 events with a Response', async () => {
    const f = await fixture();
    const room = await f.room();
    const handler = betterFilesH3(f.dr, { ip: () => '198.51.100.7' });
    const response = await handler({
      req: new Request('http://app.test/api/better-files/rooms/get', post(room.id)),
    });
    expect(response?.status).toBe(200);
    expect(((await response!.json()) as { data: { id: string } }).data.id).toBe(room.id);
  });

  it('writes to Node for h3 v1 events', async () => {
    const f = await fixture();
    const room = await f.room();
    const handler = betterFilesH3(f.dr);
    const server = createServer((req, res) => void handler({ node: { req, res } }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const response = await fetch(`${base}/api/better-files/rooms/get`, post(room.id));
      expect(response.status).toBe(200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
