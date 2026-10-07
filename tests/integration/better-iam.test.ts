import { afterEach, describe, expect, it } from 'vitest';
import { betterIam } from 'better-iam';
import { sqliteAdapter as iamSqlite } from 'better-iam/adapter-sqlite';
import type { AuditEvent } from 'better-iam/core';
import { betterFiles } from '@better-files/server';
import {
  accessModelPolicy,
  betterIamFeatures,
  betterIamIntegration,
  betterFilesIamPlugin,
  PARTICIPANT_ROLE_NAME,
  systemPolicy,
} from '@better-files/iam';
import { sqliteAdapter } from '@better-files/adapter-sqlite';
import { memoryStorage } from '@better-files/testing';
import { jsonRequest } from '../helpers.js';
import { closeStores, fixture, probePlugin } from './iam-fixture.js';

/** Guests arrived after better-iam 0.2.0 (the npm release); CI also runs against Better IAM's main branch. */
type GuestApi = {
  redeem(input: {
    tenantId: string;
    token: string;
    name: string;
    password: string;
  }): Promise<{ token: string } | { mfaRequired: true }>;
};

afterEach(closeStores);

// What the installed Better IAM release offers (npm 0.2.0, or Better IAM's main branch in the compatibility job).
const features = betterIamFeatures(
  betterIam({
    database: iamSqlite({ filename: ':memory:' }),
    secret: 'test-secret-with-at-least-32-characters',
    baseURL: 'http://localhost:3000',
  }),
);

const bytes = (text: string) => new TextEncoder().encode(text);

async function upload(
  f: Awaited<ReturnType<typeof fixture>>,
  credential: { token: string },
  parentId: string,
  name: string,
  content: Uint8Array,
) {
  const session = await f.dr.api.uploads.create(credential, {
    tenantId: f.tenantId,
    parentId,
    filename: name,
    size: content.byteLength,
  });
  await f.dr.files.upload(credential, {
    tenantId: f.tenantId,
    uploadId: session.uploadId,
    body: content,
  });
  return f.dr.api.uploads.complete(credential, {
    tenantId: f.tenantId,
    uploadId: session.uploadId,
  });
}

