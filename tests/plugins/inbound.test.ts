import { describe, expect, it } from 'vitest';
import { deliverEmail, fromPostmark, inboundPlugin } from '@better-files/plugin-inbound';
import { as, fixture, TENANT } from '../fixtures.js';

const options = {
  domain: 'in.acme.test',
  deliverySecret: 'an-inbound-delivery-secret-of-32-chars!',
};

const postmark = (to: string, from: string, authenticated = true) => ({
  ToFull: [{ Email: to }, { Email: 'someone@elsewhere.test' }],
  FromFull: { Email: from },
  Subject: 'Q3 financials',
  Headers: [
    {
      Name: 'Authentication-Results',
      Value: authenticated ? 'mx; dkim=pass header.d=seller.test' : 'mx; dkim=fail',
    },
  ],
  Attachments: [
    {
      Name: 'q3.pdf',
      ContentType: 'application/pdf',
      Content: Buffer.from('%PDF-1.7 q3').toString('base64'),
    },
    {
      Name: '../../etc/passwd',
      ContentType: 'text/plain',
      Content: Buffer.from('nope').toString('base64'),
    },
  ],
});

async function setup() {
  const f = await fixture({ plugins: [inboundPlugin(options)] });
  const room = await f.room();
  const legal = await f.dr.api.folders.create(as('alice'), {
    tenantId: TENANT,
    parentId: room.rootNodeId,
    name: 'Legal',
  });
  const address = await f.dr.api.inbound.createAddress(as('alice'), {
    tenantId: TENANT,
    nodeId: legal.id,
    label: 'Seller filings',
    allowedSenders: ['@seller.test'],
  });
  return { f, room, legal, address };
}

describe('email to a data room', () => {
  it('files attachments from allowed, authenticated senders into the folder', async () => {
    const { f, room, legal, address } = await setup();
    expect(address.address).toMatch(
      new RegExp(`^room\\+${TENANT}\\.[A-Za-z0-9_-]{24}@in\\.acme\\.test$`),
    );
    const [outcome] = await deliverEmail(
      f.dr,
      options,
      fromPostmark(postmark(address.address, 'sam@seller.test')),
    );
    expect(outcome).toMatchObject({
      to: address.address,
      filed: [{ filename: 'q3.pdf' }, { filename: '.._.._etc_passwd' }],
    });

    const index = await f.dr.api.rooms.index(as('alice'), { tenantId: TENANT, roomId: room.id });
    expect(
      index
        .filter((node) => node.parentId === legal.id)
        .map((node) => node.name)
        .sort(),
    ).toEqual(['.._.._etc_passwd', 'q3.pdf']);
    const q3 = index.find((node) => node.name === 'q3.pdf')!;
    const [version] = await f.dr.api.versions.list(as('alice'), {
      tenantId: TENANT,
      nodeId: q3.id,
    });
    expect(version).toMatchObject({
      uploadedBy: 'alice',
      comment: 'By email from sam@seller.test: Q3 financials',
      mimeType: 'application/pdf',
    });
    const activity = await f.dr.api.activity.list(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
    });
    expect(activity.find((record) => record.action === 'inbound.received')).toMatchObject({
      metadata: { files: 2 },
    });
  });

  it('refuses spoofed, unauthorized, revoked and unsigned deliveries', async () => {
    const { f, legal, address } = await setup();
    await expect(
      deliverEmail(f.dr, options, fromPostmark(postmark(address.address, 'eve@attacker.test'))),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'The sender is not allowed for this address',
    });
    await expect(
      deliverEmail(
        f.dr,
        options,
        fromPostmark(postmark(address.address, 'sam@seller.test', false)),
      ),
    ).rejects.toMatchObject({
      message: 'The message failed sender authentication',
    });
    await expect(
      deliverEmail(
        f.dr,
        { ...options, deliverySecret: 'x'.repeat(40) },
        fromPostmark(postmark(address.address, 'sam@seller.test')),
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(
      await deliverEmail(
        f.dr,
        options,
        fromPostmark(postmark('other@in.acme.test', 'sam@seller.test')),
      ),
    ).toEqual([]);

    await f.dr.api.inbound.revoke(as('alice'), { tenantId: TENANT, addressId: address.id });
    await expect(
      deliverEmail(f.dr, options, fromPostmark(postmark(address.address, 'sam@seller.test'))),
    ).rejects.toMatchObject({
      message: 'Unknown or expired drop address',
    });

    // Creating an address needs upload access to the folder.
    const team = await f.dr.api.groups.create(as('alice'), {
      tenantId: TENANT,
      roomId: legal.roomId,
      name: 'Buyers',
      preset: 'view',
    });
    await f.dr.api.members.invite(as('alice'), {
      tenantId: TENANT,
      roomId: legal.roomId,
      email: 'bob@acme.test',
      groupIds: [team.id],
    });
    await expect(
      f.dr.api.inbound.createAddress(as('bob'), { tenantId: TENANT, nodeId: legal.id }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
