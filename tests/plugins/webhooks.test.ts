import { describe, expect, it } from 'vitest';
import { verifyWebhookSignature, webhooksPlugin } from '@better-files/plugin-webhooks';
import { as, fixture, TENANT } from '../fixtures.js';

function receiver(options: { failFirst?: number } = {}) {
  const received: { headers: Headers; body: string }[] = [];
  let failures = options.failFirst ?? 0;
  const fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const body = String(init?.body);
    if (failures > 0) {
      failures--;
      return new Response('nope', { status: 503 });
    }
    received.push({ headers, body });
    return new Response('ok');
  }) as typeof globalThis.fetch;
  return { fetch, received };
}

describe('webhooks plugin', () => {
  it('signs deliveries for matching events and refuses private addresses', async () => {
    const target = receiver();
    const f = await fixture({
      plugins: [webhooksPlugin({ fetch: target.fetch, deliverImmediately: false })],
    });
    await expect(
      f.dr.api.webhooks.create(as('alice'), {
        tenantId: TENANT,
        url: 'https://127.0.0.1/hook',
        events: ['*'],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      f.dr.api.webhooks.create(as('alice'), {
        tenantId: TENANT,
        url: 'http://hooks.example.com/x',
        events: ['*'],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      f.dr.api.webhooks.create(as('alice'), {
        tenantId: TENANT,
        url: 'https://[::1]/x',
        events: ['*'],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    const hook = await f.dr.api.webhooks.create(as('alice'), {
      tenantId: TENANT,
      url: 'https://93.184.216.34/hook',
      events: ['room.*', 'folder.created'],
    });
    expect(hook.secret).toMatch(/^whsec_/);
    const room = await f.room();
    await f.dr.api.folders.create(as('alice'), {
      tenantId: TENANT,
      parentId: room.rootNodeId,
      name: 'A',
    });
    await f.dr.api.rooms.update(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      description: 'x',
    });
    await f.dr.maintain();
    expect(target.received.map((r) => r.headers.get('x-better-files-event'))).toEqual([
      'room.created',
      'folder.created',
      'room.updated',
    ]);
    for (const delivery of target.received)
      expect(
        verifyWebhookSignature({
          secret: hook.secret,
          body: delivery.body,
          header: delivery.headers.get('x-better-files-signature'),
          now: f.clock.current,
        }),
      ).toBe(true);
    expect(
      verifyWebhookSignature({
        secret: 'whsec_wrong',
        body: target.received[0]!.body,
        header: target.received[0]!.headers.get('x-better-files-signature'),
        now: f.clock.current,
      }),
    ).toBe(false);
    expect(JSON.parse(target.received[1]!.body)).toMatchObject({
      type: 'folder.created',
      tenantId: TENANT,
      roomId: room.id,
      data: { name: 'A' },
    });
  });

  it('retries failed deliveries with backoff', async () => {
    const target = receiver({ failFirst: 2 });
    const f = await fixture({
      plugins: [webhooksPlugin({ fetch: target.fetch, deliverImmediately: false })],
    });
    const hook = await f.dr.api.webhooks.create(as('alice'), {
      tenantId: TENANT,
      url: 'https://93.184.216.34/hook',
      events: ['room.created'],
    });
    await f.room();
    await f.dr.maintain();
    await f.dr.maintain(); // not due yet
    let deliveries = await f.dr.api.webhooks.deliveries(as('alice'), {
      tenantId: TENANT,
      webhookId: hook.id,
    });
    expect(deliveries[0]).toMatchObject({ attempts: 1, lastStatus: 503 });
    f.clock.current += 61_000;
    await f.dr.maintain();
    f.clock.current += 121_000;
    await f.dr.maintain();
    deliveries = await f.dr.api.webhooks.deliveries(as('alice'), {
      tenantId: TENANT,
      webhookId: hook.id,
    });
    expect(deliveries[0]).toMatchObject({ attempts: 3, lastStatus: 200 });
    expect(deliveries[0]!.deliveredAt).toBeDefined();
    expect(target.received).toHaveLength(1);
  });

  it('is managed by people with the tenant-level permission only', async () => {
    const f = await fixture({ plugins: [webhooksPlugin({ deliverImmediately: false })] });
    await expect(f.dr.api.webhooks.list(as('bob'), { tenantId: TENANT })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
