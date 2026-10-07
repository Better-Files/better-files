import { defineTable, field, type BaseRecord, type InferFields } from './schema.js';

export const roomStatuses = ['provisioning', 'draft', 'live', 'closed', 'archived'] as const;
export type RoomStatus = (typeof roomStatuses)[number];

export const versionStatuses = [
  'uploading',
  'quarantined',
  'processing',
  'ready',
  'failed',
  'rejected',
] as const;
export type VersionStatus = (typeof versionStatuses)[number];

export interface RoomSettings {
  downloadsEnabled?: boolean;
  printEnabled?: boolean;
  requireMfaForDownload?: boolean;
  /** Listing requires LIST on every ancestor (default true). */
  requireAncestorList?: boolean;
  /** Days deleted items stay in the trash before `maintain()` purges them. Default 30. */
  trashRetentionDays?: number;
  classification?: string;
}

export interface DocumentFlags {
  viewOnly?: boolean;
  noPrint?: boolean;
  noCopy?: boolean;
}

export interface BlobEncryption {
  algorithm: 'AES-256-GCM-STREAM';
  segmentSize: number;
  /** Base64url nonce prefix, unique per blob. */
  noncePrefix: string;
}

/** The tables every installation has. Plugins add their own; hosts add fields with `schema.{table}.additionalFields`. */
export const coreTables = {
  rooms: defineTable({
    fields: {
      name: field.string(),
      slug: field.string(),
      description: field.string({ required: false }),
      status: field.enum(roomStatuses),
      ownerId: field.string(),
      rootNodeId: field.string(),
      settings: field.json<RoomSettings>(),
      /** The key provider's key for this room (a Better IAM KMS key id), when keys are per room. */
      kmsKeyId: field.string({ required: false }),
      /** Data residency: the storage region holding the room's files. Set at creation (`StorageAdapter.residency`). */
      region: field.string({ required: false }),
      closesAt: field.timestamp({ required: false }),
      /** Head of the room's activity hash chain. */
      activitySequence: field.number(),
      activityHash: field.string({ required: false }),
      updatedAt: field.timestamp(),
    },
    indexes: [{ fields: ['tenantId', 'slug'], unique: true }],
  }),
  nodes: defineTable({
    fields: {
      roomId: field.string(),
      parentId: field.string({ required: false }),
      kind: field.enum(['folder', 'document'] as const),
      name: field.string(),
      /** Lower-cased name, for sibling uniqueness. */
      nameKey: field.string(),
      sortKey: field.number(),
      createdBy: field.string(),
      deletedAt: field.timestamp({ required: false }),
      /** The node whose deletion trashed this one (itself for the top of a deleted subtree). */
      deletedWith: field.string({ required: false }),
      updatedAt: field.timestamp(),
    },
    indexes: [{ fields: ['tenantId', 'roomId', 'parentId'] }],
  }),
  /** Every ancestor/descendant pair, including each node with itself at depth 0. */
  nodeClosure: defineTable({
    fields: {
      roomId: field.string(),
      ancestorId: field.string(),
      descendantId: field.string(),
      depth: field.number(),
    },
    indexes: [
      { fields: ['tenantId', 'descendantId'] },
      { fields: ['tenantId', 'ancestorId', 'descendantId'], unique: true },
    ],
  }),
  /** One row per document node; `id` is the node id. */
  documents: defineTable({
    fields: {
      roomId: field.string(),
      currentVersionId: field.string({ required: false }),
      latestVersion: field.number(),
      mimeType: field.string({ required: false }),
      size: field.number(),
      pageCount: field.number({ required: false }),
      flags: field.json<DocumentFlags>(),
      checkedOutBy: field.string({ required: false }),
      checkedOutAt: field.timestamp({ required: false }),
    },
  }),
  versions: defineTable({
    fields: {
      roomId: field.string(),
      documentId: field.string(),
      number: field.number(),
      blobId: field.string({ required: false }),
      status: field.enum(versionStatuses),
      filename: field.string(),
      mimeType: field.string({ required: false }),
      sha256: field.string({ required: false }),
      size: field.number(),
      uploadedBy: field.string(),
      comment: field.string({ required: false }),
    },
    indexes: [{ fields: ['tenantId', 'documentId', 'number'], unique: true }],
  }),
  blobs: defineTable({
    fields: {
      roomId: field.string(),
      size: field.number(),
      /** Size in storage: larger than `size` when encrypted (16 bytes per segment). */
      storedSize: field.number(),
      storageKey: field.string(),
      /** The data key wrapped by the key provider; absent only when encryption is off. */
      wrappedKey: field.string({ required: false }),
      keyRef: field.string({ required: false }),
      encryption: field.json<BlobEncryption>({ required: false }),
    },
  }),
  /** Derived artifacts of a version: PDFs, page images, text. */
  renditions: defineTable({
    fields: {
      roomId: field.string(),
      versionId: field.string(),
      kind: field.string(),
      blobId: field.string(),
      mimeType: field.string(),
      meta: field.json<Record<string, unknown>>({ required: false }),
    },
    indexes: [{ fields: ['tenantId', 'versionId', 'kind'], unique: true }],
  }),
  uploads: defineTable({
    fields: {
      roomId: field.string(),
      /** The folder a new document goes into, or the document a new version belongs to. */
      targetId: field.string(),
      mode: field.enum(['document', 'version'] as const),
      filename: field.string(),
      mimeType: field.string({ required: false }),
      size: field.number(),
      sha256: field.string({ required: false }),
      /** SHA-256 of what was received, computed by the server. */
      receivedSha256: field.string({ required: false }),
      comment: field.string({ required: false }),
      blobId: field.string(),
      storageKey: field.string(),
      multipartId: field.string({ required: false }),
      partSize: field.number(),
      status: field.enum(['pending', 'uploaded', 'completed', 'aborted'] as const),
      createdBy: field.string(),
      expiresAt: field.timestamp(),
    },
    indexes: [{ fields: ['tenantId', 'status'] }],
  }),
  uploadParts: defineTable({
    fields: {
      uploadId: field.string(),
      part: field.number(),
      etag: field.string(),
      size: field.number(),
    },
    indexes: [{ fields: ['tenantId', 'uploadId', 'part'], unique: true }],
  }),
  permissionGroups: defineTable({
    fields: {
      roomId: field.string(),
      name: field.string(),
      nameKey: field.string(),
      description: field.string({ required: false }),
      iamGroupId: field.string(),
      /** The room relation the group holds in the identity system (`viewer` by default). */
      relation: field.string(),
      relationshipId: field.string({ required: false }),
      kind: field.enum(['internal', 'external', 'auditor'] as const),
      expiresAt: field.timestamp({ required: false }),
    },
    indexes: [
      { fields: ['tenantId', 'roomId', 'nameKey'], unique: true },
      { fields: ['tenantId', 'iamGroupId'] },
    ],
  }),
  aclEntries: defineTable({
    fields: {
      roomId: field.string(),
      nodeId: field.string(),
      subjectType: field.enum(['identity', 'group', 'link'] as const),
      subjectId: field.string(),
      mask: field.number(),
      locked: field.boolean(),
      expiresAt: field.timestamp({ required: false }),
      grantedBy: field.string(),
    },
    indexes: [
      { fields: ['tenantId', 'nodeId', 'subjectType', 'subjectId'], unique: true },
      { fields: ['tenantId', 'roomId'] },
    ],
  }),
  /** Room participants. Better IAM relationship tuples and groups are authoritative; this is the room's roster. */
  members: defineTable({
    fields: {
      roomId: field.string(),
      identityId: field.string({ required: false }),
      email: field.string({ required: false }),
      /** `expired`: the access window (`expiresAt`) passed; the identity system already enforces it. */
      status: field.enum(['invited', 'active', 'suspended', 'removed', 'expired'] as const),
      /** Direct room relation held by the identity (owner, admin, auditor, …), if any. */
      relation: field.string({ required: false }),
      relationshipId: field.string({ required: false }),
      groupIds: field.json<string[]>(),
      guest: field.boolean(),
      invitationId: field.string({ required: false }),
      invitedBy: field.string({ required: false }),
      expiresAt: field.timestamp({ required: false }),
      lastSeenAt: field.timestamp({ required: false }),
      updatedAt: field.timestamp(),
    },
    indexes: [
      { fields: ['tenantId', 'roomId', 'identityId'], unique: true },
      { fields: ['tenantId', 'roomId', 'email'], unique: true },
    ],
  }),
  /** Per-room hash-chained engagement log. */
  activity: defineTable({
    fields: {
      roomId: field.string(),
      sequence: field.number(),
      actorId: field.string(),
      action: field.string(),
      nodeId: field.string({ required: false }),
      metadata: field.json<Record<string, unknown>>({ required: false }),
      ip: field.string({ required: false }),
      userAgent: field.string({ required: false }),
      previousHash: field.string({ required: false }),
      hash: field.string(),
    },
    indexes: [{ fields: ['tenantId', 'roomId', 'sequence'], unique: true }],
  }),
  /** Download and viewer tickets: short-lived, use-limited, revocable. */
  tickets: defineTable({
    fields: {
      roomId: field.string(),
      principalId: field.string(),
      documentId: field.string(),
      versionId: field.string(),
      variant: field.string(),
      disposition: field.enum(['attachment', 'inline'] as const),
      uses: field.number(),
      maxUses: field.number(),
      /** Who the ticket was issued to, for watermarks and activity (name, email, ip). */
      meta: field.json<Record<string, string>>({ required: false }),
      expiresAt: field.timestamp(),
    },
    indexes: [{ fields: ['expiresAt'] }],
  }),
  /** Room exports: what one person may take away, captured when they asked; served through a ticket. */
  exports: defineTable({
    fields: {
      roomId: field.string(),
      principalId: field.string(),
      items:
        field.json<
          { path: string; versionId: string; size: number; sha256?: string; nodeId?: string }[]
        >(),
      excluded: field.number(),
      includeActivity: field.boolean(),
      /** Folder downloads: the folder they were made from (absent for whole-room exports). */
      folderId: field.string({ required: false }),
      /** `original` (default) or `watermarked`: each file stamped for the requester as it is zipped. */
      variant: field.string({ required: false }),
      /** Download file name. */
      label: field.string({ required: false }),
      expiresAt: field.timestamp(),
    },
  }),
  outbox: defineTable({
    fields: {
      kind: field.string(),
      payload: field.json<Record<string, unknown>>(),
      idempotencyKey: field.string({ unique: true }),
      attempts: field.number(),
      nextAttemptAt: field.timestamp(),
      deliveredAt: field.timestamp({ required: false }),
      lastError: field.string({ required: false }),
    },
    indexes: [{ fields: ['deliveredAt', 'nextAttemptAt'] }],
  }),
  /** Durable background jobs (`context.enqueue`, `dr.jobs`). */
  jobs: defineTable({
    fields: {
      name: field.string(),
      payload: field.json<Record<string, unknown>>(),
      status: field.enum(['pending', 'running', 'completed', 'failed', 'cancelled'] as const),
      /** Attempts started so far. */
      attempts: field.number(),
      maxAttempts: field.number(),
      runAt: field.timestamp(),
      /** Until when the current attempt holds the job; 0 when no worker does. */
      leaseUntil: field.number(),
      /** Deduplication key (`EnqueueOptions.key`). */
      key: field.string({ required: false }),
      lastError: field.string({ required: false }),
      finishedAt: field.timestamp({ required: false }),
      updatedAt: field.timestamp(),
    },
    indexes: [{ fields: ['status', 'runAt'] }, { fields: ['tenantId', 'name', 'key'] }],
  }),
};

export type CoreTables = typeof coreTables;
export type CoreModel = keyof CoreTables;
export type CoreRecord<M extends CoreModel> = BaseRecord & InferFields<CoreTables[M]['fields']>;

export type Room = CoreRecord<'rooms'>;
export type DataRoomNode = CoreRecord<'nodes'>;
export type NodeClosure = CoreRecord<'nodeClosure'>;
export type DataRoomDocument = CoreRecord<'documents'>;
export type DocumentVersion = CoreRecord<'versions'>;
export type BlobRecord = CoreRecord<'blobs'>;
export type Rendition = CoreRecord<'renditions'>;
export type Upload = CoreRecord<'uploads'>;
export type UploadPart = CoreRecord<'uploadParts'>;
export type PermissionGroup = CoreRecord<'permissionGroups'>;
export type AclEntry = CoreRecord<'aclEntries'>;
export type Member = CoreRecord<'members'>;
export type ActivityRecord = CoreRecord<'activity'>;
export type Ticket = CoreRecord<'tickets'>;
export type RoomExport = CoreRecord<'exports'>;
export type OutboxRecord = CoreRecord<'outbox'>;
export type JobRecord = CoreRecord<'jobs'>;
