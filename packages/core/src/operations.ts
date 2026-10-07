import type { CoreCapability } from './capabilities.js';

/** Better IAM resource types. Names follow its rule: lowercase letters, digits and hyphens. */
export const resourceTypes = {
  room: 'better-files-room',
  folder: 'better-files-folder',
  document: 'better-files-document',
} as const;

/** Relations identities and groups may hold on `better-files-room/{roomId}`. */
export const roomRelations = [
  'owner',
  'admin',
  'publisher',
  'editor',
  'contributor',
  'viewer',
  'auditor',
] as const;
export type RoomRelation = (typeof roomRelations)[number];

/**
 * What an operation is checked against: the tenant, a room, or a folder/document node. `public` operations take no
 * credential and skip both layers; their handlers check a bearer secret of their own (share links).
 */
export type OperationTarget = 'tenant' | 'room' | 'node' | 'public';

export interface OperationSpec {
  /** The identity-system action authorized for this operation (layer B). */
  action: string;
  target: OperationTarget;
  /** Capabilities the caller must hold on the target node (layer A); node operations only. */
  capabilities?: readonly CoreCapability[];
  /** State-changing operations run in a transaction and refuse closed and archived rooms. */
  mutates: boolean;
  /** Room lifecycle operations run even on closed rooms (reopen, archive, delete). */
  allowClosed?: boolean;
  /**
   * Skips `gateRoom` hooks (an NDA not yet accepted): for operations that only describe the caller's own access to
   * the room, such as whether their network is allowed, and return no room content.
   */
  ungated?: boolean;
}

const node = (
  action: string,
  capabilities: readonly CoreCapability[],
  mutates: boolean,
): OperationSpec => ({ action: `better-files:${action}`, target: 'node', capabilities, mutates });
const room = (action: string, mutates: boolean, allowClosed = false): OperationSpec => ({
  action: `better-files:${action}`,
  target: 'room',
  mutates,
  ...(allowClosed ? { allowClosed } : {}),
});
const tenant = (action: string, mutates: boolean): OperationSpec => ({
  action: `better-files:${action}`,
  target: 'tenant',
  mutates,
});

/**
 * Every core operation, keyed `group.method`: the single source for the engine, the generated API reference and the
 * test that fails when a route is not mapped. Plugins declare their own operations the same way.
 */
export const operationMatrix = {
  'rooms.create': tenant('rooms:create', true),
  'rooms.list': tenant('rooms:read', false),
  'rooms.get': room('rooms:read', false, true),
  'rooms.index': room('documents:list', false, true),
  'rooms.update': room('rooms:update', true),
  'rooms.publish': room('rooms:publish', true),
  'rooms.close': room('rooms:close', true),
  'rooms.reopen': room('rooms:reopen', true, true),
  'rooms.archive': room('rooms:archive', true, true),
  'rooms.delete': room('rooms:delete', true, true),
  'rooms.trash': room('documents:restore', false, true),
  'rooms.export': room('rooms:export', false, true),

  'folders.create': node('documents:upload', ['UPLOAD'], true),
  'folders.list': node('documents:list', ['LIST'], false),
  'folders.rename': node('documents:edit', ['EDIT'], true),
  'folders.move': node('documents:edit', ['EDIT'], true),
  'folders.delete': node('documents:delete', ['DELETE'], true),
  'folders.restore': node('documents:restore', ['DELETE'], true),
  // Every document in the ZIP is checked for its own download capability.
  'folders.requestDownload': node('documents:download', ['LIST'], false),

  'documents.get': node('documents:list', ['LIST'], false),
  'documents.rename': node('documents:edit', ['EDIT'], true),
  'documents.move': node('documents:edit', ['EDIT'], true),
  'documents.delete': node('documents:delete', ['DELETE'], true),
  'documents.restore': node('documents:restore', ['DELETE'], true),
  'documents.setFlags': node('permissions:manage', ['MANAGE'], true),
  'documents.requestView': node('documents:view', ['VIEW'], false),
  'documents.requestDownload': node('documents:download', ['DOWNLOAD_WATERMARKED'], false),
  'documents.requestOriginal': node('documents:download-original', ['DOWNLOAD_ORIGINAL'], false),

  'versions.list': node('versions:read', ['VIEW'], false),
  'versions.restore': node('versions:manage', ['EDIT'], true),

  'uploads.create': node('documents:upload', ['UPLOAD'], true),
  'uploads.complete': node('documents:upload', ['UPLOAD'], true),
  'uploads.abort': node('documents:upload', ['UPLOAD'], true),

  'members.list': room('members:read', false, true),
  'members.invite': room('members:invite', true),
  'members.inviteMany': room('members:invite', true),
  'members.remove': room('members:remove', true),
  'members.setRole': room('members:manage', true),
  'members.suspend': room('members:manage', true),
  'members.resume': room('members:manage', true),

  'groups.list': room('members:read', false, true),
  'groups.create': room('members:manage', true),
  'groups.update': room('members:manage', true),
  'groups.delete': room('members:manage', true),
  'groups.addMembers': room('members:manage', true),
  'groups.removeMembers': room('members:manage', true),

  'permissions.getMatrix': node('permissions:read', ['MANAGE'], false),
  'permissions.setEntries': node('permissions:manage', ['MANAGE'], true),
  'permissions.explain': node('permissions:read', ['MANAGE'], false),
  'permissions.capabilities': room('documents:list', false, true),

  'activity.list': room('activity:read', false, true),
  'activity.verify': room('activity:read', false, true),
} as const satisfies Record<string, OperationSpec>;

