import {
  BetterFilesError,
  notFound,
  type AuthorizationCheck,
  type Credential,
  type IamDirectory,
  type IamIntegration,
  type Principal,
  type RoomRoleGrant,
  type SecurityAuditEvent,
} from '@better-files/core';

export type FakePrincipal = Omit<Principal, 'groups' | 'guest' | 'mfa' | 'kind'> &
  Partial<Pick<Principal, 'groups' | 'guest' | 'mfa' | 'kind'>>;

export interface FakeIamOptions {
  /** Principals by bearer token. */
  principals: Record<string, FakePrincipal>;
  /**
   * Layer B decisions. Default: allow everything, so tests exercise the permission matrix alone. The state gives the
   * room relations each principal holds, for relation-based fakes.
   */
  decide?: (
    principal: Principal,
    check: AuthorizationCheck & { tenantId: string },
    state: FakeDirectoryState,
  ) => boolean | Promise<boolean>;
}

export interface FakeDirectoryState {
  rooms: Map<string, { tenantId: string; ownerId: string; attributes: Record<string, unknown> }>;
  relationships: Map<string, RoomRoleGrant & { tenantId: string; roomId: string }>;
  groups: Map<string, { tenantId: string; name: string; members: Map<string, number | undefined> }>;
  invitations: {
    tenantId: string;
    email: string;
    groupIds: readonly string[];
    sponsorId: string;
    invitationId: string;
    revoked?: boolean;
  }[];
  audit: SecurityAuditEvent[];
  /** Relations a principal holds on a room, directly or through groups. */
  relationsOf(principal: Principal, roomId: string): string[];
}

function tokenOf(credential: Credential): string | undefined {
  if (credential.token) return credential.token;
  const authorization = new Headers(credential.headers).get('authorization');
  return authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
}

let sequence = 0;
const nextId = (prefix: string) => `${prefix}_${(++sequence).toString(36).padStart(6, '0')}`;

/**
 * A stand-in identity system for tests: bearer tokens map to principals, decisions come from a function, and an
 * in-memory directory records rooms, relations, groups and invitations. Group memberships added through the
 * directory show up in `principal.groups`, as they would with Better IAM.
 */
