import type {
  Credential,
  DatabaseAdapter,
  DirectoryCall,
  IamDirectory,
  Member,
  PermissionGroup,
  Room,
  RoomRoleGrant,
} from '@better-files/core';

/** The parts of a `betterFiles()` instance the reconciler reads: its database and identity integration. */
export interface ReconcilableBetterFiles {
  options: {
    database: DatabaseAdapter;
    iam: { directory?: IamDirectory };
  };
}

export type IamDriftKind =
  /** A roster row (member or permission group) holds a relation the identity system does not have. */
  | 'missing-relation'
  /** The identity system has the relation, under another id than the roster recorded. */
  | 'stale-relation-id'
  /** Someone who is no longer an active member still holds a relation on the room. */
  | 'lingering-relation'
  /** An active member is missing from one of the room's permission groups. */
  | 'missing-group-membership'
  /** Someone who is no longer an active member is still in one of the room's permission groups. */
  | 'lingering-group-membership'
  /** A relation on the room that no roster row explains (granted in the identity system directly, or left over). */
  | 'orphan-relation'
  /** The room is not a registered resource in the identity system. */
  | 'unregistered-room'
  /** Room creation stopped before the identity system knew the room. */
  | 'stuck-provisioning';

export interface IamDrift {
  kind: IamDriftKind;
  roomId: string;
  message: string;
  subject?: { type: 'identity' | 'group'; id: string };
  relation?: string;
  memberId?: string;
  groupId?: string;
  /** Set when repair was requested: whether this difference was fixed. */
  repaired?: boolean;
  error?: string;
}

export interface ReconcileOptions {
  tenantId: string;
  /** One room; default every room of the tenant. */
  roomId?: string;
  /** Fix what can be fixed. Default false: report only. */
  repair?: boolean;
  /**
   * Also revoke relations no roster row explains. Default false: the identity system is authoritative for
   * membership, and administrators may have granted them there on purpose.
   */
  revokeOrphans?: boolean;
  /**
   * The credential for directory reads and writes. Integrations with a system credential (Better IAM's
   * `systemCredential`) use theirs; otherwise pass an administrator's.
   */
  credential?: Credential;
  /** Rooms still `provisioning` after this long are reported. Default 1 hour. */
  provisioningGraceMs?: number;
  now?: number;
}

export interface ReconcileReport {
  tenantId: string;
  rooms: number;
  drift: IamDrift[];
  repaired: number;
  failed: number;
}

const codeOf = (error: unknown) => String((error as { code?: unknown })?.code ?? '');
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const live = (expiresAt: number | null | undefined, now: number) =>
  expiresAt === undefined || expiresAt === null || expiresAt > now;
const tupleKey = (relation: string, type: string, id: string) => `${relation}|${type}|${id}`;

/**
 * Compares the identity system with the Better Files roster (PLAN §10.6): room relations held by members and
 * permission groups, and permission-group memberships. Better Files writes both sides in order rather than in one
 * transaction, so a crash, a failed call or an edit made directly in the identity system leaves them apart.
 *
 * Run it during quiet periods: an invitation or role change that lands between the two reads shows up as drift.
 *
 * ```ts
 * const report = await reconcileIam(dr, { tenantId, repair: true });
 * ```
 */
