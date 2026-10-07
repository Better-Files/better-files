import type { ResolvedSchema } from './schema.js';

// ─── Database ────────────────────────────────────────────────────────────────────────────────────

export type Comparable = string | number | boolean | null;
export type FieldFilter =
  | Comparable
  | {
      eq?: Comparable;
      ne?: Comparable;
      in?: readonly Comparable[];
      notIn?: readonly Comparable[];
      lt?: number | string;
      lte?: number | string;
      gt?: number | string;
      gte?: number | string;
      /** true: the field is absent or null; false: it has a value. */
      isNull?: boolean;
      /** Case-insensitive substring match on a string field. */
      contains?: string;
    };
/** Conditions are ANDed. A plain value means equality. */
export type Where = Record<string, FieldFilter>;

export interface FindManyOptions {
  where?: Where;
  orderBy?: readonly { field: string; direction?: 'asc' | 'desc' }[];
  limit?: number;
  offset?: number;
}

export interface MigrationResult {
  /** Tables created or altered, by logical model name. */
  applied: string[];
}

/**
 * Storage for Better Files' own tables. Adapters receive logical model and field names (`aclEntries.nodeId`) and map
 * them to the physical names in the resolved schema. Every write happens inside `transaction`; nested calls join the
 * outer transaction. Adapters must pass `databaseConformanceCases()` from `@better-files/core/conformance`.
 */
export interface DatabaseAdapter {
  readonly id: string;
  /** Called once by `betterFiles()` before anything else. */
  bind?(schema: ResolvedSchema): void;
  /** Creates or upgrades tables so they match the schema. Idempotent. */
  migrate(schema: ResolvedSchema): Promise<MigrationResult>;
  findOne<T>(model: string, where: Where): Promise<T | null>;
  findMany<T>(model: string, options?: FindManyOptions): Promise<T[]>;
  count(model: string, where?: Where): Promise<number>;
  /** Fails with CONFLICT when a unique field or index would be violated. */
  insert<T extends object>(model: string, record: T): Promise<T>;
  /** Returns how many rows changed. `id` and `tenantId` cannot change. */
  update(model: string, where: Where, patch: Record<string, unknown>): Promise<number>;
  /**
   * Atomically adds `by` to a numeric field of the one row matching `where` and returns the new value (null when no
   * row matches). Holds the row until the transaction ends, so concurrent callers get distinct values: this is how
   * activity sequences and version numbers stay gap-free under PostgreSQL's READ COMMITTED.
   */
  increment(model: string, where: Where, field: string, by?: number): Promise<number | null>;
  delete(model: string, where: Where): Promise<number>;
  transaction<R>(fn: (tx: DatabaseAdapter) => Promise<R>): Promise<R>;
  close?(): Promise<void>;
}

// ─── Storage ─────────────────────────────────────────────────────────────────────────────────────

export type ByteSource = Uint8Array | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;

export interface StoredObject {
  key: string;
  size: number;
  etag?: string;
}