export function fakeIam(options: FakeIamOptions): IamIntegration & {
  /** Every layer B check, in order, for assertions. */
  readonly checks: (AuthorizationCheck & { tenantId: string; principalId: string })[];
  readonly state: FakeDirectoryState;
} {
  const checks: (AuthorizationCheck & { tenantId: string; principalId: string })[] = [];
  const state: FakeDirectoryState = {
    rooms: new Map(),
    relationships: new Map(),
    groups: new Map(),
    invitations: [],
    audit: [],
    relationsOf(principal, roomId) {
      const out = new Set<string>();
      for (const grant of state.relationships.values()) {
        if (grant.roomId !== roomId) continue;
        if (grant.subjectType === 'identity' && grant.subjectId === principal.id)
          out.add(grant.relation);
        if (grant.subjectType === 'group' && principal.groups.includes(grant.subjectId))
          out.add(grant.relation);
      }
      return [...out];
    },
  };
  const groupsOf = (identityId: string, tenantId: string) =>
    [...state.groups.entries()]
      .filter(([, group]) => group.tenantId === tenantId && group.members.has(identityId))
      .map(([id]) => id);
  const lookup = (credential: Credential): Principal => {
    const token = tokenOf(credential);
    const found = token === undefined ? undefined : options.principals[token];
    if (!found) throw new BetterFilesError('UNAUTHENTICATED', 'Unknown credential');
    const base = { kind: 'user' as const, guest: false, mfa: false, ...found };
    return {
      ...base,
      groups: [...new Set([...(found.groups ?? []), ...groupsOf(found.id, found.tenantId)])],
    };
  };
  const decide = async (principal: Principal, check: AuthorizationCheck & { tenantId: string }) => {
    checks.push({ ...check, principalId: principal.id });
    if (principal.tenantId !== check.tenantId) return false;
    return options.decide ? options.decide(principal, check, state) : true;
  };
  const directory: IamDirectory = {
    async registerRoom(call, input) {
      state.rooms.set(input.roomId, {
        tenantId: call.tenantId,
        ownerId: input.ownerId,
        attributes: input.attributes,
      });
    },
    async updateRoom(_call, input) {
      const room = state.rooms.get(input.roomId);
      if (!room) throw notFound('Resource');
      room.attributes = input.attributes;
    },
    async deleteRoom(_call, input) {
      state.rooms.delete(input.roomId);
      for (const [id, grant] of state.relationships)
        if (grant.roomId === input.roomId) state.relationships.delete(id);
    },
    async grantRoomRole(call, input) {
      if (!state.rooms.has(input.roomId)) throw notFound('Resource');
      const existing = [...state.relationships.values()].find(
        (grant) =>
          grant.roomId === input.roomId &&
          grant.relation === input.relation &&
          grant.subjectType === input.subjectType &&
          grant.subjectId === input.subjectId,
      );
      const grant = {
        id: existing?.id ?? nextId('rel'),
        tenantId: call.tenantId,
        roomId: input.roomId,
        relation: input.relation,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      };
      state.relationships.set(grant.id, grant);
      return grant;
    },
    async revokeRoomRole(_call, input) {
      state.relationships.delete(input.relationshipId);
    },
    async listRoomRoles(_call, input) {
      return [...state.relationships.values()].filter((grant) => grant.roomId === input.roomId);
    },
    async createGroup(call, input) {
      const id = nextId('iamgrp');
      state.groups.set(id, { tenantId: call.tenantId, name: input.name, members: new Map() });
      return { id };
    },
    async deleteGroup(_call, input) {
      state.groups.delete(input.groupId);
      for (const [id, grant] of state.relationships)
        if (grant.subjectType === 'group' && grant.subjectId === input.groupId)
          state.relationships.delete(id);
    },
    async addGroupMember(_call, input) {
      const group = state.groups.get(input.groupId);
      if (!group) throw notFound('Group');
      if (group.members.has(input.identityId))
        throw new BetterFilesError('CONFLICT', 'Already a member');
      group.members.set(input.identityId, input.expiresAt);
    },
    async removeGroupMember(_call, input) {
      state.groups.get(input.groupId)?.members.delete(input.identityId);
    },
    async groupsOf(call, input) {
      return groupsOf(input.identityId, call.tenantId);
    },
    async findIdentityByEmail(call, input) {
      const found = Object.values(options.principals).find(
        (principal) =>
          principal.tenantId === call.tenantId &&
          principal.email?.toLowerCase() === input.email.toLowerCase(),
      );
      return found
        ? { id: found.id, ...(found.name ? { name: found.name } : {}), guest: found.guest ?? false }
        : undefined;
    },
    async inviteGuest(call, input) {
      const invitationId = nextId('inv');
      state.invitations.push({
        tenantId: call.tenantId,
        email: input.email,
        groupIds: input.groupIds,
        sponsorId: input.sponsorId,
        invitationId,
      });
      return { invitationId };
    },
    async revokeInvitation(_call, input) {
      const invitation = state.invitations.find((i) => i.invitationId === input.invitationId);
      if (invitation) invitation.revoked = true;
    },
  };
  return {
    id: 'fake',
    checks,
    state,
    directory,
    audit: {
      async record(event) {
        state.audit.push(event);
      },
    },
    identity: {
      async authenticate(credential, tenantId) {
        const principal = lookup(credential);
        if (principal.tenantId !== tenantId)
          throw new BetterFilesError('FORBIDDEN', 'The credential is for another tenant');
        return principal;
      },
    },
    authz: {
      async authorize(credential, request) {
        const allowed = await decide(lookup(credential), request);
        return { allowed, reason: allowed ? 'allowed' : 'denied' };
      },
      async authorizeMany(credential, request) {
        const principal = lookup(credential);
        return Promise.all(
          request.checks.map(async (check) => {
            const allowed = await decide(principal, { ...check, tenantId: request.tenantId });
            return { allowed, reason: allowed ? 'allowed' : 'denied' };
          }),
        );
      },
    },
  };
}

/**
 * A `decide` function for `fakeIam` that follows the Better Files access model: room relations (direct or through
 * groups) grant the actions `coreAccessModel` lists; `iam/{tenantId}` checks follow `tenantActions`.
 */
export function relationDecider(
  model: readonly { relations: readonly string[]; actions: readonly string[] }[],
  options: {
    tenantActions?: (principal: Principal) => readonly string[];
    /** Maps a folder or document id to its room (tests pass the database lookup). */
    roomOf?: (type: string, id: string) => string | undefined | Promise<string | undefined>;
  } = {},
): NonNullable<FakeIamOptions['decide']> {
  return async (principal, check, state) => {
    if (check.resource.type === 'iam') {
      const actions = options.tenantActions?.(principal) ?? [];
      return actions.includes('*') || actions.includes(check.action);
    }
    const roomId =
      check.resource.type === 'better-files-room'
        ? check.resource.id
        : await options.roomOf?.(check.resource.type, check.resource.id);
    if (!roomId) return false;
    const held = state.relationsOf(principal, roomId);
    return model.some(
      (grant) =>
        grant.actions.includes(check.action) && grant.relations.some((r) => held.includes(r)),
    );
  };
}
