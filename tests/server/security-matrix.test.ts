import { describe, expect, it } from 'vitest';
import {
  coreAccessModel,
  isBetterFilesError,
  operationMatrix,
  roomRelations,
  type CoreOperation,
  type BetterFilesErrorCode,
  type RoomRelation,
} from '@better-files/core';
import { as, fixture, TENANT } from '../fixtures.js';

/**
 * Security matrix (PLAN §16, §17 "Security"): every core operation, tried by every kind of caller that must not
 * reach the room — another tenant, a same-tenant stranger, a removed member — and by every room relation, checked
 * against the access model. A new operation fails the coverage test until it gets a case here.
 */

/** A room with something for every operation to point at. */
async function world() {
  const f = await fixture();
  const room = await f.room('Project Falcon');
  await f.dr.api.rooms.publish(as('alice'), { tenantId: TENANT, roomId: room.id });
  const call = { tenantId: TENANT };
  const finance = await f.dr.api.folders.create(as('alice'), {
    ...call,
    parentId: room.rootNodeId,
    name: 'Finance',
  });
  const spare = await f.dr.api.folders.create(as('alice'), {
    ...call,
    parentId: room.rootNodeId,
    name: 'Spare',
  });
  const old = await f.dr.api.folders.create(as('alice'), {
    ...call,
    parentId: room.rootNodeId,
    name: 'Old',
  });
  await f.dr.api.folders.delete(as('alice'), { ...call, nodeId: old.id });
  const first = await f.upload('alice', {
    parentId: finance.id,
    filename: 'model.xlsx',
    content: f.bytes(200),
  });
  await f.upload('alice', {
    documentId: first.document.id,
    filename: 'model.xlsx',
    content: f.bytes(220, 2),
  });
  const gone = await f.upload('alice', {
    parentId: finance.id,
    filename: 'draft.pdf',
    content: f.bytes(50, 3),
  });
  await f.dr.api.documents.delete(as('alice'), { ...call, nodeId: gone.document.id });
  const buyers = await f.dr.api.groups.create(as('alice'), {
    ...call,
    roomId: room.id,
    name: 'Buyers',
    kind: 'external',
    preset: 'view',
  });
  const bob = await f.dr.api.members.invite(as('alice'), {
    ...call,
    roomId: room.id,
    email: 'bob@acme.test',
    groupIds: [buyers.id],
  });
  // A suspended member, for `members.resume`.
  f.principals.erin = { id: 'erin', tenantId: TENANT, name: 'Erin', email: 'erin@acme.test' };
  const erin = await f.dr.api.members.invite(as('alice'), {
    ...call,
    roomId: room.id,
    email: 'erin@acme.test',
  });
  await f.dr.api.members.suspend(as('alice'), { ...call, roomId: room.id, memberId: erin.id });
  // An upload whose content arrived but which nobody completed yet.
  const pending = await f.dr.api.uploads.create(as('alice'), {
    ...call,
    parentId: finance.id,
    filename: 'later.pdf',
    size: 10,
  });
  await f.dr.files.upload(as('alice'), {
    ...call,
    uploadId: pending.uploadId,
    body: f.bytes(10, 4),
  });
  return {
    f,
    room,
    finance,
    spare,
    old,
    document: first.document,
    firstVersion: first.version,
    deleted: gone.document,
    buyers,
    bob,
    erin,
    uploadId: pending.uploadId,
  };
}
type World = Awaited<ReturnType<typeof world>>;