export type CoreOperation = keyof typeof operationMatrix;

/** Actions that are not tied to one operation. */
export const extraActions = ['better-files:admin', 'better-files:activity:export'] as const;

/** The action catalog the Better IAM plugin registers for the core. */
export const coreActions: readonly string[] = [
  ...new Set([
    ...Object.values(operationMatrix).map((spec: OperationSpec) => spec.action),
    ...extraActions,
  ]),
].sort();

export const actionNamespace = 'better-files';
export const isBetterFilesAction = (action: string) =>
  /^better-files(:[a-z][a-z0-9-]*)+$/.test(action);

/** One rule of the access model: holders of these room relations may perform these actions. */
export interface AccessGrant {
  relations: readonly RoomRelation[];
  actions: readonly string[];
}

const everyone = roomRelations;
const contributors = ['owner', 'admin', 'publisher', 'editor', 'contributor'] as const;
const editors = ['owner', 'admin', 'publisher', 'editor'] as const;
const publishers = ['owner', 'admin', 'publisher'] as const;
const admins = ['owner', 'admin'] as const;

/**
 * What each room relation may do in the identity system (layer B). The permission matrix (layer A) still decides
 * which folders and documents each person reaches, so the model is deliberately broad on content actions.
 */
export const coreAccessModel: readonly AccessGrant[] = [
  {
    relations: everyone,
    actions: [
      'better-files:rooms:read',
      'better-files:documents:list',
      'better-files:documents:view',
      'better-files:documents:download',
      'better-files:documents:download-original',
      'better-files:versions:read',
    ],
  },
  { relations: contributors, actions: ['better-files:documents:upload'] },
  {
    relations: editors,
    actions: [
      'better-files:documents:edit',
      'better-files:documents:delete',
      'better-files:documents:restore',
      'better-files:versions:manage',
    ],
  },
  {
    relations: publishers,
    actions: [
      'better-files:rooms:publish',
      'better-files:members:read',
      'better-files:members:invite',
    ],
  },
  {
    relations: admins,
    actions: [
      'better-files:admin',
      'better-files:rooms:update',
      'better-files:rooms:close',
      'better-files:rooms:reopen',
      'better-files:rooms:archive',
      'better-files:rooms:export',
      'better-files:members:remove',
      'better-files:members:manage',
      'better-files:permissions:read',
      'better-files:permissions:manage',
      'better-files:activity:read',
      'better-files:activity:export',
    ],
  },
  { relations: ['owner'], actions: ['better-files:rooms:delete'] },
  {
    relations: ['auditor'],
    actions: [
      'better-files:activity:read',
      'better-files:activity:export',
      'better-files:members:read',
    ],
  },
];
