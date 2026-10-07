import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  blockedAddressReason,
  verifyWebhookSignature,
  webhooksPlugin,
} from '@better-files/plugin-webhooks';
import { guardedLookup } from '../../packages/plugin-webhooks/src/network.js';
import { as, fixture, TENANT } from '../fixtures.js';

describe('webhook address policy', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '198.18.0.1',
    '192.0.0.170',
    '224.0.0.1',
    '255.255.255.255',
    '0.0.0.0',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:a9fe:a9fe',
    '0:0:0:0:0:ffff:10.0.0.1',
    '::127.0.0.1',
    '64:ff9b::a9fe:a9fe',
    '64:ff9b::10.0.0.1',
    'fd00::1',
    'fe80::1%eth0',
    'ff02::1',
    '2002:7f00:1::',
    '2001:0:4136:e378::1',
    '2001:db8::1',
    'not-an-ip',
  ])('blocks %s', (address) => {
    expect(blockedAddressReason(address)).toBeDefined();
  });

  it.each([
    '93.184.216.34',
    '8.8.8.8',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
  ])('allows %s', (address) => {
    expect(blockedAddressReason(address)).toBeUndefined();
  });

  it('refuses at connect time what the resolver returns then (DNS rebinding)', async () => {
    const lookup = guardedLookup(async () => ['93.184.216.34', '127.0.0.1']);
    const error = await new Promise<Error | null>((resolve) =>
      lookup('rebind.example.test', { all: true }, (e) => resolve(e)),
    );
    expect(error?.message).toMatch(/non-public/);
    const publicOnly = guardedLookup(async () => ['93.184.216.34']);
    const ok = await new Promise<unknown>((resolve) =>
      (publicOnly as (h: string, o: object, cb: (e: Error | null, a: unknown) => void) => void)(
        'hooks.example.test',
        { all: true },
        (_e, addresses) => resolve(addresses),
      ),
    );
    expect(ok).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });
});

describe('webhook delivery hardening', () => {
  it('does not connect when the host re-resolves to a private address after creation', async () => {
    let calls = 0;
    // Public when the webhook is created, loopback when the delivery connects.
    const resolver = async () => (calls++ === 0 ? ['93.184.216.34'] : ['127.0.0.1']);
    const f = await fixture({
      plugins: [webhooksPlugin({ resolver, deliverImmediately: false })],
    });
    const hook = await f.dr.api.webhooks.create(as('alice'), {
      tenantId: TENANT,
      url: 'https://rebind.example.test/hook',
      events: ['room.created'],
    });
    await f.room();
    await f.dr.maintain();
    const [delivery] = await f.dr.api.webhooks.deliveries(as('alice'), {
      tenantId: TENANT,
      webhookId: hook.id,
    });
    expect(delivery).toMatchObject({ attempts: 1 });
    expect(delivery!.deliveredAt).toBeUndefined();
    expect(delivery!.lastError).toMatch(/non-public/);
  });

  it('delivers through the built-in client, signed', async () => {
    const received: { headers: Record<string, unknown>; body: string }[] = [];
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        received.push({ headers: request.headers, body });
        response.end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const f = await fixture({
        plugins: [webhooksPlugin({ allowPrivateNetworks: true, deliverImmediately: false })],
      });
      const hook = await f.dr.api.webhooks.create(as('alice'), {
        tenantId: TENANT,
        url: `http://127.0.0.1:${port}/hook`,
        events: ['room.created'],
      });
      await f.room();
      await f.dr.maintain();
      expect(received).toHaveLength(1);
      expect(
        verifyWebhookSignature({
          secret: hook.secret,
          body: received[0]!.body,
          header: received[0]!.headers['x-better-files-signature'] as string,
          now: f.clock.current,
        }),
      ).toBe(true);
    } finally {
      server.close();
    }
  });

  it('delivers once when immediate delivery and maintain() race', async () => {
    let count = 0;
    const fetch = (async () => {
      count++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response('ok');
    }) as typeof globalThis.fetch;
    const f = await fixture({ plugins: [webhooksPlugin({ fetch })] });
    await f.dr.api.webhooks.create(as('alice'), {
      tenantId: TENANT,
      url: 'https://93.184.216.34/hook',
      events: ['room.created'],
    });
    await f.room();
    await Promise.all([f.dr.maintain(), f.dr.maintain()]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(count).toBe(1);
  });

  it('signs with both secrets during a rotation’s grace period', async () => {
    const bodies: { body: string; header: string }[] = [];
    const fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push({
        body: String(init?.body),
        header: new Headers(init?.headers).get('x-better-files-signature')!,
      });
      return new Response('ok');
    }) as typeof globalThis.fetch;
    const f = await fixture({ plugins: [webhooksPlugin({ fetch, deliverImmediately: false })] });
    const hook = await f.dr.api.webhooks.create(as('alice'), {
      tenantId: TENANT,
      url: 'https://93.184.216.34/hook',
      events: ['room.*'],
    });
    const rotated = await f.dr.api.webhooks.update(as('alice'), {
      tenantId: TENANT,
      webhookId: hook.id,
      rotateSecret: true,
    });
    expect(rotated).not.toHaveProperty('previousSecret');
    const listed = await f.dr.api.webhooks.list(as('alice'), { tenantId: TENANT });
    expect(JSON.stringify(listed)).not.toContain('whsec_');

    await f.room('During grace');
    await f.dr.maintain();
    const during = bodies.at(-1)!;
    expect(during.header.match(/v1=/g)).toHaveLength(2);
    for (const secret of [hook.secret, (rotated as { secret: string }).secret])
      expect(verifyWebhookSignature({ secret, ...during, now: f.clock.current })).toBe(true);

    f.clock.current += 25 * 60 * 60_000;
    await f.room('After grace');
    await f.dr.maintain();
    const after = bodies.at(-1)!;
    expect(after.header.match(/v1=/g)).toHaveLength(1);
    expect(verifyWebhookSignature({ secret: hook.secret, ...after, now: f.clock.current })).toBe(
      false,
    );
  });

  it('parses signature headers strictly', () => {
    const base = { secret: 's', body: '{}', now: 1_000_000 };
    expect(verifyWebhookSignature({ ...base, header: 'v1=abc' })).toBe(false);
    expect(verifyWebhookSignature({ ...base, header: 't=1000,' })).toBe(false);
    expect(verifyWebhookSignature({ ...base, header: 't=1e3,v1=abc' })).toBe(false);
    expect(verifyWebhookSignature({ ...base, header: null })).toBe(false);
  });
});