export interface StorageAdapter {
  readonly id: string;
  put(key: string, body: ByteSource, options?: { contentLength?: number }): Promise<StoredObject>;
  /** `range.end` is inclusive, as in HTTP Range. */
  get(key: string, range?: { start: number; end?: number }): Promise<ReadableStream<Uint8Array>>;
  head(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
  copy?(from: string, to: string): Promise<StoredObject>;
  multipart?: MultipartStorage;
  presign?(
    key: string,
    options: { method: 'GET' | 'PUT'; expiresInSeconds: number; contentType?: string },
  ): Promise<string>;
  /**
   * Data residency: the regions this storage can place rooms in (`regionalStorage` from
   * `@better-files/storage-regional`). When set, rooms get a region at creation and their files' keys start
   * with `g/{region}/`, so the adapter routes every object without looking anything up.
   */
  readonly residency?: StorageResidency;
}

export interface StorageResidency {
  readonly regions: readonly string[];
  /** The region rooms get when creation names none. */
  readonly defaultRegion: string | ((input: { tenantId: string }) => string | Promise<string>);
  /** Whether a tenant may place rooms in a region (contractual residency). Default: every region. */
  allows?(input: { tenantId: string; region: string }): boolean | Promise<boolean>;
}

/** The key prefix that places an object in a region (`g/eu/`). */
export const regionKeyPrefix = (region: string) => `g/${region}/`;

export interface MultipartStorage {
  create(key: string): Promise<{ uploadId: string }>;
  uploadPart(
    key: string,
    uploadId: string,
    part: number,
    body: ByteSource,
  ): Promise<{ etag: string }>;
  complete(
    key: string,
    uploadId: string,
    parts: { part: number; etag: string }[],
  ): Promise<StoredObject>;
  abort(key: string, uploadId: string): Promise<void>;
  /** A URL a client can PUT one part to directly (direct uploads). Optional. */
  presignPart?(
    key: string,
    uploadId: string,
    part: number,
    options: { expiresInSeconds: number },
  ): Promise<string>;
}

// ─── Identity and authorization ──────────────────────────────────────────────────────────────────

/** What callers pass to `dr.api.*`: request headers (cookies or bearer) or a token, as Better IAM accepts. */
export interface Credential {
  headers?: HeadersInit;
  token?: string;
}

/** The authenticated caller, normalized from the identity system. */
export interface Principal {
  id: string;
  tenantId: string;
  kind: 'user' | 'service' | 'agent';
  name?: string;
  email?: string;
  /** Identity-system groups the principal belongs to in this tenant; room permission groups map onto these. */
  groups: readonly string[];
  guest: boolean;
  mfa: boolean;
  sessionId?: string;
}

export interface IdentityProvider {
  /** Throws UNAUTHENTICATED when the credential is missing or invalid, FORBIDDEN when it is for another tenant. */
  authenticate(credential: Credential, tenantId: string): Promise<Principal>;
}

export interface AuthorizationCheck {
  action: string;
  resource: { type: string; id: string };
}

export interface AuthorizationDecision {
  allowed: boolean;
  reason: string;
}

export interface AuthzProvider {
  authorize(
    credential: Credential,
    request: AuthorizationCheck & { tenantId: string },
  ): Promise<AuthorizationDecision>;
  /** Advisory batch for rendering; enforcement always goes through `authorize`. */
  authorizeMany(
    credential: Credential,
    request: { tenantId: string; checks: readonly AuthorizationCheck[] },
  ): Promise<AuthorizationDecision[]>;
  /** Ids of the registered resources of `type` the caller may perform `action` on (room lists). */
  listAccessible?(
    credential: Credential,
    request: { tenantId: string; action: string; type: string },
  ): Promise<string[]>;
}

/** Who performs an identity-system write: always after Better Files has authorized the caller. */
export interface DirectoryCall {
  tenantId: string;
  /** The caller's credential; integrations use it or their own system credential. */
  credential: Credential;
  /** The authenticated caller, for sponsorship and audit metadata. */
  actorId: string;
}

export interface RoomRoleGrant {
  id: string;
  relation: string;
  subjectType: 'identity' | 'group';
  subjectId: string;
  expiresAt?: number;
}

/**
 * The identity-system writes that room administration needs: rooms as registered resources, room roles as
 * relationship tuples, permission groups as identity-system groups, and guest invitations. All methods are
 * idempotent where the identity system allows it.
 */
export interface IamDirectory {
  registerRoom(
    call: DirectoryCall,
    input: {
      roomId: string;
      ownerId: string;
      attributes: Record<string, string | number | boolean>;
    },
  ): Promise<void>;
  updateRoom(
    call: DirectoryCall,
    input: { roomId: string; attributes: Record<string, string | number | boolean> },
  ): Promise<void>;
  deleteRoom(call: DirectoryCall, input: { roomId: string }): Promise<void>;
  grantRoomRole(
    call: DirectoryCall,
    input: {
      roomId: string;
      relation: string;
      subjectType: 'identity' | 'group';
      subjectId: string;
      expiresAt?: number;
    },
  ): Promise<RoomRoleGrant>;
  revokeRoomRole(call: DirectoryCall, input: { relationshipId: string }): Promise<void>;
  listRoomRoles(call: DirectoryCall, input: { roomId: string }): Promise<RoomRoleGrant[]>;
  createGroup(
    call: DirectoryCall,
    input: { name: string; description?: string },
  ): Promise<{ id: string }>;
  deleteGroup(call: DirectoryCall, input: { groupId: string }): Promise<void>;
  addGroupMember(
    call: DirectoryCall,
    input: { groupId: string; identityId: string; expiresAt?: number },
  ): Promise<void>;
  removeGroupMember(
    call: DirectoryCall,
    input: { groupId: string; identityId: string },
  ): Promise<void>;
  /** Groups the identity belongs to (for "explain" and administration, not for authentication). */
  groupsOf(call: DirectoryCall, input: { identityId: string }): Promise<string[]>;
  findIdentityByEmail(
    call: DirectoryCall,
    input: { email: string },
  ): Promise<{ id: string; name?: string; guest: boolean } | undefined>;
  /** Invites someone from outside the organization into the given groups; they authenticate as `guest`. */
  inviteGuest(
    call: DirectoryCall,
    input: {
      email: string;
      groupIds: readonly string[];
      accessDays?: number;
      message?: string;
      sponsorId: string;
    },
  ): Promise<{ invitationId: string }>;
  /** Withdraws an invitation nobody redeemed yet, so its link stops working. Already used or gone is not an error. */
  revokeInvitation?(call: DirectoryCall, input: { invitationId: string }): Promise<void>;
}

// ─── Keys, audit, delivery ───────────────────────────────────────────────────────────────────────

export type EncryptionContext = Record<string, string>;

export interface KeyProvider {
  readonly id: string;
  /** Creates a key for one room, so deleting the room can destroy its data (crypto-shredding). Optional. */
  createRoomKey?(input: {
    tenantId: string;
    roomId: string;
    /** The room's data-residency region, so a provider can create the key in that region's KMS. */
    region?: string;
  }): Promise<string>;
  /** Schedules the room key's destruction. Optional. */
  retireRoomKey?(input: { tenantId: string; roomId: string; keyRef: string }): Promise<void>;
  /** A fresh data key and its wrapped form. The plaintext must never be stored. */
  generateDataKey(input: {
    tenantId: string;
    keyRef?: string;
    context: EncryptionContext;
  }): Promise<{ plaintext: Uint8Array; wrapped: string; keyRef: string }>;
  decryptDataKey(input: {
    tenantId: string;
    keyRef: string;
    wrapped: string;
    context: EncryptionContext;
  }): Promise<Uint8Array>;
}

export interface SecurityAuditEvent {
  tenantId: string;
  actorId: string;
  action: string;
  resource: { type: string; id: string };
  outcome: 'allow' | 'deny';
  metadata?: Record<string, string | number | boolean | null>;
}

/** Security-relevant events (permission changes, original downloads, exports) go to the identity system's audit log. */
export interface AuditSink {
  record(event: SecurityAuditEvent): Promise<void>;
}

/** Everything Better Files needs from an identity system. `betterIamIntegration(iam)` returns one. */
export interface IamIntegration {
  readonly id: string;
  identity: IdentityProvider;
  authz: AuthzProvider;
  /** Needed for room, member and group administration; without it those operations report UNSUPPORTED. */
  directory?: IamDirectory;
  keys?: KeyProvider;
  audit?: AuditSink;
  /** Called by `betterFiles()` so the integration can check its own wiring (plugin registered, resolver composed). */
  validate?(context: { plugins: readonly { id: string; actions?: readonly string[] }[] }): void;
}

export interface Clock {
  now(): number;
}
export const systemClock: Clock = { now: () => Date.now() };

export interface Logger {
  debug?(message: string, data?: Record<string, unknown>): void;
  info?(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}
