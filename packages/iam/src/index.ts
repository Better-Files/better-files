import { randomUUID } from 'node:crypto';
import type {
  AuditEvent,
  AuthenticatedPrincipal,
  CredentialInput,
  Decision,
  IamPlugin,
  IamStore,
  PolicyDocument,
  PolicyStatement,
  ResourceRef,
  StoredRecord,
} from 'better-iam/core';
import {
  coreAccessModel,
  coreActions,
  BetterFilesError,
  invalidConfig,
  resourceTypes,
  roomRelations,
  type AccessGrant,
  type AuthorizationCheck,
  type Credential,
  type BetterFilesPlugin,
  type IamDirectory,
  type IamIntegration,
  type KeyProvider,
  type Principal,
} from '@better-files/core';
import {
  bypassBetterFilesGuard,
  linkOf,
  OUTSIDERS_GROUP_NAME,
  PARTICIPANT_ROLE_NAME,
  pluginHooks,
  type HookOptions,
} from './hooks.js';

export {
  bypassBetterFilesGuard,
  outsiderBoundary,
  OUTSIDERS_GROUP_CONTEXT_KEY,
  OUTSIDERS_GROUP_NAME,
  PARTICIPANT_ROLE_NAME,
  type HookOptions,
} from './hooks.js';

export const IAM_PLUGIN_ID = 'better-files';

export interface BetterFilesIamPluginOptions extends HookOptions {
  /** The Better Files plugins given to `betterFiles()`, so their actions register too. */
  plugins?: readonly Pick<BetterFilesPlugin, 'id' | 'actions'>[];
}

/**
 * The Better IAM plugin. Register it on the host's `betterIam({ plugins })` so the Better Files actions and resource
 * types join the permission catalog. Pass the same Better Files plugins given to `betterFiles()` so their actions register,
 * and give the plugin to `betterIamIntegration(iam, { iamPlugin })` so the integration's cached role, group and key ids
 * follow Better IAM's audit events (`iam.events.dispatch()`).
 *
 * The plugin also guards the Better IAM records Better Files manages (see `guard`), and adds the tenant's outsiders group
 * to the policy context as `better-files.outsidersGroup`, which `outsiderBoundary()` statements use.
 */
export function betterFilesIamPlugin(options: BetterFilesIamPluginOptions = {}): IamPlugin {
  const actions = [
    ...new Set([
      ...coreActions,
      ...(options.plugins ?? []).flatMap((plugin) => plugin.actions ?? []),
    ]),
  ];
  const { attach, ...hooks } = pluginHooks(options);
  const plugin: IamPlugin = {
    id: IAM_PLUGIN_ID,
    ...hooks,
    actions,
    resourceTypes: {
      [resourceTypes.room]: {
        description: 'A data room',
        managed: true,
        relations: [...roomRelations],
        attributes: {
          status: 'string',
          classification: 'string',
          requireMfa: 'boolean',
          requireNda: 'boolean',
          downloadsEnabled: 'boolean',
        },
      },
      [resourceTypes.folder]: {
        description: 'A folder in a data room, resolved by Better Files',
        parent: resourceTypes.room,
        attributes: { roomId: 'string', roomStatus: 'string', classification: 'string' },
      },
      [resourceTypes.document]: {
        description: 'A document in a data room, resolved by Better Files',
        parent: resourceTypes.room,
        attributes: {
          roomId: 'string',
          roomStatus: 'string',
          classification: 'string',
          viewOnly: 'boolean',
        },
      },
    },
  };
  attach(plugin);
  return plugin;
}

/**
 * The role policy that turns room relations into Better Files actions: relations on `better-files-room/{id}` for room actions,
 * and the same relations reached through `resource.parentRelations` for folders and documents.
 */
export function accessModelPolicy(
  grants: readonly AccessGrant[] = coreAccessModel,
): PolicyDocument {
  const statements: PolicyStatement[] = [
    // Everyone holding the role may list rooms; the list is filtered room by room.
    {
      sid: 'BetterFilesList',
      effect: 'allow',
      actions: ['better-files:rooms:read'],
      resources: ['iam/*'],
    },
  ];
  grants.forEach((grant, index) => {
    if (grant.actions.length === 0 || grant.relations.length === 0) return;
    statements.push({
      sid: `BetterFilesRoom${index}`,
      effect: 'allow',
      actions: [...grant.actions],
      resources: [`${resourceTypes.room}/*`],
      conditions: { ArrayContains: { 'resource.relations': [...grant.relations] } },
    });
    statements.push({
      sid: `BetterFilesContent${index}`,
      effect: 'allow',
      actions: [...grant.actions],
      resources: [`${resourceTypes.folder}/*`, `${resourceTypes.document}/*`],
      conditions: { ArrayContains: { 'resource.parentRelations': [...grant.relations] } },
    });
  });
  return { version: 1, statements };
}

