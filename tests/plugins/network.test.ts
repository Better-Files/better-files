import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createBetterFilesExpress } from '@better-files/middleware/express';
import { ipInRanges, networkPlugin, parseIp, parseIpRange } from '@better-files/plugin-network';
import { as, fixture, TENANT } from '../fixtures.js';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

describe('IP ranges', () => {
  it('parses IPv4, IPv6, brackets, zone ids and IPv4-mapped addresses', () => {
    expect([...parseIp('192.0.2.1')!]).toEqual([192, 0, 2, 1]);
    expect(parseIp('::ffff:192.0.2.1')).toEqual(parseIp('192.0.2.1'));
    expect(parseIp('[2001:db8::1]')).toEqual(parseIp('2001:db8:0:0:0:0:0:1'));
    expect(parseIp('fe80::1%eth0')).toEqual(parseIp('fe80::1'));
    expect(parseIp('::')).toEqual(new Uint8Array(16));
    for (const bad of ['256.0.0.1', '1.2.3', '01.2.3.4', '1::2::3', '2001:db8::g', '', 'a.b.c.d'])
      expect(parseIp(bad), bad).toBeUndefined();
    expect(parseIpRange('10.0.0.0/33')).toBeUndefined();
    expect(parseIpRange('2001:db8::/129')).toBeUndefined();
    expect(parseIpRange('10.0.0.0/8/1')).toBeUndefined();
    expect(parseIpRange('::ffff:10.0.0.0/104')).toEqual(parseIpRange('10.0.0.0/8'));
  });

  it('matches addresses against ranges', () => {
    const ranges = ['203.0.113.0/24', '198.51.100.7', '2001:db8::/32', '10.1.2.3/12'];
    expect(ipInRanges('203.0.113.200', ranges)).toBe(true);
    expect(ipInRanges('203.0.114.1', ranges)).toBe(false);
    expect(ipInRanges('198.51.100.7', ranges)).toBe(true);
    expect(ipInRanges('198.51.100.8', ranges)).toBe(false);
    expect(ipInRanges('::ffff:203.0.113.5', ranges)).toBe(true);
    expect(ipInRanges('2001:db8:ffff::1', ranges)).toBe(true);
    expect(ipInRanges('2001:db9::1', ranges)).toBe(false);
    // Host bits beyond the prefix are ignored: 10.1.2.3/12 is 10.0.0.0/12.
    expect(ipInRanges('10.15.255.255', ranges)).toBe(true);
    expect(ipInRanges('10.16.0.0', ranges)).toBe(false);
    expect(ipInRanges('not-an-ip', ranges)).toBe(false);
    expect(ipInRanges('0.0.0.0', ['0.0.0.0/0'])).toBe(true);
  });
});

async function restrictedRoom(options: Parameters<typeof networkPlugin>[0] = {}) {
  const f = await fixture({ plugins: [networkPlugin(options)] });
  const room = await f.room();
  const { document } = await f.upload('alice', {
    parentId: room.rootNodeId,
    filename: 'cim.pdf',
    content: f.bytes(64),
  });
  const buyers = await f.dr.api.groups.create(as('alice'), {
    tenantId: TENANT,
    roomId: room.id,
    name: 'Buyers',
    preset: 'download',
  });
  for (const email of ['bob@acme.test', 'dave@acme.test'])
    await f.dr.api.members.invite(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      email,
      groupIds: [buyers.id],
    });
  // Bob is a guest from outside the organization; Dave is an employee.
  f.principals.bob = { ...f.principals.bob!, guest: true };
  const list = (who: string, ip?: string) =>
    f.dr.api.folders
      .list(as(who), { tenantId: TENANT, nodeId: room.rootNodeId }, ip ? { ip } : undefined)
      .then(
        (result) => result.items.map((item) => item.name),
        (error: { code: string }) => error.code,
      );
  return { f, room, document, list };
}

