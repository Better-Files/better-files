import {
  Capability,
  coreActions,
  prefixedId,
  BetterFilesError,
  defineTable,
  definePlugin,
  endpoint,
  field,
  notFound,
  v,
  type Member,
  type PluginContext,
  type Room,
} from '@better-files/core';

export interface NdaVersion {
  id: string;
  tenantId: string;
  roomId: string;
  version: number;
  title: string;
  text: string;
  /** `everyone`, or only guests from outside the organization (`external`). */
  appliesTo: 'everyone' | 'external';
  active: boolean;
  createdBy: string;
  createdAt: number;
}

export interface NdaAcceptance {
  id: string;
  tenantId: string;
  roomId: string;
  version: number;
  identityId: string;
  name?: string;
  email?: string;
  ip?: string;
  userAgent?: string;
  textSha256: string;
  createdAt: number;
}

const EXEMPT_RELATIONS = new Set(['owner', 'admin']);
const CORE_ACTIONS = new Set(coreActions);
/** Until the NDA is accepted, only the index shows: names, no content. */
const GATED = ~Capability.LIST;

async function sha256(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function currentNda(context: Pick<PluginContext, 'db' | 'tenantId'>, roomId: string) {
  const [latest] = await context.db.findMany<NdaVersion>('ndaVersions', {
    where: { tenantId: context.tenantId, roomId },
    orderBy: [{ field: 'version', direction: 'desc' }],
    limit: 1,
  });
  return latest?.active ? latest : undefined;
}

// One lookup per request context: the clamp hook runs once per node of a listing.
const pendingCache = new WeakMap<object, Promise<NdaVersion | undefined>>();

/** Whether this principal must accept the room's current NDA and has not. */
function pendingNda(context: PluginContext, room: Room): Promise<NdaVersion | undefined> {
  let pending = pendingCache.get(context);
  if (!pending) {
    pending = lookupPending(context, room);
    pendingCache.set(context, pending);
  }
  return pending;
}

async function lookupPending(context: PluginContext, room: Room): Promise<NdaVersion | undefined> {
  const nda = await currentNda(context, room.id);
  if (!nda) return undefined;
  const member = await context.db.findOne<Member>('members', {
    tenantId: context.tenantId,
    roomId: room.id,
    identityId: context.principal.id,
  });
  if (member?.relation && EXEMPT_RELATIONS.has(member.relation)) return undefined;
  if (nda.appliesTo === 'external' && !context.principal.guest) return undefined;
  const accepted = await context.db.findOne<NdaAcceptance>('ndaAcceptances', {
    tenantId: context.tenantId,
    roomId: room.id,
    identityId: context.principal.id,
    version: nda.version,
  });
  return accepted ? undefined : nda;
}

const roomTarget = (input: { roomId: string }) => ({ roomId: input.roomId });

/**
 * Per-room non-disclosure agreements. While a participant has not accepted the current version, the room shows them
 * its index only: every capability but LIST is withheld. Room owners and administrators are exempt. Publishing a new
 * version asks everyone to accept again. Acceptances are hash-bound to the text they accepted.
 */
export function ndaPlugin() {
  return definePlugin({
    id: 'nda',
    actions: ['better-files:nda:manage', 'better-files:nda:accept'],
    accessModel: [
      { relations: ['owner', 'admin'], actions: ['better-files:nda:manage'] },
      {
        relations: ['owner', 'admin', 'publisher', 'editor', 'contributor', 'viewer', 'auditor'],
        actions: ['better-files:nda:accept'],
      },
    ],
    schema: {
      ndaVersions: defineTable({
        fields: {
          roomId: field.string(),
          version: field.number(),
          title: field.string(),
          text: field.string(),
          appliesTo: field.enum(['everyone', 'external'] as const),
          active: field.boolean(),
          createdBy: field.string(),
        },
        indexes: [{ fields: ['tenantId', 'roomId', 'version'], unique: true }],
      }),
      ndaAcceptances: defineTable({
        fields: {
          roomId: field.string(),
          version: field.number(),
          identityId: field.string(),
          name: field.string({ required: false }),
          email: field.string({ required: false }),
          ip: field.string({ required: false }),
          userAgent: field.string({ required: false }),
          textSha256: field.string(),
        },
        indexes: [{ fields: ['tenantId', 'roomId', 'identityId', 'version'], unique: true }],
      }),
    },
    hooks: {
      async clampCapabilities({ context, room }) {
        const nda = await pendingNda(context, room);
        return nda
          ? [{ remove: GATED, reason: `the NDA "${nda.title}" has not been accepted` }]
          : [];
      },
      /**
       * Plugin room features (Q&A answers, room-wide notes, tasks, AI) are room content too: closed until the NDA is
       * accepted. Core room operations stay open (the room, its index, membership), as does this plugin's own.
       */
      async gateRoom({ context, room, operation }) {
        if (CORE_ACTIONS.has(operation.action) || operation.action.startsWith('better-files:nda:'))
          return undefined;
        const nda = await pendingNda(context, room);
        return nda ? `Accept the NDA "${nda.title}" first` : undefined;
      },
    },
    endpoints: {
      /** Publishes a new NDA version (or turns the NDA off with `active: false`). */
      publish: endpoint({
        operation: { action: 'better-files:nda:manage', target: 'room', mutates: true },
        input: v.object({
          roomId: v.id(),
          title: v.optional(v.string({ min: 1, max: 200 })),
          text: v.optional(v.string({ min: 1, max: 100_000 })),
          appliesTo: v.optional(v.enum(['everyone', 'external'] as const)),
          active: v.optional(v.boolean()),
        }),
        target: roomTarget,
        async handler(context, input) {
          const room = context.room!;
          const previous = await context.db.findMany<NdaVersion>('ndaVersions', {
            where: { tenantId: context.tenantId, roomId: room.id },
            orderBy: [{ field: 'version', direction: 'desc' }],
            limit: 1,
          });
          const last = previous[0];
          const active = input.active ?? true;
          if (active && !(input.text ?? last?.text))
            throw new BetterFilesError('INVALID_INPUT', 'The first NDA needs a text');
          const nda: NdaVersion = {
            id: prefixedId('nda', context.now),
            tenantId: context.tenantId,
            roomId: room.id,
            version: (last?.version ?? 0) + 1,
            title: input.title ?? last?.title ?? 'Non-disclosure agreement',
            text: input.text ?? last?.text ?? '',
            appliesTo: input.appliesTo ?? last?.appliesTo ?? 'everyone',
            active,
            createdBy: context.principal.id,
            createdAt: context.now,
          };
          await context.db.insert('ndaVersions', nda);
          await context.activity({
            roomId: room.id,
            action: active ? 'nda.published' : 'nda.disabled',
            metadata: { version: nda.version, title: nda.title, appliesTo: nda.appliesTo },
          });
          context.emit(active ? 'nda.published' : 'nda.disabled', {
            roomId: room.id,
            version: nda.version,
          });
          return nda;
        },
      }),
      /** The room's current NDA for the caller, and whether they still have to accept it. */
      get: endpoint({
        operation: {
          action: 'better-files:nda:accept',
          target: 'room',
          mutates: false,
          allowClosed: true,
        },
        input: v.object({ roomId: v.id() }),
        target: roomTarget,
        async handler(context) {
          const room = context.room!;
          const nda = await currentNda(context, room.id);
          if (!nda) return { nda: null, required: false };
          return { nda, required: (await pendingNda(context, room)) !== undefined };
        },
      }),
      accept: endpoint({
        operation: {
          action: 'better-files:nda:accept',
          target: 'room',
          mutates: false,
          allowClosed: true,
        },
        input: v.object({ roomId: v.id(), version: v.number({ int: true, min: 1 }) }),
        target: roomTarget,
        async handler(context, input) {
          const room = context.room!;
          const nda = await currentNda(context, room.id);
          if (!nda) throw notFound('NDA');
          if (nda.version !== input.version)
            throw new BetterFilesError(
              'CONFLICT',
              'A newer version of the NDA has been published; review it first',
            );
          const existing = await context.db.findOne<NdaAcceptance>('ndaAcceptances', {
            tenantId: context.tenantId,
            roomId: room.id,
            identityId: context.principal.id,
            version: nda.version,
          });
          if (existing) return existing;
          const acceptance: NdaAcceptance = {
            id: prefixedId('ndaacc', context.now),
            tenantId: context.tenantId,
            roomId: room.id,
            version: nda.version,
            identityId: context.principal.id,
            ...(context.principal.name ? { name: context.principal.name } : {}),
            ...(context.principal.email ? { email: context.principal.email } : {}),
            ...(context.request?.ip ? { ip: context.request.ip } : {}),
            ...(context.request?.userAgent
              ? { userAgent: context.request.userAgent.slice(0, 512) }
              : {}),
            textSha256: await sha256(nda.text),
            createdAt: context.now,
          };
          await context.db.transaction(async (tx) => {
            await tx.insert('ndaAcceptances', acceptance);
          });
          await context.activity({
            roomId: room.id,
            action: 'nda.accepted',
            metadata: { version: nda.version },
          });
          context.emit('nda.accepted', {
            roomId: room.id,
            version: nda.version,
            identityId: context.principal.id,
          });
          return acceptance;
        },
      }),
      acceptances: endpoint({
        operation: {
          action: 'better-files:nda:manage',
          target: 'room',
          mutates: false,
          allowClosed: true,
        },
        input: v.object({ roomId: v.id(), version: v.optional(v.number({ int: true, min: 1 })) }),
        target: roomTarget,
        async handler(context, input) {
          return context.db.findMany<NdaAcceptance>('ndaAcceptances', {
            where: {
              tenantId: context.tenantId,
              roomId: context.room!.id,
              ...(input.version ? { version: input.version } : {}),
            },
            orderBy: [{ field: 'createdAt' }],
          });
        },
      }),
    },
  });
}