type Json = unknown;
/** Method-style signatures, so the real Better IAM API (with its richer input types) fits structurally. */
type Call<I, O> = {
  bivarianceHack(credential: CredentialInput, input: I): Promise<O>;
}['bivarianceHack'];

/** The part of a `betterIam()` instance Better Files uses. Structural, so any compatible 0.2.x or 0.3.x instance fits. */
export interface BetterIamInstance {
  authenticate(input: CredentialInput): Promise<AuthenticatedPrincipal>;
  authorize(
    request: CredentialInput & {
      tenantId: string;
      action: string;
      resource: { type: string; id: string };
    },
  ): Promise<Decision>;
  authorizeMany(
    request: CredentialInput & { tenantId: string; checks: AuthorizationCheck[] },
  ): Promise<{ results: { allowed: boolean; reason: string }[] }>;
  listAccessible?(
    request: CredentialInput & { tenantId: string; action: string; type: string; limit?: number },
  ): Promise<{ resources: { resourceId: string }[] }>;
  store: IamStore;
  protocolHost?: { recordAudit(tx: IamStore, event: AuditEvent): Promise<void> };
  api?: {
    resources?: {
      register: Call<
        {
          tenantId: string;
          type: string;
          id: string;
          attributes?: Record<string, Json>;
          ownerId?: string;
        },
        unknown
      >;
      update: Call<
        { tenantId: string; type: string; id: string; attributes?: Record<string, Json> },
        unknown
      >;
      delete: Call<{ tenantId: string; type: string; id: string }, unknown>;
    };
    relationships?: {
      create: Call<
        {
          tenantId: string;
          type: string;
          id: string;
          relation: string;
          subjectType: 'identity' | 'group';
          subjectId: string;
          expiresAt?: number;
        },
        {
          id: string;
          relation: string;
          subjectType: 'identity' | 'group';
          subjectId: string;
          expiresAt?: number;
        }
      >;
      delete: Call<{ tenantId: string; relationshipId: string }, unknown>;
      list: Call<
        { tenantId: string; type?: string; id?: string },
        {
          id: string;
          relation: string;
          subjectType: 'identity' | 'group';
          subjectId: string;
          expiresAt?: number;
        }[]
      >;
    };
    groups?: {
      create: Call<{ tenantId: string; name: string; description?: string }, { id: string }>;
      delete: Call<{ tenantId: string; groupId: string }, unknown>;
      addMember: Call<
        { tenantId: string; groupId: string; identityId: string; expiresAt?: number },
        unknown
      >;
      removeMember: Call<{ tenantId: string; groupId: string; identityId: string }, unknown>;
    };
    roles?: {
      create: Call<
        { tenantId: string; name: string; description?: string; document?: PolicyDocument },
        { id: string }
      >;
      list: Call<{ tenantId: string }, { id: string; name: string }[]>;
    };
    bindings?: {
      create: Call<
        { tenantId: string; roleId: string; subjectType: 'identity' | 'group'; subjectId: string },
        unknown
      >;
    };
    identities?: {
      list: Call<
        { tenantId: string; query?: string; limit?: number },
        { id: string; email?: string; name: string; guest?: unknown }[]
      >;
      /** Member invitations (better-iam 0.2 and later): groups are applied when the invitation is accepted. */
      invite?: Call<
        { tenantId: string; email: string; name?: string; groupIds?: string[] },
        { invitationId: string }
      >;
      revokeInvitation?: Call<{ tenantId: string; invitationId: string }, unknown>;
    };
    /** Guests (better-iam 0.3 and later). */
    guests?: {
      invite: Call<
        {
          tenantId: string;
          email: string;
          sponsorId?: string;
          message?: string;
          groupIds?: string[];
          accessDays?: number;
        },
        { id: string }
      >;
      revokeInvitation?: Call<{ tenantId: string; invitationId: string }, unknown>;
    };
    keys?: {
      create: Call<
        { tenantId: string; description?: string; tags?: Record<string, string>; alias?: string },
        { id: string }
      >;
      generateDataKey: Call<
        {
          tenantId: string;
          keyId: string;
          encryptionContext?: Record<string, string>;
          includePlaintext?: boolean;
        },
        { ciphertext: string; plaintextBase64?: string; keyId: string }
      >;
      decrypt: Call<
        {
          tenantId: string;
          ciphertext: string;
          encryptionContext?: Record<string, string>;
          keyId?: string;
        },
        { plaintextBase64?: string; plaintext?: string; keyId: string }
      >;
      scheduleDeletion: Call<{ tenantId: string; keyId: string; waitingDays?: number }, unknown>;
    };
  };
}