export async function reconcileIam(
  dr: ReconcilableBetterFiles,
  options: ReconcileOptions,
): Promise<ReconcileReport> {
  const directory = dr.options.iam.directory;
  if (!directory)
    throw Object.assign(new Error('The identity integration has no directory to reconcile'), {
      code: 'UNSUPPORTED',
    });
  const db = dr.options.database;
  const { tenantId } = options;
  const now = options.now ?? Date.now();
  const call: DirectoryCall = {
    tenantId,
    credential: options.credential ?? {},
    actorId: 'better-files-reconcile',
  };
  const drift: IamDrift[] = [];
  let repaired = 0;
  let failed = 0;

  /** Records a difference, and runs its repair when asked to. */
  async function found(item: IamDrift, repair?: () => Promise<void>) {
    drift.push(item);
    if (!options.repair || !repair) return;
    try {
      await repair();
      item.repaired = true;
      repaired++;
    } catch (error) {
      item.repaired = false;
      item.error = message(error);
      failed++;
    }
  }

  const rooms = await db.findMany<Room>('rooms', {
    where: { tenantId, ...(options.roomId ? { id: options.roomId } : {}) },
  });
  // Group memberships are read once per identity.
  const memberships = new Map<string, Promise<Set<string>>>();
  const groupsOf = (identityId: string) => {
    let groups = memberships.get(identityId);
    if (!groups) {
      groups = directory.groupsOf(call, { identityId }).then((ids) => new Set(ids));
      memberships.set(identityId, groups);
    }
    return groups;
  };

  for (const room of rooms) {
    if (room.status === 'provisioning') {
      if (room.createdAt < now - (options.provisioningGraceMs ?? 3_600_000))
        await found({
          kind: 'stuck-provisioning',
          roomId: room.id,
          message: `Room ${room.name} has been provisioning since ${new Date(room.createdAt).toISOString()}`,
        });
      continue;
    }
    let tuples: RoomRoleGrant[];
    try {
      tuples = await directory.listRoomRoles(call, { roomId: room.id });
    } catch (error) {
      if (codeOf(error) !== 'NOT_FOUND') throw error;
      await found({
        kind: 'unregistered-room',
        roomId: room.id,
        message: `Room ${room.name} is not registered in the identity system; nobody can reach it`,
      });
      continue;
    }
    const current = tuples.filter((tuple) => live(tuple.expiresAt, now));
    const byId = new Map(current.map((tuple) => [tuple.id, tuple]));
    const bySubject = new Map<string, RoomRoleGrant[]>();
    for (const tuple of current) {
      const key = tupleKey(tuple.relation, tuple.subjectType, tuple.subjectId);
      bySubject.set(key, [...(bySubject.get(key) ?? []), tuple]);
    }
    const explained = new Set<string>();

    /**
     * The relation a roster row records: present under its id, present under another id, or missing. Returns the
     * id the row should hold after a repair.
     */
    async function expectRelation(input: {
      relation: string;
      subjectType: 'identity' | 'group';
      subjectId: string;
      recordedId: string | null | undefined;
      expiresAt?: number | null;
      label: string;
      table: 'members' | 'permissionGroups';
      rowId: string;
    }) {
      const recorded = input.recordedId ? byId.get(input.recordedId) : undefined;
      if (
        recorded &&
        recorded.relation === input.relation &&
        recorded.subjectType === input.subjectType &&
        recorded.subjectId === input.subjectId
      ) {
        explained.add(recorded.id);
        return;
      }
      const subject = { type: input.subjectType, id: input.subjectId };
      const ids = input.table === 'members' ? { memberId: input.rowId } : { groupId: input.rowId };
      const match = bySubject
        .get(tupleKey(input.relation, input.subjectType, input.subjectId))
        ?.find((tuple) => !explained.has(tuple.id));
      if (match) {
        explained.add(match.id);
        await found(
          {
            kind: 'stale-relation-id',
            roomId: room.id,
            message: `${input.label} holds ${input.relation} under another relationship id`,
            subject,
            relation: input.relation,
            ...ids,
          },
          () => setRelationshipId(input.table, input.rowId, match.id),
        );
        return;
      }
      await found(
        {
          kind: 'missing-relation',
          roomId: room.id,
          message: `${input.label} should hold ${input.relation} on the room but the identity system has no such relation`,
          subject,
          relation: input.relation,
          ...ids,
        },
        async () => {
          const grant = await directory!.grantRoomRole(call, {
            roomId: room.id,
            relation: input.relation,
            subjectType: input.subjectType,
            subjectId: input.subjectId,
            ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
          });
          explained.add(grant.id);
          await setRelationshipId(input.table, input.rowId, grant.id);
        },
      );
    }

    async function setRelationshipId(
      table: 'members' | 'permissionGroups',
      id: string,
      relationshipId: string,
    ) {
      await db.transaction((tx) =>
        tx.update(
          table,
          { id, tenantId },
          { relationshipId, ...(table === 'members' ? { updatedAt: now } : {}) },
        ),
      );
    }

    const groups = await db.findMany<PermissionGroup>('permissionGroups', {
      where: { tenantId, roomId: room.id },
    });
    const groupById = new Map(groups.map((group) => [group.id, group]));
    const roomGroupIds = new Set(groups.map((group) => group.iamGroupId));
    for (const group of groups) {
      if (!live(group.expiresAt, now) || !group.relationshipId) continue;
      await expectRelation({
        relation: group.relation,
        subjectType: 'group',
        subjectId: group.iamGroupId,
        recordedId: group.relationshipId,
        expiresAt: group.expiresAt,
        label: `Group ${group.name}`,
        table: 'permissionGroups',
        rowId: group.id,
      });
    }

    const members = await db.findMany<Member>('members', {
      where: { tenantId, roomId: room.id },
    });
    for (const member of members) {
      if (!member.identityId) continue;
      const identityId = member.identityId;
      const label = `Member ${member.email ?? identityId}`;
      const subject = { type: 'identity' as const, id: identityId };
      // Access windows that ended are maintenance's job (`dr.maintain()` detaches and marks them expired).
      const active = member.status === 'active' && live(member.expiresAt, now);
      if (member.status === 'active' && !active) continue;
      if (active) {
        if (member.relation)
          await expectRelation({
            relation: member.relation,
            subjectType: 'identity',
            subjectId: identityId,
            recordedId: member.relationshipId,
            expiresAt: member.expiresAt,
            label,
            table: 'members',
            rowId: member.id,
          });
        const held = await groupsOf(identityId);
        for (const groupId of member.groupIds) {
          const group = groupById.get(groupId);
          if (!group || !live(group.expiresAt, now) || held.has(group.iamGroupId)) continue;
          await found(
            {
              kind: 'missing-group-membership',
              roomId: room.id,
              message: `${label} is not in the identity-system group of ${group.name}`,
              subject,
              memberId: member.id,
              groupId: group.id,
            },
            async () => {
              await directory.addGroupMember(call, {
                groupId: group.iamGroupId,
                identityId,
                ...(member.expiresAt ? { expiresAt: member.expiresAt } : {}),
              });
              held.add(group.iamGroupId);
            },
          );
        }
        continue;
      }
      // Suspended, removed or expired: nothing on the room should remain.
      for (const tuple of current)
        if (
          tuple.subjectType === 'identity' &&
          tuple.subjectId === identityId &&
          !explained.has(tuple.id)
        ) {
          explained.add(tuple.id);
          await found(
            {
              kind: 'lingering-relation',
              roomId: room.id,
              message: `${label} is ${member.status} but still holds ${tuple.relation} on the room`,
              subject,
              relation: tuple.relation,
              memberId: member.id,
            },
            () => directory.revokeRoomRole(call, { relationshipId: tuple.id }),
          );
        }
      if (member.status === 'invited') continue;
      const held = await groupsOf(identityId);
      for (const iamGroupId of roomGroupIds) {
        if (!held.has(iamGroupId)) continue;
        const group = groups.find((candidate) => candidate.iamGroupId === iamGroupId)!;
        await found(
          {
            kind: 'lingering-group-membership',
            roomId: room.id,
            message: `${label} is ${member.status} but still in the identity-system group of ${group.name}`,
            subject,
            memberId: member.id,
            groupId: group.id,
          },
          async () => {
            await directory.removeGroupMember(call, { groupId: iamGroupId, identityId });
            held.delete(iamGroupId);
          },
        );
      }
    }

    // Relations nobody on the roster accounts for.
    for (const tuple of current) {
      if (explained.has(tuple.id)) continue;
      await found(
        {
          kind: 'orphan-relation',
          roomId: room.id,
          message: `${tuple.subjectType} ${tuple.subjectId} holds ${tuple.relation} on the room without a roster entry`,
          subject: { type: tuple.subjectType, id: tuple.subjectId },
          relation: tuple.relation,
        },
        options.revokeOrphans
          ? () => directory.revokeRoomRole(call, { relationshipId: tuple.id })
          : undefined,
      );
    }
  }
  return { tenantId, rooms: rooms.length, drift, repaired, failed };
}
