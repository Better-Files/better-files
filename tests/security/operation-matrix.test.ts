/**
 * Security matrix fuzzing (PLAN §17): every core operation × room relations × a guest × a non-member × another tenant.
 *
 * The oracle (`expectedAllowed`) is derived from the published model alone: layer B is `coreAccessModel` (relation →
 * actions) plus the tenant actions; layer A is the permission-matrix preset each actor holds on the root folder, with
 * room administrators on the `better-files:admin` floor. For every pair the engine must agree with it:
 *
 * - denied: the call is refused with FORBIDDEN or NOT_FOUND (never another code that would leak state), and neither
 *   the database nor the identity-system directory changes;
 * - allowed: the call is not refused for authorization reasons (it may still fail on state, e.g. CONFLICT).
 *
 * A tenant crossing (`mallory`, tenant t2, addressing t1's records) must always look missing.
 *
 * tests/server/security-matrix.test.ts covers strangers, removed and suspended members and closed rooms; this suite
 * adds node operations under both layers (an editor whose matrix only allows viewing, the admin floor) and a guest.
 */
import { describe, expect, it } from 'vitest';
import { operationMatrix, type CoreOperation } from '@better-files/core';
import {
  actors,
  DENIED,
  DENIED_CROSSING,
  expectedAllowed,
  invoke,
  malloryInT1,
  scenario,
  snapshot,
  type Actor,
  type Ids,
  type Scenario,
} from './harness.js';

/** A valid input for every core operation. The suite fails when an operation is added without one. */
const inputs: Record<CoreOperation, (ids: Ids) => Record<string, unknown>> = {
  'rooms.create': () => ({ name: 'Another room' }),
  'rooms.list': () => ({}),
  'rooms.get': (i) => ({ roomId: i.roomId }),
  'rooms.index': (i) => ({ roomId: i.roomId }),
  'rooms.update': (i) => ({ roomId: i.roomId, name: 'Renamed' }),
  'rooms.publish': (i) => ({ roomId: i.roomId }),
  'rooms.close': (i) => ({ roomId: i.roomId }),
  'rooms.reopen': (i) => ({ roomId: i.roomId }),
  'rooms.archive': (i) => ({ roomId: i.roomId }),
  'rooms.delete': (i) => ({ roomId: i.roomId, confirmName: i.roomName }),
  'rooms.trash': (i) => ({ roomId: i.roomId }),
  'rooms.export': (i) => ({ roomId: i.roomId }),

  'folders.create': (i) => ({ parentId: i.folderId, name: 'New folder' }),
  'folders.list': (i) => ({ nodeId: i.folderId }),
  'folders.rename': (i) => ({ nodeId: i.legalId, name: 'Legal and compliance' }),
  'folders.move': (i) => ({ nodeId: i.legalId, destinationId: i.folderId }),
  'folders.delete': (i) => ({ nodeId: i.legalId }),
  'folders.restore': (i) => ({ nodeId: i.trashedFolderId }),
  'folders.requestDownload': (i) => ({ nodeId: i.folderId }),

  'documents.get': (i) => ({ nodeId: i.documentId }),
  'documents.rename': (i) => ({ nodeId: i.documentId, name: 'model-v2.xlsx' }),
  'documents.move': (i) => ({ nodeId: i.documentId, destinationId: i.legalId }),
  'documents.delete': (i) => ({ nodeId: i.documentId }),
  'documents.restore': (i) => ({ nodeId: i.trashedDocumentId }),
  'documents.setFlags': (i) => ({ nodeId: i.documentId, flags: { viewOnly: true } }),
  'documents.requestView': (i) => ({ nodeId: i.documentId }),
  'documents.requestDownload': (i) => ({ nodeId: i.documentId }),
  'documents.requestOriginal': (i) => ({ nodeId: i.documentId }),

  'versions.list': (i) => ({ nodeId: i.documentId }),
  'versions.restore': (i) => ({ nodeId: i.documentId, versionId: i.firstVersionId }),

  'uploads.create': (i) => ({ parentId: i.folderId, filename: 'new.txt', size: 3 }),
  'uploads.complete': (i) => ({ uploadId: i.uploadId }),
  'uploads.abort': (i) => ({ uploadId: i.uploadId }),

  'members.list': (i) => ({ roomId: i.roomId }),
  'members.invite': (i) => ({ roomId: i.roomId, email: 'nina@acme.test' }),
  'members.inviteMany': (i) => ({ roomId: i.roomId, invitations: [{ email: 'nina@acme.test' }] }),
  'members.remove': (i) => ({ roomId: i.roomId, memberId: i.memberId }),
  'members.setRole': (i) => ({ roomId: i.roomId, memberId: i.memberId, relation: 'editor' }),
  'members.suspend': (i) => ({ roomId: i.roomId, memberId: i.memberId }),
  'members.resume': (i) => ({ roomId: i.roomId, memberId: i.suspendedMemberId }),

  'groups.list': (i) => ({ roomId: i.roomId }),
  'groups.create': (i) => ({ roomId: i.roomId, name: 'Bidders' }),
  'groups.update': (i) => ({ groupId: i.groupId, name: 'Buyers (renamed)' }),
  'groups.delete': (i) => ({ groupId: i.groupId }),
  'groups.addMembers': (i) => ({ groupId: i.groupId, identityIds: ['vic'] }),
  'groups.removeMembers': (i) => ({ groupId: i.groupId, identityIds: ['vic'] }),

  'permissions.getMatrix': (i) => ({ nodeId: i.folderId }),
  'permissions.setEntries': (i) => ({
    nodeId: i.folderId,
    entries: [{ subject: { type: 'identity', id: 'dave' }, preset: 'view' }],
  }),
  'permissions.explain': (i) => ({ nodeId: i.documentId }),
  'permissions.capabilities': (i) => ({ roomId: i.roomId, nodeIds: [i.documentId] }),

  'activity.list': (i) => ({ roomId: i.roomId }),
  'activity.verify': (i) => ({ roomId: i.roomId }),
};

