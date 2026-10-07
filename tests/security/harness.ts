/**
 * Shared harness for the security matrix suites: a room populated with one actor per room relation (plus a guest, a
 * non-member and an actor from another tenant), and an oracle derived from the published access model alone.
 */
import {
  coreAccessModel,
  type AccessGrant,
  type Credential,
  type BetterFilesPlugin,
  type OperationSpec,
  type RoomRelation,
} from '@better-files/core';
import { localKeyProvider } from '@better-files/crypto';
import { betterFiles } from '@better-files/server';
import {
  fakeIam,
  memoryDatabase,
  memoryStorage,
  relationDecider,
  type FakePrincipal,
} from '@better-files/testing';

export const T1 = 't1';
export const T2 = 't2';
const SECRET = 'a-test-secret-with-more-than-32-characters';

export interface Actor {
  token: string;
  /** The tenant the actor addresses (differs from their own for the crossing actor). */
  tenantId: string;
  relation?: RoomRelation;
  /** Matrix preset on the room's root folder (layer A); owners and admins sit on the admin floor instead. */
  preset?: string;
  guest?: boolean;
  /** Authenticated in t2, addressing t1's records. */
  crossing?: boolean;
}

export const actors: Actor[] = [
  { token: 'alice', tenantId: T1, relation: 'owner' },
  { token: 'adam', tenantId: T1, relation: 'admin' },
  { token: 'paula', tenantId: T1, relation: 'publisher', preset: 'manager' },
  { token: 'ed', tenantId: T1, relation: 'editor', preset: 'manager' },
  { token: 'cora', tenantId: T1, relation: 'contributor', preset: 'manager' },
  { token: 'vic', tenantId: T1, relation: 'viewer', preset: 'manager' },
  { token: 'audrey', tenantId: T1, relation: 'auditor', preset: 'manager' },
  // Layer A narrower than layer B: an editor who may only view.
  { token: 'evan', tenantId: T1, relation: 'editor', preset: 'view' },
  { token: 'gus', tenantId: T1, relation: 'viewer', preset: 'download', guest: true },
  { token: 'dave', tenantId: T1 },
  { token: 'mallory', tenantId: T2, crossing: true },
];

/** The crossing actor addressing t1 directly, with a t2 credential. */
export const malloryInT1: Actor = { token: 'mallory', tenantId: T1, crossing: true };

const principals: Record<string, FakePrincipal> = {
  ...Object.fromEntries(
    actors
      .filter((a) => !a.crossing)
      .map((a) => [
        a.token,
        {
          id: a.token,
          tenantId: T1,
          name: a.token,
          email: `${a.token}@acme.test`,
          ...(a.guest ? { guest: true } : {}),
        },
      ]),
  ),
  mallory: { id: 'mallory', tenantId: T2, name: 'Mallory', email: 'mallory@other.test' },
  // A suspended Buyers member.
  sam: { id: 'sam', tenantId: T1, name: 'Sam Suspended', email: 'sam@acme.test' },
  // Invited during operations, never a member beforehand.
  nina: { id: 'nina', tenantId: T1, name: 'Nina New', email: 'nina@acme.test' },
};

/** Tenant administrators: the room creator in each tenant. Everyone else may list rooms. */
export const tenantActions = (id: string) =>
  id === 'alice' || id === 'mallory' ? ['*'] : ['better-files:rooms:read'];

export const as = (token: string): Credential => ({ token });