type GroupMemberRecord = StoredRecord & { groupId: string; expiresAt?: number };

/** Better IAM's IamError carries `code` and `status`; turn authentication failures into Better Files errors. */
function translate(error: unknown): unknown {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status: unknown }).status;
    const message = error instanceof Error ? error.message : 'Authentication failed';
    if (status === 401) return new BetterFilesError('UNAUTHENTICATED', message, { cause: error });
    if (status === 403) return new BetterFilesError('FORBIDDEN', message, { cause: error });
  }
  return error;
}

const codeOf = (error: unknown) => (error as { code?: unknown })?.code;
async function ignoring<T>(codes: string[], action: () => Promise<T>): Promise<T | undefined> {
  try {
    return await action();
  } catch (error) {
    if (codes.includes(String(codeOf(error)))) return undefined;
    throw error;
  }
}

const credentialInput = (credential: Credential): CredentialInput => ({
  ...(credential.headers === undefined ? {} : { headers: credential.headers }),
  ...(credential.token === undefined ? {} : { token: credential.token }),
});

export interface BetterIamIntegrationOptions {
  /** The `betterFilesIamPlugin()` registered on Better IAM; when given, `betterFiles()` checks every plugin action is in it. */
  iamPlugin?: IamPlugin;
  /**
   * The credential for identity-system writes (registering rooms, room roles, groups, guest invitations), used after
   * Better Files has authorized the caller. Typically a per-tenant service account whose role grants the `iam:*`
   * actions in `systemPolicy(iam)`. Without it, writes use the caller's own credential, which then needs those actions.
   */
  systemCredential?: (tenantId: string) => Credential | Promise<Credential>;
  /**
   * The access-model role (`Better Files participant`): `auto` (default) finds or creates it per tenant and binds it
   * to every subject given a room role; `manual` leaves roles and bindings to the host.
   */
  accessModel?: 'auto' | 'manual';
  /** Encrypt files with Better IAM's KMS: a key per room (default), per tenant, or `false` for none. */
  keys?: { perRoom?: boolean } | false;
  /** Record security events in Better IAM's audit chain. Default true. */
  audit?: boolean;
  /**
   * How people from outside the organization are invited. `guests` (the default when the instance has the guests
   * API) makes them Better IAM guests: sponsored, time-limited, inside the guest boundary. `members` sends a regular
   * member invitation into the tenant instead, for Better IAM releases without guests (0.2.x). Those people
   * become full tenant identities, so only choose it when your own roles give tenant members nothing by default.
   * Without guests and without this option, inviting an outsider reports UNSUPPORTED.
   */
  externalInvites?: 'guests' | 'members';
}

/** What a Better IAM instance offers Better Files; releases differ, and `betterIamIntegration` adapts to them. */
export interface BetterIamFeatures {
  /** Guests: sponsored, time-limited outside access (`api.guests`). */
  guests: boolean;
  /** Member invitations into the tenant (`api.identities.invite`), the fallback for outsiders. */
  memberInvitations: boolean;
  /** KMS envelope keys (`api.keys`), used to encrypt files with a key per room. */
  kms: boolean;
  /** The tamper-evident audit chain (`protocolHost.recordAudit`). */
  audit: boolean;
  /** `listAccessible`, so room lists are one query instead of a decision per room. */
  listAccessible: boolean;
}

export function betterIamFeatures(iam: BetterIamInstance): BetterIamFeatures {
  return {
    guests: typeof iam.api?.guests?.invite === 'function',
    memberInvitations: typeof iam.api?.identities?.invite === 'function',
    kms: typeof iam.api?.keys?.generateDataKey === 'function',
    audit: typeof iam.protocolHost?.recordAudit === 'function',
    listAccessible: typeof iam.listAccessible === 'function',
  };
}