describe('network plugin', () => {
  it('restricts guests to the allowed ranges and leaves employees and owners alone', async () => {
    const { f, room, document, list } = await restrictedRoom();
    expect(await list('bob', '192.0.2.10')).toEqual(['cim.pdf']);

    await expect(
      f.dr.api.network.set(as('bob'), {
        tenantId: TENANT,
        roomId: room.id,
        allowedRanges: ['0.0.0.0/0'],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const rule = await f.dr.api.network.set(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      allowedRanges: ['203.0.113.0/24', ' 203.0.113.0/24 ', '2001:db8::/32'],
      appliesTo: 'external',
    });
    expect(rule).toMatchObject({
      allowedRanges: ['203.0.113.0/24', '2001:db8::/32'],
      appliesTo: 'external',
    });

    // The guest sees nothing from elsewhere, not even names, and everything from the office network.
    expect(await list('bob', '192.0.2.10')).toBe('NOT_FOUND');
    expect(await list('bob', '203.0.113.9')).toEqual(['cim.pdf']);
    expect(await list('bob', '2001:db8::5')).toEqual(['cim.pdf']);
    await expect(
      f.dr.api.documents.requestOriginal(
        as('bob'),
        { tenantId: TENANT, nodeId: document.id },
        { ip: '192.0.2.10' },
      ),
    ).rejects.toMatchObject({ code: expect.stringMatching(/NOT_FOUND|FORBIDDEN/) });
    // Without a known address the guest is refused too (fail closed).
    expect(await list('bob')).toBe('NOT_FOUND');
    // The employee and the owner are not restricted by an `external` rule.
    expect(await list('dave', '192.0.2.10')).toEqual(['cim.pdf']);
    expect(await list('alice', '192.0.2.10')).toEqual(['cim.pdf']);

    expect(
      await f.dr.api.network.status(
        as('bob'),
        { tenantId: TENANT, roomId: room.id },
        { ip: '192.0.2.10' },
      ),
    ).toEqual({ restricted: true, allowed: false, ip: '192.0.2.10' });
    expect(
      await f.dr.api.network.status(
        as('dave'),
        { tenantId: TENANT, roomId: room.id },
        { ip: '192.0.2.10' },
      ),
    ).toEqual({ restricted: false, allowed: true, ip: '192.0.2.10' });
    const caps = (ip: string) =>
      f.dr.api.permissions.capabilities(
        as('bob'),
        { tenantId: TENANT, roomId: room.id, nodeIds: [document.id] },
        { ip },
      );
    expect((await caps('203.0.113.9'))[document.id]).toContain('DOWNLOAD_WATERMARKED');
    expect((await caps('192.0.2.10'))[document.id] ?? []).toEqual([]);

    // `everyone` restricts the employee as well; owners stay exempt so they cannot lock themselves out.
    await f.dr.api.network.set(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      allowedRanges: ['203.0.113.0/24'],
      appliesTo: 'everyone',
    });
    expect(await list('dave', '192.0.2.10')).toBe('NOT_FOUND');
    expect(await list('dave', '203.0.113.1')).toEqual(['cim.pdf']);
    expect(await list('alice', '192.0.2.10')).toEqual(['cim.pdf']);

    // An empty list lifts the restriction; every change is in the activity log.
    await f.dr.api.network.set(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      allowedRanges: [],
    });
    expect(await list('bob', '192.0.2.10')).toEqual(['cim.pdf']);
    const activity = await f.dr.api.activity.list(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
    });
    expect(activity.filter((record) => record.action === 'network.changed')).toHaveLength(3);
  });

  it('refuses invalid ranges and can let unknown addresses through', async () => {
    const { f, room, list } = await restrictedRoom({ unknownAddress: 'allow' });
    await expect(
      f.dr.api.network.set(as('alice'), {
        tenantId: TENANT,
        roomId: room.id,
        allowedRanges: ['203.0.113.0/24', '10.0.0.0/40', 'office'],
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('10.0.0.0/40, office'),
    });
    expect(
      await f.dr.api.network.get(as('alice'), { tenantId: TENANT, roomId: room.id }),
    ).toBeNull();
    await f.dr.api.network.set(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      allowedRanges: ['203.0.113.0/24'],
    });
    expect(await list('bob')).toEqual(['cim.pdf']);
    expect(await list('bob', '192.0.2.10')).toBe('NOT_FOUND');
  });

  it('uses the client address an HTTP framework reports', async () => {
    const { f, room } = await restrictedRoom();
    const app = express();
    const drExpress = createBetterFilesExpress(f.dr);
    app.use(drExpress.middleware);
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const listing = () =>
      fetch(`${base}/api/better-files/folders/list`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer bob',
          'x-better-files': '1',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ tenantId: TENANT, nodeId: room.rootNodeId }),
      });
    await f.dr.api.network.set(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      allowedRanges: ['203.0.113.0/24'],
    });
    expect((await listing()).status).toBe(404);
    // Loopback is 127.0.0.1, or ::ffff:127.0.0.1 on a dual-stack socket; both match the IPv4 range.
    await f.dr.api.network.set(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      allowedRanges: ['127.0.0.0/8'],
    });
    expect((await listing()).status).toBe(200);
  });
});