export async function scenario(plugins: readonly BetterFilesPlugin[] = []) {
  const database = memoryDatabase();
  const model: AccessGrant[] = [...coreAccessModel, ...plugins.flatMap((p) => p.accessModel ?? [])];
  // eslint-disable-next-line prefer-const
  let dr: ReturnType<typeof make>;
  const iam = fakeIam({
    principals,
    decide: relationDecider(model, {
      tenantActions: (principal) => tenantActions(principal.id),
      roomOf: async (type, id) =>
        (await dr.resolveForIam({ tenantId: T1, type, id }).catch(() => undefined))?.attributes
          .roomId as string | undefined,
    }),
  });
  const make = () =>
    betterFiles({
      iam,
      database,
      storage: memoryStorage(),
      secret: SECRET,
      encryption: { keys: localKeyProvider({ secret: SECRET }) },
      plugins,
      clock: { now: () => Date.UTC(2026, 9, 3, 12) },
      logger: { warn() {}, error() {} },
    });
  dr = make();
  await dr.initialize();
  const alice = as('alice');
  const upload = async (input: { parentId?: string; documentId?: string; filename: string }) => {
    const content = new TextEncoder().encode(`content of ${input.filename}`);
    const session = await dr.api.uploads.create(alice, {
      tenantId: T1,
      ...input,
      size: content.byteLength,
    });
    await dr.files.upload(alice, { tenantId: T1, uploadId: session.uploadId, body: content });
    return dr.api.uploads.complete(alice, { tenantId: T1, uploadId: session.uploadId });
  };

  const room = await dr.api.rooms.create(alice, { tenantId: T1, name: 'Project Falcon' });
  await dr.api.rooms.publish(alice, { tenantId: T1, roomId: room.id });
  const folder = await dr.api.folders.create(alice, {
    tenantId: T1,
    parentId: room.rootNodeId,
    name: 'Finance',
  });
  const legal = await dr.api.folders.create(alice, {
    tenantId: T1,
    parentId: room.rootNodeId,
    name: 'Legal',
  });
  const old = await dr.api.folders.create(alice, {
    tenantId: T1,
    parentId: room.rootNodeId,
    name: 'Old',
  });
  const { document } = await upload({ parentId: folder.id, filename: 'model.xlsx' });
  await upload({ documentId: document.id, filename: 'model.xlsx' });
  const versions = await dr.api.versions.list(alice, { tenantId: T1, nodeId: document.id });
  const { document: stale } = await upload({ parentId: legal.id, filename: 'stale.txt' });
  await dr.api.folders.delete(alice, { tenantId: T1, nodeId: old.id });
  await dr.api.documents.delete(alice, { tenantId: T1, nodeId: stale.id });
  const pending = await dr.api.uploads.create(alice, {
    tenantId: T1,
    parentId: folder.id,
    filename: 'pending.txt',
    size: 10,
  });
  const group = await dr.api.groups.create(alice, {
    tenantId: T1,
    roomId: room.id,
    name: 'Buyers',
    preset: 'view',
  });

  for (const actor of actors) {
    if (!actor.relation || actor.relation === 'owner') continue;
    await dr.api.members.invite(alice, {
      tenantId: T1,
      roomId: room.id,
      email: `${actor.token}@acme.test`,
      relation: actor.relation,
    });
  }
  await dr.api.permissions.setEntries(alice, {
    tenantId: T1,
    nodeId: room.rootNodeId,
    entries: actors
      .filter((a) => a.preset)
      .map((a) => ({ subject: { type: 'identity' as const, id: a.token }, preset: a.preset! })),
  });
  const suspended = await dr.api.members.invite(alice, {
    tenantId: T1,
    roomId: room.id,
    email: 'sam@acme.test',
    groupIds: [group.id],
  });
  await dr.api.members.suspend(alice, { tenantId: T1, roomId: room.id, memberId: suspended.id });
  const members = await dr.api.members.list(alice, { tenantId: T1, roomId: room.id });
  const vicMember = members.find((m) => m.identityId === 'vic')!;
  // A t2 room, so the crossing actor is a real administrator somewhere.
  await dr.api.rooms.create(as('mallory'), { tenantId: T2, name: 'Mallory Holdings' });

  const ids = {
    roomId: room.id,
    roomName: room.name,
    rootId: room.rootNodeId,
    folderId: folder.id,
    legalId: legal.id,
    trashedFolderId: old.id,
    documentId: document.id,
    trashedDocumentId: stale.id,
    firstVersionId: versions.at(-1)!.id,
    uploadId: pending.uploadId,
    groupId: group.id,
    memberId: vicMember.id,
    suspendedMemberId: suspended.id,
  };
  return { dr, iam, database, ids, model };
}

