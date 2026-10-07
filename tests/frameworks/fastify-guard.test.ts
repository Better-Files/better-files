import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { betterFilesFastify, requireCapability } from '@better-files/middleware/fastify';
import { fixture, TENANT } from '../fixtures.js';

describe('Fastify guard', () => {
  it('stops at a refusal: the route handler never runs', async () => {
    const f = await fixture();
    const room = await f.room();
    const app = Fastify();
    await betterFilesFastify(app as never, { dr: f.dr });
    let ran = 0;
    app.post(
      '/rooms/:nodeId/danger',
      {
        preHandler: requireCapability(f.dr, ['MANAGE'], {
          tenantId: () => TENANT,
          roomId: () => room.id,
          nodeId: (r) => (r.params as { nodeId: string }).nodeId,
        }) as never,
      },
      async () => {
        ran += 1;
        return { ok: true };
      },
    );
    try {
      const refused = await app.inject({
        method: 'POST',
        url: `/rooms/${room.rootNodeId}/danger`,
        headers: { authorization: 'Bearer bob' },
      });
      expect(refused.statusCode).toBe(404);
      expect(refused.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
      expect(ran).toBe(0);

      const allowed = await app.inject({
        method: 'POST',
        url: `/rooms/${room.rootNodeId}/danger`,
        headers: { authorization: 'Bearer alice' },
      });
      expect(allowed.statusCode).toBe(200);
      expect(ran).toBe(1);
    } finally {
      await app.close();
    }
  });
});