/** Upload sessions are private to whoever opened them (alice); anyone else finds no such upload. */
const creatorOnly = new Set<CoreOperation>(['uploads.complete', 'uploads.abort']);

function allowed(operation: CoreOperation, actor: Actor, context: Scenario) {
  if (creatorOnly.has(operation) && actor.token !== 'alice') return false;
  const spec = operationMatrix[operation];
  return expectedAllowed(spec, actor, {
    model: context.model,
    mask: (preset) => (preset ? context.dr.capabilities.preset(preset) : 0),
    required: context.dr.capabilities.mask(spec.capabilities ?? []),
  });
}

describe('security: core operation matrix × actors', () => {
  it('covers every core operation', () => {
    expect(Object.keys(inputs).sort()).toEqual(Object.keys(operationMatrix).sort());
  });

  it.each(Object.keys(operationMatrix) as CoreOperation[])(
    '%s agrees with the model',
    async (operation) => {
      const problems: string[] = [];
      // Refusals change nothing, so every denied actor shares one scenario.
      const shared = await scenario();
      const before = await snapshot(shared);
      const denied = actors.filter((actor) => !allowed(operation, actor, shared));
      for (const actor of [...denied, malloryInT1]) {
        const outcome = await invoke(shared.dr, operation, actor, inputs[operation](shared.ids));
        const acceptable = actor === malloryInT1 ? DENIED_CROSSING : DENIED;
        if (outcome.ok)
          problems.push(`${actor.token}@${actor.tenantId}: allowed, the model denies`);
        else if (!acceptable.has(outcome.code))
          problems.push(
            `${actor.token}@${actor.tenantId}: refused with ${outcome.code} (${outcome.message})`,
          );
        if ((await snapshot(shared)) !== before) {
          problems.push(`${actor.token}@${actor.tenantId}: a refused call changed state`);
          break;
        }
      }

      for (const actor of actors.filter((a) => !denied.includes(a))) {
        const context = await scenario();
        const outcome = await invoke(context.dr, operation, actor, inputs[operation](context.ids));
        if (!outcome.ok && DENIED_CROSSING.has(outcome.code))
          problems.push(
            `${actor.token}: refused with ${outcome.code} (${outcome.message}), the model allows`,
          );
      }
      expect(problems).toEqual([]);
    },
  );

  // Closed rooms, removed and suspended members: tests/server/security-matrix.test.ts.
});
