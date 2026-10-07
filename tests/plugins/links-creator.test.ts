import { describe, expect, it } from 'vitest';
import { linksPlugin } from '@better-files/plugin-links';
import { as, fixture, TENANT } from '../fixtures.js';

// A link carries at most what its creator holds, checked when it is used and not only when it is made: items the
// creator cannot see stay out of a shared folder, and narrowing or removing the creator narrows or stops the link.

async function setup() {
  const f = await fixture({ plugins: [linksPlugin({ requiredCapability: 'DOWNLOAD_ORIGINAL' })] });
  const room = await f.room();
  const buyers = await f.dr.api.groups.create(as('alice'), {
    tenantId: TENANT,
    roomId: room.id,
    name: 'Buyers',
    preset: 'downloadOriginal',
  });
  await f.dr.api.members.invite(as('alice'), {
    tenantId: TENANT,
    roomId: room.id,
    email: 'bob@acme.test',
    groupIds: [buyers.id],
  });
  const folder = await f.dr.api.folders.create(as('alice'), {
    tenantId: TENANT,
    parentId: room.rootNodeId,
    name: 'Shared',
  });
  const teaser = await f.upload('alice', {
    parentId: folder.id,
    filename: 'teaser.pdf',
    content: f.bytes(300, 9),
  });
  const secret = await f.upload('alice', {
    parentId: folder.id,
    filename: 'secret.pdf',
    content: f.bytes(200, 3),
  });
  await f.dr.api.permissions.setEntries(as('alice'), {
    tenantId: TENANT,
    nodeId: secret.document.id,
    entries: [{ subject: { type: 'group', id: buyers.id }, preset: 'hidden' }],
  });
  await f.dr.api.rooms.publish(as('alice'), { tenantId: TENANT, roomId: room.id });
  await f.dr.api.links.configure(as('alice'), { tenantId: TENANT, roomId: room.id, enabled: true });
  const link = await f.dr.api.links.create(as('bob'), {
    tenantId: TENANT,
    nodeId: folder.id,
    capabilities: ['VIEW', 'DOWNLOAD_ORIGINAL'],
  });
  const opened = await f.dr.api.links.open({}, { tenantId: TENANT, token: link.token });
  return {
    f,
    room,
    buyers,
    folder,
    teaser: teaser.document,
    secret: secret.document,
    link,
    session: opened.session,
  };
}

describe('share links follow their creator', () => {
  it('leaves out what the creator cannot see', async () => {
    const { f, session, teaser, secret } = await setup();
    const listing = await f.dr.api.links.browse({}, { tenantId: TENANT, session });
    expect(listing.items.map((item) => item.name)).toEqual(['teaser.pdf']);
    await expect(
      f.dr.api.links.download(
        {},
        { tenantId: TENANT, session, nodeId: secret.id, variant: 'original' },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      f.dr.api.links.browse({}, { tenantId: TENANT, session, nodeId: secret.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const ticket = await f.dr.api.links.download(
      {},
      { tenantId: TENANT, session, nodeId: teaser.id, variant: 'original' },
    );
    expect((await f.download(ticket.url)).body.byteLength).toBe(300);
  });

  it('narrows when the creator is narrowed', async () => {
    const { f, session, teaser, folder, buyers } = await setup();
    await f.dr.api.permissions.setEntries(as('alice'), {
      tenantId: TENANT,
      nodeId: folder.id,
      entries: [{ subject: { type: 'group', id: buyers.id }, preset: 'view' }],
    });
    await expect(
      f.dr.api.links.download(
        {},
        { tenantId: TENANT, session, nodeId: teaser.id, variant: 'original' },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      f.dr.api.links.download(
        {},
        { tenantId: TENANT, session, nodeId: teaser.id, variant: 'view' },
      ),
    ).resolves.toBeDefined();
  });

  it('stops when the creator leaves the room', async () => {
    const { f, room, link, session } = await setup();
    const members = await f.dr.api.members.list(as('alice'), { tenantId: TENANT, roomId: room.id });
    const bob = members.find((member) => member.email === 'bob@acme.test')!;
    await f.dr.api.members.remove(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      memberId: bob.id,
    });
    await expect(f.dr.api.links.browse({}, { tenantId: TENANT, session })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      f.dr.api.links.open({}, { tenantId: TENANT, token: link.token }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('keeps links made by room administrators whole', async () => {
    const { f, folder, secret } = await setup();
    const link = await f.dr.api.links.create(as('alice'), {
      tenantId: TENANT,
      nodeId: folder.id,
      capabilities: ['VIEW'],
    });
    const { session } = await f.dr.api.links.open({}, { tenantId: TENANT, token: link.token });
    const listing = await f.dr.api.links.browse({}, { tenantId: TENANT, session });
    expect(listing.items.map((item) => item.name).sort()).toEqual(['secret.pdf', 'teaser.pdf']);
    await expect(
      f.dr.api.links.download(
        {},
        { tenantId: TENANT, session, nodeId: secret.id, variant: 'view' },
      ),
    ).resolves.toBeDefined();
  });
});