/** Inputs (without `tenantId`) that the room owner may legitimately send for each operation. */
const cases: Record<CoreOperation, (w: World) => Record<string, unknown>> = {
  'rooms.create': () => ({ name: 'Intruder room' }),
  'rooms.list': () => ({}),
  'rooms.get': (w) => ({ roomId: w.room.id }),
  'rooms.index': (w) => ({ roomId: w.room.id }),
  'rooms.update': (w) => ({ roomId: w.room.id, description: 'changed' }),
  'rooms.publish': (w) => ({ roomId: w.room.id }),
  'rooms.close': (w) => ({ roomId: w.room.id }),
  'rooms.reopen': (w) => ({ roomId: w.room.id }),
  'rooms.archive': (w) => ({ roomId: w.room.id }),
  'rooms.delete': (w) => ({ roomId: w.room.id, confirmName: w.room.name }),
  'rooms.trash': (w) => ({ roomId: w.room.id }),
  'rooms.export': (w) => ({ roomId: w.room.id }),

  'folders.create': (w) => ({ parentId: w.finance.id, name: 'Sub' }),
  'folders.list': (w) => ({ nodeId: w.finance.id }),
  'folders.rename': (w) => ({ nodeId: w.spare.id, name: 'Renamed' }),
  'folders.move': (w) => ({ nodeId: w.spare.id, destinationId: w.finance.id }),
  'folders.delete': (w) => ({ nodeId: w.spare.id }),
  'folders.restore': (w) => ({ nodeId: w.old.id }),
  'folders.requestDownload': (w) => ({ nodeId: w.finance.id }),

  'documents.get': (w) => ({ nodeId: w.document.id }),
  'documents.rename': (w) => ({ nodeId: w.document.id, name: 'renamed.xlsx' }),
  'documents.move': (w) => ({ nodeId: w.document.id, destinationId: w.spare.id }),
  'documents.delete': (w) => ({ nodeId: w.document.id }),
  'documents.restore': (w) => ({ nodeId: w.deleted.id }),
  'documents.setFlags': (w) => ({ nodeId: w.document.id, flags: { noPrint: true } }),
  'documents.requestView': (w) => ({ nodeId: w.document.id }),
  'documents.requestDownload': (w) => ({ nodeId: w.document.id }),
  'documents.requestOriginal': (w) => ({ nodeId: w.document.id }),

  'versions.list': (w) => ({ nodeId: w.document.id }),
  'versions.restore': (w) => ({ nodeId: w.document.id, versionId: w.firstVersion.id }),

  'uploads.create': (w) => ({ parentId: w.finance.id, filename: 'new.pdf', size: 10 }),
  'uploads.complete': (w) => ({ uploadId: w.uploadId }),
  'uploads.abort': (w) => ({ uploadId: w.uploadId }),

  'members.list': (w) => ({ roomId: w.room.id }),
  'members.invite': (w) => ({ roomId: w.room.id, email: 'carol@acme.test' }),
  'members.inviteMany': (w) => ({
    roomId: w.room.id,
    invitations: [{ email: 'carol@acme.test' }],
  }),
  'members.remove': (w) => ({ roomId: w.room.id, memberId: w.bob.id }),
  'members.setRole': (w) => ({ roomId: w.room.id, memberId: w.bob.id, relation: 'editor' }),
  'members.suspend': (w) => ({ roomId: w.room.id, memberId: w.bob.id }),
  'members.resume': (w) => ({ roomId: w.room.id, memberId: w.erin.id }),

  'groups.list': (w) => ({ roomId: w.room.id }),
  'groups.create': (w) => ({ roomId: w.room.id, name: 'Sneaky' }),
  'groups.update': (w) => ({ groupId: w.buyers.id, name: 'Renamed group' }),
  'groups.delete': (w) => ({ groupId: w.buyers.id }),
  'groups.addMembers': (w) => ({ groupId: w.buyers.id, identityIds: ['dave'] }),
  'groups.removeMembers': (w) => ({ groupId: w.buyers.id, identityIds: ['bob'] }),

  'permissions.getMatrix': (w) => ({ nodeId: w.room.rootNodeId }),
  'permissions.setEntries': (w) => ({
    nodeId: w.finance.id,
    entries: [{ subject: { type: 'identity', id: 'dave' }, preset: 'manager' }],
  }),
  'permissions.explain': (w) => ({ nodeId: w.document.id, identityId: 'bob' }),
  'permissions.capabilities': (w) => ({ roomId: w.room.id, nodeIds: [w.document.id] }),

  'activity.list': (w) => ({ roomId: w.room.id }),
  'activity.verify': (w) => ({ roomId: w.room.id }),
};

const operations = Object.keys(operationMatrix) as CoreOperation[];

type Outcome = { ok: true; value: unknown } | { ok: false; code: BetterFilesErrorCode | 'THROWN' };

async function attempt(
  w: World,
  operation: CoreOperation,
  who: string,
  tenantId = TENANT,
): Promise<Outcome> {
  const [group, method] = operation.split('.') as [string, string];
  const api = w.f.dr.api as unknown as Record<
    string,
    Record<string, (credential: unknown, input: unknown) => Promise<unknown>>
  >;
  try {
    const value = await api[group]![method]!(as(who), { tenantId, ...cases[operation](w) });
    return { ok: true, value };
  } catch (error) {
    if (isBetterFilesError(error)) return { ok: false, code: error.code };
    return { ok: false, code: 'THROWN' };
  }
}

/** What a refused caller may learn: that they are not allowed, or that the thing does not exist for them. */
const refusals: readonly string[] = ['FORBIDDEN', 'NOT_FOUND', 'UNAUTHENTICATED'];

/** Everything about the world an attacker must not change. */
async function snapshot(w: World) {
  const { database } = w.f;
  const tables = [
    'rooms',
    'nodes',
    'documents',
    'versions',
    'members',
    'permissionGroups',
    'aclEntries',
    'uploads',
  ];
  const counts = Object.fromEntries(
    await Promise.all(tables.map(async (table) => [table, await database.count(table)] as const)),
  );
  const verified = await w.f.dr.verifyActivity({ tenantId: TENANT, roomId: w.room.id });
  return {
    counts,
    activity: verified.records,
    relationships: w.f.iam.state.relationships.size,
    room: await database.findOne('rooms', { id: w.room.id, tenantId: TENANT }),
    nodes: await database.findMany('nodes', { where: { tenantId: TENANT } }),
    documents: await database.findMany('documents', { where: { tenantId: TENANT } }),
    members: await database.findMany('members', { where: { tenantId: TENANT } }),
    groups: await database.findMany('permissionGroups', { where: { tenantId: TENANT } }),
  };
}