/**
 * Connects Better Files to a Better IAM instance: authentication and groups, policy decisions, the directory (rooms,
 * roles, groups, guests), audit, and KMS-backed encryption.
 *
 * ```ts
 * export const dr = betterFiles({ iam: betterIamIntegration(iam, { iamPlugin, systemCredential }), database, storage, secret });
 * ```
 */
export function betterIamIntegration(
  iam: BetterIamInstance,
  options: BetterIamIntegrationOptions = {},
): IamIntegration {
  let grants: readonly AccessGrant[] = coreAccessModel;
  const api = () => {
    if (!iam.api) throw invalidConfig('The Better IAM instance has no api');
    return iam.api;
  };
  const group = <K extends keyof NonNullable<BetterIamInstance['api']>>(name: K) => {
    const found = api()[name];
    if (!found) throw invalidConfig(`The Better IAM instance has no ${String(name)} API`);
    return found as NonNullable<NonNullable<BetterIamInstance['api']>[K]>;
  };
  const system = async (tenantId: string, caller: Credential) =>
    credentialInput(options.systemCredential ? await options.systemCredential(tenantId) : caller);

  async function groupsOf(identityId: string, tenantId: string, now: number): Promise<string[]> {
    const memberships = await iam.store.find<GroupMemberRecord>('groupMembers', {
      tenantId,
      identityId,
    });
    return memberships
      .filter((membership) => membership.expiresAt === undefined || membership.expiresAt > now)
      .map((membership) => membership.groupId);
  }
  async function isOutsider(
    identityId: string,
    tenantId: string,
    now: number,
    groups?: readonly string[],
  ) {
    const outsiders = await outsiderGroup(tenantId);
    if (!outsiders) return false;
    return (groups ?? (await groupsOf(identityId, tenantId, now))).includes(outsiders);
  }

  // Without Better IAM guests, outsiders invited as tenant members also join this group, which is how they keep
  // authenticating as guests (and what host policies can single them out by).
  const outsiderGroups = new Map<string, Promise<string | undefined>>();
  function outsiderGroup(tenantId: string, create?: CredentialInput): Promise<string | undefined> {
    let found = outsiderGroups.get(tenantId);
    if (!found) {
      found = (async () => {
        const [existing] = await iam.store.find<StoredRecord & { name: string }>('groups', {
          tenantId,
          name: OUTSIDERS_GROUP_NAME,
        });
        if (existing) return existing.id;
        if (!create) return undefined;
        const created = await group('groups').create(create, {
          tenantId,
          name: OUTSIDERS_GROUP_NAME,
          description: 'People from outside the organization invited into data rooms',
        });
        return created.id;
      })();
      // A found group is final; "none yet" is looked up again after a minute (creating it here clears that at once).
      found.then(
        (id) => {
          if (id === undefined) setTimeout(() => outsiderGroups.delete(tenantId), 60_000).unref?.();
        },
        () => outsiderGroups.delete(tenantId),
      );
      outsiderGroups.set(tenantId, found);
    }
    return found;
  }
  async function ensureOutsiderGroup(tenantId: string, credential: CredentialInput) {
    const id = await outsiderGroup(tenantId);
    if (id) return id;
    outsiderGroups.delete(tenantId);
    return (await outsiderGroup(tenantId, credential))!;
  }

  // The participant role per tenant, found or created once.
  const participantRoles = new Map<string, Promise<string>>();
  function participantRole(tenantId: string, credential: CredentialInput): Promise<string> {
    let role = participantRoles.get(tenantId);
    if (!role) {
      role = (async () => {
        const roles = group('roles');
        const existing = (await roles.list(credential, { tenantId })).find(
          (r) => r.name === PARTICIPANT_ROLE_NAME,
        );
        if (existing) return existing.id;
        const created = await roles.create(credential, {
          tenantId,
          name: PARTICIPANT_ROLE_NAME,
          description:
            'Grants Better Files actions according to the room relations people and groups hold',
          document: accessModelPolicy(grants),
        });
        return created.id;
      })();
      role.catch(() => participantRoles.delete(tenantId));
      participantRoles.set(tenantId, role);
    }
    return role;
  }
  const bound = new Set<string>();
  async function ensureParticipant(
    tenantId: string,
    credential: CredentialInput,
    subjectType: 'identity' | 'group',
    subjectId: string,
  ) {
    if (options.accessModel === 'manual') return;
    const key = `${tenantId}:${subjectType}:${subjectId}`;
    if (bound.has(key)) return;
    const bind = async () => {
      const roleId = await participantRole(tenantId, credential);
      await ignoring(['CONFLICT'], () =>
        group('bindings').create(credential, { tenantId, roleId, subjectType, subjectId }),
      );
    };
    try {
      await bind();
    } catch (error) {
      // The cached role was deleted in Better IAM (without the guard, or before the audit event arrived): find or
      // create it again.
      if (codeOf(error) !== 'NOT_FOUND') throw error;
      participantRoles.delete(tenantId);
      await bind();
    }
    bound.add(key);
  }

  // Cached ids go stale when Better IAM deletes the records behind them; its audit events say when.
  function forget(tenantId: string) {
    participantRoles.delete(tenantId);
    outsiderGroups.delete(tenantId);
    tenantKeys.delete(tenantId);
    for (const key of bound) if (key.startsWith(`${tenantId}:`)) bound.delete(key);
  }
  const link = options.iamPlugin && linkOf(options.iamPlugin);
  if (link) {
    link.store = iam.store;
    link.listeners.add((event) => {
      if (event.outcome !== 'allow') return;
      if (event.action === 'tenants:purge') {
        const purged = (event.metadata as { tenantIds?: unknown } | undefined)?.tenantIds;
        for (const tenantId of Array.isArray(purged) ? purged : [event.tenantId])
          if (typeof tenantId === 'string') forget(tenantId);
      } else if (
        /^iam:(roles|bindings|groups|kms):delete$/.test(event.action) ||
        event.action === 'iam:tenants:delete'
      )
        forget(event.tenantId);
    });
  }

  const directory: IamDirectory = {
    async registerRoom(call, input) {
      await group('resources').register(await system(call.tenantId, call.credential), {
        tenantId: call.tenantId,
        type: resourceTypes.room,
        id: input.roomId,
        ownerId: input.ownerId,
        attributes: input.attributes,
      });
    },
    async updateRoom(call, input) {
      await group('resources').update(await system(call.tenantId, call.credential), {
        tenantId: call.tenantId,
        type: resourceTypes.room,
        id: input.roomId,
        attributes: input.attributes,
      });
    },
    async deleteRoom(call, input) {
      await ignoring(['NOT_FOUND'], async () =>
        group('resources').delete(await system(call.tenantId, call.credential), {
          tenantId: call.tenantId,
          type: resourceTypes.room,
          id: input.roomId,
        }),
      );
    },
    async grantRoomRole(call, input) {
      const credential = await system(call.tenantId, call.credential);
      const created = await group('relationships').create(credential, {
        tenantId: call.tenantId,
        type: resourceTypes.room,
        id: input.roomId,
        relation: input.relation,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      });
      await ensureParticipant(call.tenantId, credential, input.subjectType, input.subjectId);
      return {
        id: created.id,
        relation: created.relation,
        subjectType: created.subjectType,
        subjectId: created.subjectId,
        ...(created.expiresAt ? { expiresAt: created.expiresAt } : {}),
      };
    },
    async revokeRoomRole(call, input) {
      await ignoring(['NOT_FOUND'], async () =>
        group('relationships').delete(await system(call.tenantId, call.credential), {
          tenantId: call.tenantId,
          relationshipId: input.relationshipId,
        }),
      );
    },
    async listRoomRoles(call, input) {
      const tuples = await group('relationships').list(
        await system(call.tenantId, call.credential),
        {
          tenantId: call.tenantId,
          type: resourceTypes.room,
          id: input.roomId,
        },
      );
      return tuples.map((tuple) => ({
        id: tuple.id,
        relation: tuple.relation,
        subjectType: tuple.subjectType,
        subjectId: tuple.subjectId,
        ...(tuple.expiresAt ? { expiresAt: tuple.expiresAt } : {}),
      }));
    },
    async createGroup(call, input) {
      const created = await group('groups').create(await system(call.tenantId, call.credential), {
        tenantId: call.tenantId,
        name: input.name,
        ...(input.description ? { description: input.description } : {}),
      });
      return { id: created.id };
    },
    async deleteGroup(call, input) {
      await ignoring(['NOT_FOUND'], async () =>
        group('groups').delete(await system(call.tenantId, call.credential), {
          tenantId: call.tenantId,
          groupId: input.groupId,
        }),
      );
    },
    async addGroupMember(call, input) {
      await group('groups').addMember(await system(call.tenantId, call.credential), {
        tenantId: call.tenantId,
        groupId: input.groupId,
        identityId: input.identityId,
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      });
    },
    async removeGroupMember(call, input) {
      // Already gone (an expired membership, say) is what was wanted.
      await ignoring(['NOT_FOUND'], async () =>
        group('groups').removeMember(await system(call.tenantId, call.credential), {
          tenantId: call.tenantId,
          groupId: input.groupId,
          identityId: input.identityId,
        }),
      );
    },
    async groupsOf(call, input) {
      return groupsOf(input.identityId, call.tenantId, Date.now());
    },
    async findIdentityByEmail(call, input) {
      // Better IAM's list query is a substring match; keep only the exact address.
      const found = await group('identities').list(await system(call.tenantId, call.credential), {
        tenantId: call.tenantId,
        query: input.email,
        limit: 50,
      });
      const match = found.find(
        (identity) => identity.email?.toLowerCase() === input.email.toLowerCase(),
      );
      if (!match) return undefined;
      return {
        id: match.id,
        name: match.name,
        guest:
          (match.guest !== undefined && match.guest !== null) ||
          (await isOutsider(match.id, call.tenantId, Date.now())),
      };
    },
    async inviteGuest(call, input) {
      const features = betterIamFeatures(iam);
      const mode = options.externalInvites ?? (features.guests ? 'guests' : undefined);
      const credential = await system(call.tenantId, call.credential);
      if (mode === 'guests' && features.guests) {
        const invitation = await group('guests').invite(credential, {
          tenantId: call.tenantId,
          email: input.email,
          sponsorId: input.sponsorId,
          groupIds: [...input.groupIds],
          ...(input.message ? { message: input.message } : {}),
          ...(input.accessDays ? { accessDays: input.accessDays } : {}),
        });
        return { invitationId: invitation.id };
      }
      if (mode === 'members' && features.memberInvitations) {
        // No sponsor, message or access window in a member invitation: Better Files keeps the window on the member
        // and `dr.maintain()` takes them out of the room when it ends. The outsiders group keeps them guests.
        const outsiders = await ensureOutsiderGroup(call.tenantId, credential);
        const invitation = await group('identities').invite!(credential, {
          tenantId: call.tenantId,
          email: input.email,
          groupIds: [...new Set([...input.groupIds, outsiders])],
        });
        return { invitationId: invitation.invitationId };
      }
      throw new BetterFilesError(
        'UNSUPPORTED',
        mode === 'members'
          ? 'This Better IAM instance has no member invitations'
          : "This Better IAM release has no guests: upgrade Better IAM, or pass externalInvites: 'members' to betterIamIntegration to invite outsiders as tenant members",
      );
    },
    async revokeInvitation(call, input) {
      const credential = await system(call.tenantId, call.credential);
      const request = { tenantId: call.tenantId, invitationId: input.invitationId };
      // A guest or a member invitation (sent before an upgrade brought guests, perhaps): whichever has the id.
      for (const api of [iam.api?.guests, iam.api?.identities]) {
        if (!api?.revokeInvitation) continue;
        try {
          await api.revokeInvitation(credential, request);
          return;
        } catch (error) {
          const code = String(codeOf(error));
          if (code === 'CONFLICT' || code === 'INVALID_TRANSITION') return; // already used or revoked
          if (code !== 'NOT_FOUND') throw error;
        }
      }
    },
  };

  const keys: KeyProvider | undefined =
    options.keys === false || !iam.api?.keys
      ? undefined
      : {
          id: 'better-iam-kms',
          async createRoomKey({ tenantId, roomId }) {
            if (options.keys && options.keys.perRoom === false) return tenantKey(tenantId);
            const created = await group('keys').create(await system(tenantId, {}), {
              tenantId,
              description: `Data room ${roomId}`,
              tags: { 'better-files': 'room', roomId },
            });
            return created.id;
          },
          async retireRoomKey({ tenantId, keyRef }) {
            if (keyRef === 'alias/better-files') return;
            await ignoring(['NOT_FOUND', 'CONFLICT'], async () =>
              group('keys').scheduleDeletion(await system(tenantId, {}), {
                tenantId,
                keyId: keyRef,
                waitingDays: 7,
              }),
            );
          },
          async generateDataKey({ tenantId, keyRef, context }) {
            const keyId = keyRef ?? (await tenantKey(tenantId));
            const generated = await group('keys').generateDataKey(await system(tenantId, {}), {
              tenantId,
              keyId,
              encryptionContext: context,
              includePlaintext: true,
            });
            if (!generated.plaintextBase64)
              throw new BetterFilesError('INTERNAL_ERROR', 'The KMS returned no data key');
            return {
              plaintext: new Uint8Array(Buffer.from(generated.plaintextBase64, 'base64')),
              wrapped: generated.ciphertext,
              keyRef: keyId,
            };
          },
          async decryptDataKey({ tenantId, keyRef, wrapped, context }) {
            const result = await group('keys').decrypt(await system(tenantId, {}), {
              tenantId,
              ciphertext: wrapped,
              encryptionContext: context,
              keyId: keyRef,
            });
            const encoded = result.plaintextBase64 ?? result.plaintext;
            if (!encoded)
              throw new BetterFilesError('INTERNAL_ERROR', 'The KMS returned no data key');
            return new Uint8Array(Buffer.from(encoded, 'base64'));
          },
        };
  // One key per tenant (alias/better-files) for installs that do not want a key per room.
  const tenantKeys = new Map<string, Promise<string>>();
  function tenantKey(tenantId: string): Promise<string> {
    let key = tenantKeys.get(tenantId);
    if (!key) {
      key = (async () => {
        const credential = await system(tenantId, {});
        const created = await ignoring(['CONFLICT'], () =>
          group('keys').create(credential, {
            tenantId,
            alias: 'alias/better-files',
            description: 'Better Files files',
            tags: { 'better-files': 'tenant' },
          }),
        );
        return created?.id ?? 'alias/better-files';
      })();
      key.catch(() => tenantKeys.delete(tenantId));
      tenantKeys.set(tenantId, key);
    }
    return key;
  }
  // KMS calls also happen outside any request (downloads, maintenance), so they need the system credential.
  return {
    id: 'better-iam',
    // Directory writes are Better Files' own, which the plugin's guard lets through.
    directory: Object.fromEntries(
      Object.entries(directory).map(([name, method]) => [
        name,
        (...args: unknown[]) =>
          bypassBetterFilesGuard(() => (method as (...a: unknown[]) => Promise<unknown>)(...args)),
      ]),
    ) as unknown as IamDirectory,
    ...(keys && options.systemCredential ? { keys } : {}),
    ...(options.audit === false || !iam.protocolHost
      ? {}
      : {
          audit: {
            async record(event) {
              const record: AuditEvent = {
                id: randomUUID(),
                tenantId: event.tenantId,
                actorId: event.actorId,
                action: event.action,
                resourceId: `${event.resource.type}/${event.resource.id}`,
                timestamp: Date.now(),
                outcome: event.outcome,
                ...(event.metadata ? { metadata: event.metadata } : {}),
              };
              await iam.store.transaction((tx) => iam.protocolHost!.recordAudit(tx, record));
            },
          },
        }),
    identity: {
      async authenticate(credential, tenantId): Promise<Principal> {
        let authenticated: AuthenticatedPrincipal;
        try {
          authenticated = await iam.authenticate(credentialInput(credential));
        } catch (error) {
          throw translate(error);
        }
        const { identity, session } = authenticated;
        if (session.tenantId !== tenantId)
          throw new BetterFilesError('FORBIDDEN', 'The credential is for another tenant');
        // Role sessions act only with the role's permissions, never with the identity's groups.
        const now = Date.now();
        const memberships = await groupsOf(identity.id, tenantId, now);
        const groups = session.kind === 'role' ? [] : memberships;
        return {
          id: identity.id,
          tenantId,
          kind: identity.kind,
          name: identity.name,
          ...(identity.email === undefined ? {} : { email: identity.email }),
          groups,
          guest:
            (identity.guest !== undefined && identity.guest !== null) ||
            (await isOutsider(identity.id, tenantId, now, memberships)),
          mfa: session.mfa,
          sessionId: session.id,
        };
      },
    },
    authz: {
      async authorize(credential, request) {
        const decision = await iam.authorize({ ...credentialInput(credential), ...request });
        return { allowed: decision.allowed, reason: decision.reason };
      },
      async authorizeMany(credential, request) {
        const results: { allowed: boolean; reason: string }[] = [];
        // Better IAM evaluates at most 50 checks per call.
        for (let start = 0; start < request.checks.length; start += 50) {
          const { results: batch } = await iam.authorizeMany({
            ...credentialInput(credential),
            tenantId: request.tenantId,
            checks: request.checks.slice(start, start + 50),
          });
          results.push(...batch.map(({ allowed, reason }) => ({ allowed, reason })));
        }
        return results;
      },
      ...(iam.listAccessible
        ? {
            async listAccessible(credential, request) {
              const { resources } = await iam.listAccessible!({
                ...credentialInput(credential),
                ...request,
                limit: 1000,
              });
              return resources.map((resource) => resource.resourceId);
            },
          }
        : {}),
    },
    validate({ plugins }) {
      const features = betterIamFeatures(iam);
      if (options.externalInvites === 'guests' && !features.guests)
        throw invalidConfig(
          "externalInvites: 'guests' needs a Better IAM release with guests (0.3 or later)",
        );
      if (options.externalInvites === 'members' && !features.memberInvitations)
        throw invalidConfig("externalInvites: 'members' needs Better IAM member invitations");
      grants = [
        ...coreAccessModel,
        ...plugins.flatMap((plugin) => (plugin as BetterFilesPlugin).accessModel ?? []),
      ];
      // The IAM plugin must know every action a Better Files plugin authorizes, or Better IAM refuses the decisions.
      if (!options.iamPlugin) return;
      const registered = new Set(options.iamPlugin.actions ?? []);
      for (const plugin of plugins)
        for (const action of plugin.actions ?? [])
          if (!registered.has(action))
            throw invalidConfig(
              `Action ${action} of Better Files plugin ${plugin.id} is not registered: pass the same plugins to betterFilesIamPlugin({ plugins })`,
            );
    },
  };
}

