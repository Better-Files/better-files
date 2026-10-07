import { describe, expect, it } from 'vitest';
import { linksPlugin } from '@better-files/plugin-links';
import { as, fixture, TENANT } from '../fixtures.js';

async function setup() {
  const f = await fixture({ plugins: [linksPlugin()] });
  const room = await f.room();
  const folder = await f.dr.api.folders.create(as('alice'), {
    tenantId: TENANT,
    parentId: room.rootNodeId,
    name: 'Shared',
  });
  const inner = await f.upload('alice', {
    parentId: folder.id,
    filename: 'teaser.pdf',
    content: f.bytes(300, 9),
  });
  const outside = await f.upload('alice', {
    parentId: room.rootNodeId,
    filename: 'private.pdf',
    content: f.bytes(100),
  });
  await f.dr.api.rooms.publish(as('alice'), { tenantId: TENANT, roomId: room.id });
  return { f, room, folder, inner: inner.document, outside: outside.document };
}

describe('share links plugin', () => {
  it('is off until enabled, and links carry no more than their creator holds', async () => {
    const { f, room, folder } = await setup();
    await expect(
      f.dr.api.links.create(as('alice'), {
        tenantId: TENANT,
        nodeId: folder.id,
        capabilities: ['VIEW'],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      f.dr.api.links.configure(as('bob'), { tenantId: TENANT, roomId: room.id, enabled: true }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await f.dr.api.links.configure(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      enabled: true,
    });
    const link = await f.dr.api.links.create(as('alice'), {
      tenantId: TENANT,
      nodeId: folder.id,
      capabilities: ['VIEW', 'DOWNLOAD_WATERMARKED'],
    });
    expect(link.capabilities).toEqual(['LIST', 'VIEW', 'DOWNLOAD_WATERMARKED']);
    expect(link.token.length).toBeGreaterThan(20);
    const listed = await f.dr.api.links.list(as('alice'), { tenantId: TENANT, roomId: room.id });
    expect(listed[0]).not.toHaveProperty('tokenHash');
  });

  it('lets visitors browse and download within the shared folder, with email and password checks', async () => {
    const { f, room, folder, inner, outside } = await setup();
    await f.dr.api.links.configure(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      enabled: true,
    });
    const link = await f.dr.api.links.create(as('alice'), {
      tenantId: TENANT,
      nodeId: folder.id,
      capabilities: ['VIEW', 'DOWNLOAD_ORIGINAL'],
      password: 'correct horse battery',
      requireEmail: true,
      maxUses: 2,
    });
    const anonymous = {};
    await expect(
      f.dr.api.links.open(anonymous, { tenantId: TENANT, token: link.token }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(
      f.dr.api.links.open(anonymous, {
        tenantId: TENANT,
        token: link.token,
        password: 'wrong password',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(
      f.dr.api.links.open(anonymous, {
        tenantId: TENANT,
        token: link.token,
        password: 'correct horse battery',
      }),
    ).rejects.toMatchObject({ details: { email: true } });
    const opened = await f.dr.api.links.open(anonymous, {
      tenantId: TENANT,
      token: link.token,
      password: 'correct horse battery',
      email: 'Visitor@Buyer.test',
    });
    expect(opened).toMatchObject({
      item: { name: 'Shared', kind: 'folder' },
      room: { name: 'Project Falcon' },
    });

    const listing = await f.dr.api.links.browse(anonymous, {
      tenantId: TENANT,
      session: opened.session,
    });
    expect(listing.items.map((item) => item.name)).toEqual(['teaser.pdf']);
    await expect(
      f.dr.api.links.browse(anonymous, {
        tenantId: TENANT,
        session: opened.session,
        nodeId: outside.id,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const ticket = await f.dr.api.links.download(anonymous, {
      tenantId: TENANT,
      session: opened.session,
      nodeId: inner.id,
      variant: 'original',
    });
    expect((await f.download(ticket.url)).body.byteLength).toBe(300);
    await expect(
      f.dr.api.links.download(anonymous, {
        tenantId: TENANT,
        session: opened.session,
        nodeId: outside.id,
        variant: 'original',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const activity = await f.dr.api.activity.list(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      limit: 3,
    });
    expect(activity[0]).toMatchObject({
      action: 'document.downloaded',
      metadata: { email: 'visitor@buyer.test', linkId: link.id },
    });

    // Use cap: the second open is the last.
    await f.dr.api.links.open(anonymous, {
      tenantId: TENANT,
      token: link.token,
      password: 'correct horse battery',
      email: 'x@y.test',
    });
    await expect(
      f.dr.api.links.open(anonymous, {
        tenantId: TENANT,
        token: link.token,
        password: 'correct horse battery',
        email: 'x@y.test',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('stops serving when the link is disabled, links are turned off, or the room closes', async () => {
    const { f, room, folder, inner } = await setup();
    await f.dr.api.links.configure(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      enabled: true,
    });
    const link = await f.dr.api.links.create(as('alice'), {
      tenantId: TENANT,
      nodeId: folder.id,
      capabilities: ['VIEW'],
    });
    const opened = await f.dr.api.links.open({}, { tenantId: TENANT, token: link.token });
    await expect(
      f.dr.api.links.download(
        {},
        { tenantId: TENANT, session: opened.session, nodeId: inner.id, variant: 'original' },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await f.dr.api.rooms.close(as('alice'), { tenantId: TENANT, roomId: room.id });
    await expect(
      f.dr.api.links.browse({}, { tenantId: TENANT, session: opened.session }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await f.dr.api.rooms.reopen(as('alice'), { tenantId: TENANT, roomId: room.id });
    await expect(
      f.dr.api.links.browse({}, { tenantId: TENANT, session: opened.session }),
    ).resolves.toBeDefined();

    await f.dr.api.links.disable(as('alice'), { tenantId: TENANT, linkId: link.id });
    await expect(
      f.dr.api.links.browse({}, { tenantId: TENANT, session: opened.session }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(
      f.dr.api.links.open({}, { tenantId: TENANT, token: link.token }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const second = await f.dr.api.links.create(as('alice'), {
      tenantId: TENANT,
      nodeId: folder.id,
      capabilities: ['VIEW'],
      expiresInDays: 1,
    });
    f.clock.current += 2 * 86_400_000;
    await expect(
      f.dr.api.links.open({}, { tenantId: TENANT, token: second.token }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('works over HTTP without credentials', async () => {
    const { f, room, folder } = await setup();
    await f.dr.api.links.configure(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      enabled: true,
    });
    const link = await f.dr.api.links.create(as('alice'), {
      tenantId: TENANT,
      nodeId: folder.id,
      capabilities: ['VIEW'],
    });
    const response = await f.dr.handler(
      new Request('http://app.test/api/better-files/links/open', {
        method: 'POST',
        headers: { 'x-better-files': '1', 'content-type': 'application/json' },
        body: JSON.stringify({ tenantId: TENANT, token: link.token }),
      }),
    );
    expect(response.status).toBe(200);
  });
});
