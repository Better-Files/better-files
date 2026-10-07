import { describe, expect, it } from 'vitest';
import { as, fixture, TENANT } from '../fixtures.js';

async function dealRoom() {
  const f = await fixture();
  const room = await f.room();
  const root = room.rootNodeId;
  const finance = await f.dr.api.folders.create(as('alice'), {
    tenantId: TENANT,
    parentId: root,
    name: 'Finance',
  });
  const hr = await f.dr.api.folders.create(as('alice'), {
    tenantId: TENANT,
    parentId: root,
    name: 'HR',
  });
  const model = await f.upload('alice', {
    parentId: finance.id,
    filename: 'model.xlsx',
    content: f.bytes(500),
  });
  const payroll = await f.upload('alice', {
    parentId: hr.id,
    filename: 'payroll.csv',
    content: f.bytes(300),
  });
  const buyers = await f.dr.api.groups.create(as('alice'), {
    tenantId: TENANT,
    roomId: room.id,
    name: 'Buyer A',
    kind: 'external',
    preset: 'view',
  });
  return { f, room, finance, hr, model: model.document, payroll: payroll.document, buyers };
}

describe('members, groups and the permission matrix', () => {
  it('invites people into groups and applies the matrix to what they see and do', async () => {
    const { f, room, hr, model, payroll, buyers } = await dealRoom();
    expect(buyers).toMatchObject({
      name: 'Buyer A',
      relation: 'viewer',
      kind: 'external',
      memberCount: 0,
    });
    const member = await f.dr.api.members.invite(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      email: 'BOB@acme.test',
      groupIds: [buyers.id],
    });
    expect(member).toMatchObject({
      identityId: 'bob',
      email: 'bob@acme.test',
      status: 'active',
      groupIds: [buyers.id],
    });

    // Bob now sees the room, the index and the documents, with view-only capabilities.
    expect((await f.dr.api.rooms.list(as('bob'), { tenantId: TENANT })).map((r) => r.id)).toEqual([
      room.id,
    ]);
    const index = await f.dr.api.rooms.index(as('bob'), { tenantId: TENANT, roomId: room.id });
    expect(index.map((n) => n.name)).toEqual(['Finance', 'model.xlsx', 'HR', 'payroll.csv']);
    expect(index.find((n) => n.name === 'model.xlsx')?.capabilities).toEqual(['LIST', 'VIEW']);
    await expect(
      f.dr.api.documents.requestOriginal(as('bob'), { tenantId: TENANT, nodeId: model.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Hide HR from the buyers and grant them originals of the financial model.
    await f.dr.api.permissions.setEntries(as('alice'), {
      tenantId: TENANT,
      nodeId: hr.id,
      entries: [{ subject: { type: 'group', id: buyers.id }, preset: 'hidden' }],
    });
    await f.dr.api.permissions.setEntries(as('alice'), {
      tenantId: TENANT,
      nodeId: model.id,
      entries: [{ subject: { type: 'group', id: buyers.id }, preset: 'downloadOriginal' }],
    });
    expect(
      (await f.dr.api.rooms.index(as('bob'), { tenantId: TENANT, roomId: room.id })).map(
        (n) => n.name,
      ),
    ).toEqual(['Finance', 'model.xlsx']);
    await expect(
      f.dr.api.documents.get(as('bob'), { tenantId: TENANT, nodeId: payroll.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const ticket = await f.dr.api.documents.requestOriginal(as('bob'), {
      tenantId: TENANT,
      nodeId: model.id,
    });
    expect((await f.download(ticket.url)).body.byteLength).toBe(500);

    // Viewers cannot manage permissions, and managers cannot grant beyond what they hold.
    await expect(
      f.dr.api.permissions.setEntries(as('bob'), {
        tenantId: TENANT,
        nodeId: model.id,
        entries: [{ subject: { type: 'identity', id: 'bob' }, preset: 'manager' }],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const explained = await f.dr.api.permissions.explain(as('alice'), {
      tenantId: TENANT,
      nodeId: model.id,
      identityId: 'bob',
    });
    expect(explained.path.map((step) => step.matrix)).toEqual([
      ['LIST', 'VIEW'],
      ['LIST', 'VIEW'],
      ['LIST', 'VIEW', 'PRINT', 'COPY_TEXT', 'DOWNLOAD_WATERMARKED', 'DOWNLOAD_ORIGINAL'],
    ]);
    expect(explained.groups).toEqual([{ iamGroupId: buyers.iamGroupId, group: 'Buyer A' }]);

    const matrix = await f.dr.api.permissions.getMatrix(as('alice'), {
      tenantId: TENANT,
      nodeId: room.rootNodeId,
    });
    expect(matrix.entries).toHaveLength(3);
    expect(matrix.presets.view).toEqual(['LIST', 'VIEW']);

    const activity = await f.dr.api.activity.list(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      limit: 5,
    });
    expect(activity[0]).toMatchObject({ action: 'document.downloaded', actorId: 'bob' });
  });

  it('closes rooms to downloads and document flags clamp capabilities', async () => {
    const { f, room, model, buyers } = await dealRoom();
    await f.dr.api.members.invite(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      email: 'bob@acme.test',
      groupIds: [buyers.id],
    });
    await f.dr.api.permissions.setEntries(as('alice'), {
      tenantId: TENANT,
      nodeId: room.rootNodeId,
      entries: [{ subject: { type: 'group', id: buyers.id }, preset: 'download' }],
    });
    const caps = () =>
      f.dr.capabilitiesFor(as('bob'), { tenantId: TENANT, roomId: room.id, nodeIds: [model.id] });
    expect((await caps())[model.id]).toContain('DOWNLOAD_WATERMARKED');
    await f.dr.api.documents.setFlags(as('alice'), {
      tenantId: TENANT,
      nodeId: model.id,
      flags: { viewOnly: true },
    });
    expect((await caps())[model.id]).toEqual(['LIST', 'VIEW']);
    await f.dr.api.documents.setFlags(as('alice'), {
      tenantId: TENANT,
      nodeId: model.id,
      flags: { viewOnly: false },
    });
    await f.dr.api.rooms.update(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      settings: { downloadsEnabled: false },
    });
    expect((await caps())[model.id]).toEqual(['LIST', 'VIEW', 'PRINT']);
  });

  it('requires MFA for downloads when the room says so', async () => {
    const { f, room, model } = await dealRoom();
    await f.dr.api.rooms.update(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      settings: { requireMfaForDownload: true },
    });
    await expect(
      f.dr.api.documents.requestOriginal(as('alice'), { tenantId: TENANT, nodeId: model.id }),
    ).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
    f.principals.alice = { ...f.principals.alice!, mfa: true };
    await expect(
      f.dr.api.documents.requestOriginal(as('alice'), { tenantId: TENANT, nodeId: model.id }),
    ).resolves.toBeDefined();
  });

  it('invites outsiders as guests who claim the invitation when they first sign in', async () => {
    const { f, room, buyers } = await dealRoom();
    await expect(
      f.dr.api.members.invite(as('alice'), {
        tenantId: TENANT,
        roomId: room.id,
        email: 'gina@partner.test',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const invited = await f.dr.api.members.invite(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      email: 'gina@partner.test',
      groupIds: [buyers.id],
      accessDays: 30,
      message: 'Welcome to the data room',
    });
    expect(invited).toMatchObject({ status: 'invited', guest: true, email: 'gina@partner.test' });
    expect(f.iam.state.invitations).toEqual([
      expect.objectContaining({
        email: 'gina@partner.test',
        groupIds: [buyers.iamGroupId],
        sponsorId: 'alice',
      }),
    ]);
    await expect(
      f.dr.api.members.invite(as('alice'), {
        tenantId: TENANT,
        roomId: room.id,
        email: 'gina@partner.test',
        groupIds: [buyers.id],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // Removing an invitation nobody accepted withdraws it in the identity system.
    const hank = await f.dr.api.members.invite(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      email: 'hank@partner.test',
      groupIds: [buyers.id],
    });
    await f.dr.api.members.remove(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      memberId: hank.id,
    });
    expect(f.iam.state.invitations.find((i) => i.email === 'hank@partner.test')).toMatchObject({
      revoked: true,
    });
    expect(f.iam.state.invitations.find((i) => i.email === 'gina@partner.test')?.revoked).toBe(
      undefined,
    );

    // Redemption happens in the identity system: gina now exists and belongs to the group.
    f.principals.gina = { id: 'gina', tenantId: TENANT, email: 'gina@partner.test', guest: true };
    f.iam.state.groups.get(buyers.iamGroupId)!.members.set('gina', undefined);
    expect((await f.dr.api.rooms.list(as('gina'), { tenantId: TENANT })).map((r) => r.id)).toEqual([
      room.id,
    ]);
    const members = await f.dr.api.members.list(as('alice'), { tenantId: TENANT, roomId: room.id });
    expect(members.find((m) => m.email === 'gina@partner.test')).toMatchObject({
      identityId: 'gina',
      status: 'active',
    });
  });

  it('changes roles, suspends and removes members, and keeps an owner', async () => {
    const { f, room } = await dealRoom();
    const carol = await f.dr.api.members.invite(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      email: 'carol@acme.test',
    });
    expect(carol.relation).toBe('viewer');
    // Only room administrators may hand out roles; carol is a viewer.
    await expect(
      f.dr.api.members.invite(as('carol'), {
        tenantId: TENANT,
        roomId: room.id,
        email: 'dave@acme.test',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await f.dr.api.members.setRole(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      memberId: carol.id,
      relation: 'admin',
    });
    const members = await f.dr.api.members.invite(as('carol'), {
      tenantId: TENANT,
      roomId: room.id,
      email: 'dave@acme.test',
    });
    expect(members).toMatchObject({ identityId: 'dave', relation: 'viewer' });
    // Admins cannot make owners; only owners can.
    await expect(
      f.dr.api.members.setRole(as('carol'), {
        tenantId: TENANT,
        roomId: room.id,
        memberId: members.id,
        relation: 'owner',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await f.dr.api.members.suspend(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      memberId: carol.id,
    });
    await expect(
      f.dr.api.rooms.get(as('carol'), { tenantId: TENANT, roomId: room.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await f.dr.api.members.resume(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      memberId: carol.id,
    });
    expect(
      (await f.dr.api.rooms.get(as('carol'), { tenantId: TENANT, roomId: room.id })).capabilities,
    ).toContain('MANAGE');

    const owner = (
      await f.dr.api.members.list(as('alice'), { tenantId: TENANT, roomId: room.id })
    ).find((m) => m.relation === 'owner')!;
    await expect(
      f.dr.api.members.remove(as('alice'), {
        tenantId: TENANT,
        roomId: room.id,
        memberId: owner.id,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await f.dr.api.members.remove(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      memberId: carol.id,
    });
    await expect(
      f.dr.api.rooms.get(as('carol'), { tenantId: TENANT, roomId: room.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('manages group membership and deletes groups with their grants', async () => {
    const { f, room, buyers } = await dealRoom();
    await f.dr.api.groups.addMembers(as('alice'), {
      tenantId: TENANT,
      groupId: buyers.id,
      identityIds: ['bob', 'dave'],
    });
    let groups = await f.dr.api.groups.list(as('alice'), { tenantId: TENANT, roomId: room.id });
    expect(groups).toEqual([expect.objectContaining({ id: buyers.id, memberCount: 2 })]);
    await f.dr.api.groups.removeMembers(as('alice'), {
      tenantId: TENANT,
      groupId: buyers.id,
      identityIds: ['dave'],
    });
    expect(await f.dr.api.rooms.list(as('dave'), { tenantId: TENANT })).toEqual([]);
    await f.dr.api.groups.update(as('alice'), {
      tenantId: TENANT,
      groupId: buyers.id,
      name: 'Buyer Alpha',
      relation: 'contributor',
    });
    await expect(
      f.dr.api.groups.create(as('alice'), {
        tenantId: TENANT,
        roomId: room.id,
        name: 'buyer alpha',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await f.dr.api.groups.delete(as('alice'), { tenantId: TENANT, groupId: buyers.id });
    groups = await f.dr.api.groups.list(as('alice'), { tenantId: TENANT, roomId: room.id });
    expect(groups).toEqual([]);
    expect(await f.database.count('aclEntries')).toBe(0);
    expect(await f.dr.api.rooms.list(as('bob'), { tenantId: TENANT })).toEqual([]);
  });
});