describe('Better IAM integration', () => {
  it('registers the Better Files catalog and refuses unregistered plugin actions', async () => {
    const plugin = betterFilesIamPlugin({ plugins: [probePlugin] });
    expect(plugin.actions).toContain('better-files:probe:read');
    expect(Object.keys(plugin.resourceTypes!)).toEqual([
      'better-files-room',
      'better-files-folder',
      'better-files-document',
    ]);
    expect(accessModelPolicy().statements.length).toBeGreaterThan(10);
    const iamPlugin = betterFilesIamPlugin();
    expect(() =>
      betterFiles({
        iam: betterIamIntegration({} as never, { iamPlugin }),
        database: sqliteAdapter({ filename: ':memory:' }),
        storage: memoryStorage(),
        secret: 'a-better-files-secret-with-more-than-32-characters',
        encryption: false,
        plugins: [probePlugin],
      }),
    ).toThrow(/better-files:probe:read/);
  });

  it('authenticates Better IAM sessions with their tenant and groups', async () => {
    const f = await fixture();
    const who = await f.dr.api.probe.whoami(f.owner, { tenantId: f.tenantId });
    expect(who).toMatchObject({ tenantId: f.tenantId, kind: 'user', guest: false, groups: [] });
    const group = await f.iam.api.groups.create(f.owner, { tenantId: f.tenantId, name: 'Staff' });
    await f.iam.api.groups.addMember(f.owner, {
      tenantId: f.tenantId,
      groupId: group.id,
      identityId: who.id,
    });
    await expect(f.dr.api.probe.whoami(f.owner, { tenantId: f.tenantId })).resolves.toMatchObject({
      groups: [group.id],
    });
    await expect(
      f.dr.api.probe.whoami(f.owner, { tenantId: f.rootTenantId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      f.dr.api.probe.whoami({ token: 'biam_not_a_token' }, { tenantId: f.tenantId }),
    ).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('runs a data room end to end on Better IAM: rooms, groups, policies, KMS encryption and audit', async () => {
    const f = await fixture();
    const room = await f.dr.api.rooms.create(f.owner, {
      tenantId: f.tenantId,
      name: 'Project Falcon',
    });
    // The room is a registered Better IAM resource, owned by its creator through a relationship tuple.
    const resource = await f.iam.api.resources.get(f.owner, {
      tenantId: f.tenantId,
      type: 'better-files-room',
      id: room.id,
    });
    expect(resource).toMatchObject({ resourceId: room.id, attributes: { status: 'draft' } });
    const roles = await f.iam.api.roles.list(f.owner, { tenantId: f.tenantId });
    expect(roles.map((role) => role.name)).toContain(PARTICIPANT_ROLE_NAME);

    const finance = await f.dr.api.folders.create(f.owner, {
      tenantId: f.tenantId,
      parentId: room.rootNodeId,
      name: 'Finance',
    });
    const { document } = await upload(
      f,
      f.owner,
      finance.id,
      'model.xlsx',
      bytes('confidential numbers'),
    );

    // Files are encrypted with a Better IAM KMS key created for the room.
    const ticket = await f.dr.api.documents.requestOriginal(f.owner, {
      tenantId: f.tenantId,
      nodeId: document.id,
    });
    const served = await f.dr.files.serve(ticket.url.split('/files/')[1]!);
    expect(await served.text()).toBe('confidential numbers');

    // A member joins a permission group with view access; Better IAM policies (the participant role bound to the
    // group, conditioned on the group's `viewer` relation) let them in, the matrix limits them to viewing.
    const dana = await f.member('dana');
    const buyers = await f.dr.api.groups.create(f.owner, {
      tenantId: f.tenantId,
      roomId: room.id,
      name: 'Buyers',
      preset: 'view',
    });
    await f.dr.api.members.invite(f.owner, {
      tenantId: f.tenantId,
      roomId: room.id,
      email: 'dana@acme.test',
      groupIds: [buyers.id],
    });
    expect(
      (await f.dr.api.rooms.list(dana.credential, { tenantId: f.tenantId })).map((r) => r.id),
    ).toEqual([room.id]);
    const index = await f.dr.api.rooms.index(dana.credential, {
      tenantId: f.tenantId,
      roomId: room.id,
    });
    expect(index.map((n) => [n.index, n.name, n.capabilities])).toEqual([
      ['1', 'Finance', ['LIST', 'VIEW']],
      ['1.1', 'model.xlsx', ['LIST', 'VIEW']],
    ]);
    await expect(
      f.dr.api.probe.read(dana.credential, { tenantId: f.tenantId, nodeId: document.id }),
    ).resolves.toEqual({ read: document.id });
    await expect(
      f.dr.api.documents.requestOriginal(dana.credential, {
        tenantId: f.tenantId,
        nodeId: document.id,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      f.dr.api.folders.create(dana.credential, {
        tenantId: f.tenantId,
        parentId: finance.id,
        name: 'Mine',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await f.dr.api.permissions.setEntries(f.owner, {
      tenantId: f.tenantId,
      nodeId: document.id,
      entries: [{ subject: { type: 'group', id: buyers.id }, preset: 'downloadOriginal' }],
    });
    const danaTicket = await f.dr.api.documents.requestOriginal(dana.credential, {
      tenantId: f.tenantId,
      nodeId: document.id,
    });
    expect(await (await f.dr.files.serve(danaTicket.url.split('/files/')[1]!)).text()).toBe(
      'confidential numbers',
    );

    // Someone outside the room sees nothing, whatever the matrix says.
    const erin = await f.member('erin');
    expect(await f.dr.api.rooms.list(erin.credential, { tenantId: f.tenantId })).toEqual([]);
    await expect(
      f.dr.api.rooms.index(erin.credential, { tenantId: f.tenantId, roomId: room.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Security events are in Better IAM's tamper-evident audit chain.
    const audit = await f.store.find<AuditEvent>('audit', { tenantId: f.tenantId });
    const actions = audit.map((event) => event.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'better-files:room.created',
        'better-files:documents:download-original',
        'better-files:permissions.changed',
      ]),
    );
    expect(
      audit.find(
        (event) =>
          event.action === 'better-files:documents:download-original' && event.actorId === dana.id,
      ),
    ).toBeDefined();

    // Removing the member takes them out of the Better IAM group, and with it out of the room.
    const members = await f.dr.api.members.list(f.owner, { tenantId: f.tenantId, roomId: room.id });
    await f.dr.api.members.remove(f.owner, {
      tenantId: f.tenantId,
      roomId: room.id,
      memberId: members.find((m) => m.identityId === dana.id)!.id,
    });
    expect(await f.dr.api.rooms.list(dana.credential, { tenantId: f.tenantId })).toEqual([]);
  });

  it.runIf(features.guests)(
    'invites people from outside the organization as Better IAM guests',
    async () => {
      const f = await fixture();
      const room = await f.dr.api.rooms.create(f.owner, {
        tenantId: f.tenantId,
        name: 'Diligence',
      });
      const buyers = await f.dr.api.groups.create(f.owner, {
        tenantId: f.tenantId,
        roomId: room.id,
        name: 'Buyer B',
        kind: 'external',
        preset: 'view',
      });
      const invited = await f.dr.api.members.invite(f.owner, {
        tenantId: f.tenantId,
        roomId: room.id,
        email: 'gina@partner.test',
        groupIds: [buyers.id],
        accessDays: 30,
      });
      expect(invited).toMatchObject({ status: 'invited', guest: true });
      await f.iam.auth.dispatchOutbox();
      const email = f.inbox.find((m) => m.template === 'guest-invitation')!;
      const guests = (f.iam.api as unknown as { guests: GuestApi }).guests;
      const redeemed = await guests.redeem({
        tenantId: f.tenantId,
        token: email.payload.token!,
        name: 'Gina',
        password: 'a strong guest password',
      });
      if (!('token' in redeemed)) throw new Error('Unexpected MFA');
      const gina = { token: redeemed.token };
      expect((await f.dr.api.rooms.list(gina, { tenantId: f.tenantId })).map((r) => r.id)).toEqual([
        room.id,
      ]);
      const members = await f.dr.api.members.list(f.owner, {
        tenantId: f.tenantId,
        roomId: room.id,
      });
      expect(members.find((m) => m.email === 'gina@partner.test')).toMatchObject({
        status: 'active',
        guest: true,
      });
    },
  );

  it.runIf(!features.guests)(
    'reports outsider invitations as unsupported until the host opts in',
    async () => {
      const f = await fixture();
      const room = await f.dr.api.rooms.create(f.owner, {
        tenantId: f.tenantId,
        name: 'Diligence',
      });
      const buyers = await f.dr.api.groups.create(f.owner, {
        tenantId: f.tenantId,
        roomId: room.id,
        name: 'Buyer B',
        kind: 'external',
        preset: 'view',
      });
      await expect(
        f.dr.api.members.invite(f.owner, {
          tenantId: f.tenantId,
          roomId: room.id,
          email: 'gina@partner.test',
          groupIds: [buyers.id],
        }),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED', message: /externalInvites/ });
    },
  );

  it("invites outsiders as tenant members with externalInvites: 'members', and they stay guests", async () => {
    const f = await fixture({ integration: { externalInvites: 'members' } });
    const room = await f.dr.api.rooms.create(f.owner, { tenantId: f.tenantId, name: 'Diligence' });
    const buyers = await f.dr.api.groups.create(f.owner, {
      tenantId: f.tenantId,
      roomId: room.id,
      name: 'Buyer B',
      kind: 'external',
      preset: 'view',
    });
    const invite = (email: string) =>
      f.dr.api.members.invite(f.owner, {
        tenantId: f.tenantId,
        roomId: room.id,
        email,
        groupIds: [buyers.id],
        accessDays: 30,
      });
    expect(await invite('gina@partner.test')).toMatchObject({ status: 'invited', guest: true });
    await f.iam.auth.dispatchOutbox();
    const email = f.inbox.find(
      (m) => m.template === 'member-invitation' && m.to === 'gina@partner.test',
    )!;
    const accepted = await f.iam.api.identities.acceptInvitation({
      tenantId: f.tenantId,
      token: email.payload.token!,
      name: 'Gina',
      password: 'a strong outsider password',
    });
    if (!('token' in accepted)) throw new Error('Unexpected MFA');
    const gina = { token: accepted.token };

    // The outsiders group keeps her a guest for Better Files (NDA "external" gating, audit reports).
    expect(await f.dr.api.probe.whoami(gina, { tenantId: f.tenantId })).toMatchObject({
      guest: true,
    });
    expect((await f.dr.api.rooms.list(gina, { tenantId: f.tenantId })).map((r) => r.id)).toEqual([
      room.id,
    ]);
    const members = await f.dr.api.members.list(f.owner, { tenantId: f.tenantId, roomId: room.id });
    expect(members.find((m) => m.email === 'gina@partner.test')).toMatchObject({
      status: 'active',
      guest: true,
    });

    // Removing someone who has not accepted yet withdraws the invitation: the link no longer gets them in.
    const hank = await invite('hank@partner.test');
    await f.dr.api.members.remove(f.owner, {
      tenantId: f.tenantId,
      roomId: room.id,
      memberId: hank.id,
    });
    await f.iam.auth.dispatchOutbox();
    const hankEmail = f.inbox.find(
      (m) => m.template === 'member-invitation' && m.to === 'hank@partner.test',
    )!;
    await expect(
      f.iam.api.identities.acceptInvitation({
        tenantId: f.tenantId,
        token: hankEmail.payload.token!,
        name: 'Hank',
        password: 'a strong outsider password',
      }),
    ).rejects.toBeDefined();
  });

  it('builds a system policy this Better IAM release accepts', async () => {
    const f = await fixture();
    await expect(
      f.iam.api.roles.create(f.owner, {
        tenantId: f.tenantId,
        name: 'Better Files system',
        document: systemPolicy(f.iam),
      }),
    ).resolves.toMatchObject({ name: 'Better Files system' });
    // Releases without guests refuse a policy naming the guest actions.
    if (!features.guests)
      await expect(
        f.iam.api.roles.create(f.owner, {
          tenantId: f.tenantId,
          name: 'Better Files system (all actions)',
          document: systemPolicy(),
        }),
      ).rejects.toMatchObject({ code: 'INVALID_ACTION' });
  });

  it('serves the protocol through the fetch handler with Better IAM bearer tokens', async () => {
    const f = await fixture();
    const response = await f.dr.handler(
      jsonRequest(
        'http://localhost:3000/api/better-files/rooms/create',
        { tenantId: f.tenantId, name: 'Over HTTP' },
        {
          authorization: `Bearer ${f.owner.token}`,
        },
      ),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { data: { name: string } }).data.name).toBe('Over HTTP');
  });
});