export type Scenario = Awaited<ReturnType<typeof scenario>>;
export type Ids = Scenario['ids'];

/**
 * What the published model says, independently of the engine: tenant actions for tenant operations; otherwise a room
 * relation granting the action (layer B) and, on nodes, the capabilities in the actor's matrix mask (layer A).
 */
export function expectedAllowed(
  spec: OperationSpec,
  actor: Actor,
  context: {
    model: readonly AccessGrant[];
    mask(preset: string | undefined): number;
    required: number;
  },
): boolean {
  // Tenant operations in the crossing actor's own tenant are not a crossing.
  if (spec.target === 'tenant') {
    const actions = tenantActions(actor.token);
    return actions.includes('*') || actions.includes(spec.action);
  }
  if (spec.target === 'public') return true;
  if (actor.crossing) return false;
  const relation = actor.relation;
  if (!relation) return false;
  const holds = (action: string) =>
    context.model.some(
      (grant) => grant.relations.includes(relation) && grant.actions.includes(action),
    );
  if (!holds(spec.action)) return false;
  if (spec.target !== 'node') return true;
  const mask = holds('better-files:admin') ? ~0 : context.mask(actor.preset);
  return (mask & context.required) === context.required;
}

export type Outcome = { ok: true; value: unknown } | { ok: false; code: string; message: string };

export async function invoke(
  dr: Scenario['dr'],
  operation: string,
  actor: Actor,
  input: Record<string, unknown>,
): Promise<Outcome> {
  const [group, method] = operation.split('.') as [string, string];
  const api = (dr.api as unknown as Record<string, Record<string, Function> | undefined>)[group];
  if (!api?.[method]) throw new Error(`dr.api has no ${operation}`);
  try {
    return {
      ok: true,
      value: await api[method](as(actor.token), { tenantId: actor.tenantId, ...input }),
    };
  } catch (error) {
    const failure = error as { code?: string; message?: string };
    return { ok: false, code: failure.code ?? 'THROWN', message: failure.message ?? String(error) };
  }
}

/** Read-side bookkeeping a permitted read writes: the activity log, single-use tickets, events and jobs. */
const bookkeeping = new Set(['activity', 'tickets', 'outbox', 'jobs']);

/**
 * Every table plus the identity system's directory, for "a refusal changed nothing". `content` leaves out the
 * bookkeeping a permitted read writes (and the room's activity chain head), for "a read changed no content".
 */
export async function snapshot(context: Scenario, options: { content?: boolean } = {}) {
  const tables: Record<string, unknown[]> = {};
  for (const table of Object.keys(context.dr.schema.tables)) {
    if (options.content && bookkeeping.has(table)) continue;
    const rows = await context.database.findMany<Record<string, unknown>>(table);
    tables[table] =
      options.content && table === 'rooms'
        ? rows.map(({ activitySequence: _sequence, activityHash: _head, ...row }) => row)
        : rows;
  }
  const { rooms, relationships, groups, invitations } = context.iam.state;
  return JSON.stringify({
    tables,
    iam: {
      rooms: [...rooms],
      relationships: [...relationships],
      groups: [...groups].map(([id, g]) => [id, g.name, [...g.members]]),
      invitations,
    },
  });
}

export const DENIED = new Set(['FORBIDDEN', 'NOT_FOUND']);
/** A t2 credential addressing t1 may also fail authentication for that tenant. */
export const DENIED_CROSSING = new Set(['FORBIDDEN', 'NOT_FOUND', 'UNAUTHENTICATED']);