/**
 * The permissions a Better Files system service account needs in each tenant, as a Better IAM policy document. Attach
 * it to a role bound to the service account whose API key `systemCredential` returns.
 *
 * Pass the Better IAM instance so the document only names actions that release knows: 0.2.x refuses a role
 * naming the `iam:guests:*` actions it does not have. Without it, the guest actions are included.
 */
export function systemPolicy(iam?: BetterIamInstance): PolicyDocument {
  const guests = iam === undefined || betterIamFeatures(iam).guests;
  return {
    version: 1 as const,
    statements: [
      {
        sid: 'BetterFilesDirectory',
        effect: 'allow' as const,
        actions: [
          'iam:resources:create',
          'iam:resources:read',
          'iam:resources:update',
          'iam:resources:delete',
          'iam:relationships:create',
          'iam:relationships:read',
          'iam:relationships:delete',
          'iam:groups:create',
          'iam:groups:read',
          'iam:groups:update',
          'iam:groups:delete',
          'iam:roles:create',
          'iam:roles:read',
          'iam:bindings:create',
          'iam:identities:read',
          // Member invitations for outsiders (externalInvites: 'members'), and withdrawing them.
          'iam:identities:create',
          'iam:identities:update',
          ...(guests ? ['iam:guests:invite', 'iam:guests:manage'] : []),
          'iam:kms:create',
          'iam:kms:update',
          'iam:kms:generate-data-key',
          'iam:kms:decrypt',
          'iam:kms:delete',
        ],
        resources: ['iam/*'],
      },
    ],
  };
}

