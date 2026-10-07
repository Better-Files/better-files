import {
  applyClamps,
  Capability,
  createAccessIndex,
  loadNodePaths,
  resourceTypes,
  subjectKey,
  type AccessClamp,
  type AccessEntry,
  type AclEntry,
  type CapabilityRegistry,
  type Credential,
  type DatabaseAdapter,
  type DataRoomDocument,
  type DataRoomNode,
  type BetterFilesHooks,
  type IamIntegration,
  type PluginContext,
  type Principal,
  type Room,
  type SubjectKey,
} from '@better-files/core';

const WRITE_BITS = Capability.UPLOAD | Capability.EDIT | Capability.DELETE;
const DOWNLOAD_BITS = Capability.DOWNLOAD_WATERMARKED | Capability.DOWNLOAD_ORIGINAL;

export interface AccessRequest {
  db: DatabaseAdapter;
  credential: Credential;
  principal: Principal;
  room: Room;
  nodes: readonly DataRoomNode[];
  /** Passed to `clampCapabilities` hooks. */
  context: PluginContext;
  /** Document rows the caller already loaded (for document flags); only the missing ones are fetched. */
  documents?: ReadonlyMap<string, DataRoomDocument>;
}

/** Clamps from room state and settings, applied after resolution. */
export function roomClamps(room: Room): AccessClamp[] {
  const clamps: AccessClamp[] = [];
  if (room.status === 'closed' || room.status === 'archived' || room.status === 'provisioning')
    clamps.push({ remove: WRITE_BITS, reason: `room is ${room.status}` });
  if (room.settings.downloadsEnabled === false)
    clamps.push({ remove: DOWNLOAD_BITS, reason: 'downloads are disabled in this room' });
  if (room.settings.printEnabled === false)
    clamps.push({ remove: Capability.PRINT, reason: 'printing is disabled in this room' });
  return clamps;
}

export function documentClamps(document: DataRoomDocument | undefined): AccessClamp[] {
  const flags = document?.flags ?? {};
  const clamps: AccessClamp[] = [];
  if (flags.viewOnly)
    clamps.push({
      remove: DOWNLOAD_BITS | Capability.PRINT | Capability.COPY_TEXT,
      reason: 'document is view only',
    });
  if (flags.noPrint) clamps.push({ remove: Capability.PRINT, reason: 'printing is disabled' });
  if (flags.noCopy) clamps.push({ remove: Capability.COPY_TEXT, reason: 'copying is disabled' });
  return clamps;
}

/**
 * Layer A of authorization: the room's permission matrix, resolved over the folder tree, with room-role floors from
 * the identity system and clamps from room settings, document flags and hooks. Layer B (the IAM policy decision) is
 * applied by the operation pipeline.
 */
export function createAccessEngine(context: {
  iam: IamIntegration;
  capabilities: CapabilityRegistry;
  hooks: readonly BetterFilesHooks[];
  now: () => number;
}) {
  /**
   * Floors from room roles, decided by the identity system: room administrators (`better-files:admin` on the room) hold
   * every capability everywhere; auditors (`better-files:activity:export`) can list and view everything.
   */
  async function roomFloor(
    credential: Credential,
    principal: Principal,
    room: Room,
  ): Promise<number> {
    const resource = { type: resourceTypes.room, id: room.id };
    const [admin, auditor] = await context.iam.authz.authorizeMany(credential, {
      tenantId: principal.tenantId,
      checks: [
        { action: 'better-files:admin', resource },
        { action: 'better-files:activity:export', resource },
      ],
    });
    if (admin?.allowed) return context.capabilities.all;
    return auditor?.allowed ? Capability.LIST | Capability.VIEW : 0;
  }

  async function capabilities(request: AccessRequest): Promise<Map<string, number>> {
    const { db, principal, room, nodes } = request;
    const result = new Map<string, number>();
    if (nodes.length === 0) return result;
    const tenantId = room.tenantId;
    const floor = await roomFloor(request.credential, principal, room);
    const paths = await loadNodePaths(db, tenantId, nodes);
    const ancestorIds = [...new Set([...paths.values()].flat())];
    const entries = (
      ancestorIds.length
        ? await db.findMany<AclEntry>('aclEntries', {
            where: { tenantId, roomId: room.id, nodeId: { in: ancestorIds } },
          })
        : []
    ).map(
      (entry): AccessEntry => ({
        nodeId: entry.nodeId,
        subject: subjectKey(entry.subjectType, entry.subjectId),
        mask: entry.mask,
        locked: entry.locked,
        ...(entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt }),
      }),
    );
    const subjects: SubjectKey[] = [
      subjectKey('identity', principal.id),
      ...principal.groups.map((group) => subjectKey('group', group)),
    ];
    const documentsById = new Map(request.documents);
    const missing = nodes
      .filter((node) => node.kind === 'document' && !documentsById.has(node.id))
      .map((node) => node.id);
    if (missing.length)
      for (const document of await db.findMany<DataRoomDocument>('documents', {
        where: { tenantId, id: { in: missing } },
      }))
        documentsById.set(document.id, document);
    const index = createAccessIndex({ entries, subjects, now: context.now() });
    const requireAncestorList = room.settings.requireAncestorList !== false;
    const fromRoom = roomClamps(room);
    for (const node of nodes) {
      const resolved = index.resolve(paths.get(node.id) ?? [], { requireAncestorList });
      const clamps = [...fromRoom, ...documentClamps(documentsById.get(node.id))];
      for (const hooks of context.hooks)
        if (hooks.clampCapabilities)
          clamps.push(...(await hooks.clampCapabilities({ context: request.context, room, node })));
      result.set(node.id, applyClamps(resolved | floor, clamps));
    }
    return result;
  }

  return { capabilities, roomFloor };
}

export type AccessEngine = ReturnType<typeof createAccessEngine>;