const allowedByModel = (relation: RoomRelation, action: string) =>
  coreAccessModel.some(
    (grant) => grant.actions.includes(action) && grant.relations.includes(relation),
  );

describe('security matrix', () => {
  it('has a case for every core operation', () => {
    expect(Object.keys(cases).sort()).toEqual([...operations].sort());
  });

  it('lets the room owner send every case (so refusals below are about access, not bad input)', async () => {
    const failures: string[] = [];
    for (const operation of operations) {
      const w = await world();
      const outcome = await attempt(w, operation, 'alice');
      // Business rules may still refuse (publishing a live room, deleting one that is not archived).
      if (!outcome.ok && outcome.code !== 'CONFLICT')
        failures.push(`${operation}: ${outcome.code}`);
    }
    expect(failures).toEqual([]);
  });

  const attackers = [
    { name: 'a user of another tenant naming this tenant', who: 'mallory', tenantId: TENANT },
    { name: 'a user of another tenant replaying ids in their own', who: 'mallory', tenantId: 't2' },
    { name: 'a same-tenant user who is not a member', who: 'dave', tenantId: TENANT },
  ];

  for (const attacker of attackers)
    it(`refuses ${attacker.name} on every operation, without changing or leaking anything`, async () => {
      const w = await world();
      const before = await snapshot(w);
      for (const operation of operations) {
        const outcome = await attempt(w, operation, attacker.who, attacker.tenantId);
        if (outcome.ok) {
          // Only listing may answer, and then with nothing from this room.
          expect(operation).toBe('rooms.list');
          expect(JSON.stringify(outcome.value)).not.toContain(w.room.id);
        } else expect([operation, refusals.includes(outcome.code)]).toEqual([operation, true]);
      }
      expect(await snapshot(w)).toEqual(before);
    });

  it('refuses a member once removed, and a suspended member, on every room operation', async () => {
    for (const state of ['removed', 'suspended'] as const) {
      const w = await world();
      await w.f.dr.api.members[state === 'removed' ? 'remove' : 'suspend'](as('alice'), {
        tenantId: TENANT,
        roomId: w.room.id,
        memberId: w.bob.id,
      });
      const before = await snapshot(w);
      for (const operation of operations) {
        const outcome = await attempt(w, operation, 'bob');
        if (outcome.ok) {
          expect([state, operation]).toEqual([state, 'rooms.list']);
          expect(JSON.stringify(outcome.value)).not.toContain(w.room.id);
        } else
          expect([state, operation, refusals.includes(outcome.code)]).toEqual([
            state,
            operation,
            true,
          ]);
      }
      expect(await snapshot(w)).toEqual(before);
    }
  });

  it('freezes closed rooms: only lifecycle operations change them, even for the owner', async () => {
    const w = await world();
    await w.f.dr.api.rooms.close(as('alice'), { tenantId: TENANT, roomId: w.room.id });
    const before = await snapshot(w);
    const failures: string[] = [];
    for (const operation of operations) {
      const spec: { mutates: boolean; allowClosed?: boolean; target: string } =
        operationMatrix[operation];
      if (!spec.mutates || spec.allowClosed || spec.target === 'tenant') continue;
      const outcome = await attempt(w, operation, 'alice');
      if (outcome.ok || outcome.code !== 'ROOM_CLOSED')
        failures.push(`${operation}: ${outcome.ok ? 'allowed' : outcome.code}`);
    }
    expect(failures).toEqual([]);
    expect(await snapshot(w)).toEqual(before);
  });

  it('gives each room relation exactly the room operations the access model grants', async () => {
    const roomOperations = operations.filter((op) => operationMatrix[op].target === 'room');
    const nodeOperations = operations.filter((op) => operationMatrix[op].target === 'node');
    const failures: string[] = [];
    for (const relation of roomRelations) {
      if (relation === 'owner') continue; // alice, the creator
      const shared = await world();
      await shared.f.dr.api.members.invite(as('alice'), {
        tenantId: TENANT,
        roomId: shared.room.id,
        email: 'carol@acme.test',
        relation,
      });
      for (const operation of [...roomOperations, ...nodeOperations]) {
        const { action, target } = operationMatrix[operation];
        if (allowedByModel(relation, action)) {
          // Layer B allows it. Room operations then run; node operations still depend on the matrix (layer A).
          if (target !== 'room') continue;
          const w = await world();
          await w.f.dr.api.members.invite(as('alice'), {
            tenantId: TENANT,
            roomId: w.room.id,
            email: 'carol@acme.test',
            relation,
          });
          const outcome = await attempt(w, operation, 'carol');
          if (!outcome.ok && outcome.code !== 'CONFLICT')
            failures.push(`${relation} ${operation}: refused (${outcome.code})`);
        } else {
          const outcome = await attempt(shared, operation, 'carol');
          if (outcome.ok) failures.push(`${relation} ${operation}: allowed`);
          else if (!refusals.includes(outcome.code))
            failures.push(`${relation} ${operation}: ${outcome.code}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