export type ResourceResolver = (
  reference: ResourceRef,
) => Promise<ResourceRef & { attributes?: Record<string, unknown> }>;

/**
 * `resolveResource` for Better IAM: describes Better Files folders and documents (room status, and the room as parent so
 * room relations reach policies as `resource.parentRelations`), and hands every other type to `fallback`.
 *
 * ```ts
 * betterIam({ ..., resolveResource: betterFilesResolver(() => dr, { fallback: appResolver }) })
 * ```
 */
export function betterFilesResolver(
  getBetterFiles: () => {
    resolveForIam(
      reference: ResourceRef,
    ): Promise<(ResourceRef & { attributes: Record<string, unknown> }) | undefined>;
  },
  options: { fallback?: ResourceResolver } = {},
): ResourceResolver {
  return async (reference) => {
    const resolved = await getBetterFiles().resolveForIam(reference);
    if (resolved) return resolved;
    // Tenant-wide Better Files operations are authorized on `iam/{tenantId}`, as Better IAM authorizes plugin endpoints.
    // Checks from outside Better IAM reach the resolver for that type too; it describes itself.
    if (reference.type === 'iam') return { ...reference };
    if (options.fallback) return options.fallback(reference);
    throw new BetterFilesError('NOT_FOUND', `No resolver for resource type ${reference.type}`);
  };
}
