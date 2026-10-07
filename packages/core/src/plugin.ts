import type { CapabilityDefinition, CapabilityRegistry } from './capabilities.js';
import type { AccessClamp } from './acl.js';
import type { BetterFilesErrorCode } from './errors.js';
import type { EnqueueOptions, JobDefinition, JobEnvelope } from './jobs.js';
import type { AccessGrant, OperationSpec } from './operations.js';
import type { Credential, DatabaseAdapter, Logger, Principal, StorageAdapter } from './ports.js';
import type { Fields, TableDefinition } from './schema.js';
import type { StandardSchemaV1 } from './validation.js';
import type { DataRoomDocument, DataRoomNode, DocumentVersion, Room } from './tables.js';

export interface ActivityInput {
  roomId: string;
  action: string;
  nodeId?: string;
  metadata?: Record<string, unknown>;
}

/** What endpoint handlers and hooks receive. */
export interface PluginContext {
  tenantId: string;
  principal: Principal;
  credential: Credential;
  /** The transaction the operation runs in (the plain adapter for read-only operations). */
  db: DatabaseAdapter;
  storage: StorageAdapter;
  now: number;
  logger: Logger;
  capabilities: CapabilityRegistry;
  /** The room the operation targets, loaded and authorized (room and node targets). */
  room?: Room;
  /** The folder or document the operation targets, loaded and authorized (node targets). */
  node?: DataRoomNode;
  /** The caller's effective capability masks (layer A) on nodes of the target room. */
  capabilitiesOf(
    nodes: readonly DataRoomNode[],
    /** Document rows already loaded (for document flags); only the missing ones are fetched. */
    options?: { documents?: ReadonlyMap<string, DataRoomDocument> },
  ): Promise<Map<string, number>>;
  /** Appends to the room's hash-chained activity log, inside the operation's transaction. */
  activity(event: ActivityInput): Promise<void>;
  /**
   * Emits an event to `dr.events` subscribers and webhooks once the transaction commits (and not at all if the
   * operation fails). `immediate` publishes right away, even when the operation is then refused: security signals.
   */
  emit(type: string, payload: Record<string, unknown>, options?: { immediate?: boolean }): void;
  /**
   * Runs after the transaction commits (identity-system writes, deliveries, background work). The callback gets a
   * context on the plain adapter: the operation's transaction is over by then. Failures are logged.
   */
  afterCommit(fn: (context: PluginContext) => Promise<void> | void): void;
  /**
   * Enqueues a durable job inside the operation's transaction: it exists only if the operation commits, and the runner
   * hears about it after the commit. `name` is `{pluginId}.{job}` (or a job the host registered). Prefer it to
   * `afterCommit` for work that must survive a crash or be retried.
   */
  enqueue(
    name: string,
    payload: Record<string, unknown>,
    options?: EnqueueOptions,
  ): Promise<JobEnvelope>;
  /** Client information from the request, when the protocol served it. */
  request?: { ip?: string; userAgent?: string };
  /** The decrypted content of a version of this tenant (scanners, converters, indexers). */
  readVersion(versionId: string): Promise<ReadableStream<Uint8Array>>;
  /**
   * Derived artifacts of a version (a PDF of an Office file, a thumbnail, extracted text), encrypted and stored like
   * the file and deleted with it. Conventional kinds: `pdf`, `thumbnail`, `text`. The plugin checks access.
   */
  renditions: {
    /** Stores (or replaces) a version's rendition of `kind`. */
    put(input: {
      versionId: string;
      kind: string;
      mimeType: string;
      content: Uint8Array;
      meta?: Record<string, unknown>;
    }): Promise<{ id: string; blobId: string }>;
    get(
      versionId: string,
      kind: string,
    ): Promise<
      | {
          id: string;
          mimeType: string;
          meta?: Record<string, unknown>;
          read(): Promise<ReadableStream<Uint8Array>>;
        }
      | undefined
    >;
  };
  /**
   * An identity-system decision for the caller: `authorize('better-files:qa:manage')` on the target room (or on
   * `resource`). False for public operations.
   */
  authorize(action: string, resource?: { type: string; id: string }): Promise<boolean>;
  /**
   * Calls another Better Files operation (`rooms.update`, `groups.create`, `tasks.create`) as the caller, through the
   * full pipeline: both authorization layers apply. Use it from handlers with `transaction: 'manual'` or that do not
   * mutate, since the call opens its own transaction.
   */
  call<O = unknown>(operation: string, input: Record<string, unknown>): Promise<O>;
  /**
   * Stores a file the plugin produced (a signed PDF, a converted copy) as a new document in `parentId`, or as a new
   * version of `versionOf`: encrypted and versioned like an upload, recorded as the caller's. The plugin decides who
   * may trigger it; no capability check happens here.
   */
  addDocument(input: {
    parentId?: string;
    versionOf?: string;
    filename: string;
    mimeType?: string;
    content: Uint8Array;
    comment?: string;
    /** Who the activity log records as the uploader, when not the caller (a public operation acting for someone). */
    actorId?: string;
  }): Promise<{ nodeId: string; versionId: string; sha256: string }>;
  /**
   * Issues a download or viewer ticket for a document version, after the plugin has done its own checks (share
   * links). `recipient` is who the copy is for (watermarks, activity); it defaults to the caller.
   */
  issueTicket(input: {
    documentId: string;
    versionId?: string;
    variant: DownloadVariant;
    disposition?: 'attachment' | 'inline';
    recipient?: { id: string; name?: string; email?: string };
  }): Promise<{ url: string; token: string; expiresAt: number }>;
}

/** An event delivered to `dr.events` subscribers, plugin `onEvent` hooks and webhooks. */
export interface BetterFilesEvent {
  id: string;
  /** `room.created`, `document.uploaded`, `member.invited`, … */
  type: string;
  tenantId: string;
  roomId?: string;
  actorId: string;
  occurredAt: number;
  data: Record<string, unknown>;
}

/** What `maintain` receives: periodic work outside any request. */
export interface MaintenanceContext {
  db: DatabaseAdapter;
  storage: StorageAdapter;
  now: number;
  logger: Logger;
  readVersion(tenantId: string, versionId: string): Promise<ReadableStream<Uint8Array>>;
  /** A tenant's renditions, as `PluginContext.renditions`. */
  renditions(tenantId: string): PluginContext['renditions'];
  /** Publishes an event to `dr.events` subscribers. */
  emit(event: {
    type: string;
    tenantId: string;
    roomId?: string;
    data: Record<string, unknown>;
  }): Promise<void>;
  /** Enqueues a durable job for a tenant (committed at once). */
  enqueue(
    tenantId: string,
    name: string,
    payload: Record<string, unknown>,
    options?: EnqueueOptions,
  ): Promise<JobEnvelope>;
}

export interface TargetRef {
  roomId?: string;
  nodeId?: string;
}

export interface EndpointDefinition<
  Input extends StandardSchemaV1 = StandardSchemaV1,
  Output = unknown,
  Context extends PluginContext = PluginContext,
> {
  /** Identity-system action (layer B) and, for node targets, the capabilities checked first (layer A). */
  operation: OperationSpec;
  input: Input;
  /** For room and node targets: which room or node the validated input addresses. May look records up. */
  target?(
    input: StandardSchemaV1.InferOutput<Input>,
    lookup: { db: DatabaseAdapter; tenantId: string },
  ): TargetRef | Promise<TargetRef>;
  handler(context: Context, input: StandardSchemaV1.InferOutput<Input>): Promise<Output>;
  /**
   * `auto` (default): mutating operations run in one transaction. `manual`: the handler gets the plain adapter and
   * opens its own transactions, for operations that interleave identity-system calls with database writes.
   */
  transaction?: 'auto' | 'manual';
  /** Node targets in the trash are refused unless this is set (restore operations). */
  includeDeleted?: boolean;
  /** What a caller the identity system refuses gets instead of FORBIDDEN (an empty list for list operations). */
  denied?(): Output;
}

/** Declares an endpoint while keeping its input and output types for `dr.api` and the client. */
export const endpoint = <Input extends StandardSchemaV1, Output>(
  definition: EndpointDefinition<Input, Output>,
): EndpointDefinition<Input, Output> => definition;

export interface HookInput {
  context: PluginContext;
  room: Room;
  node?: DataRoomNode;
}

export type DownloadVariant = 'original' | 'watermarked' | 'view' | (string & {});

export interface DownloadTransformInput extends HookInput {
  variant: DownloadVariant;
  document: DataRoomDocument;
  version: DocumentVersion;
  mimeType: string;
  /** The decrypted original. */
  stream: ReadableStream<Uint8Array>;
}

export interface DownloadTransform {
  stream: ReadableStream<Uint8Array>;
  mimeType?: string;
  filename?: string;
  size?: number;
}

export interface BetterFilesHooks {
  /** Runs inside the transaction before the change; throw a BetterFilesError to refuse it. */
  beforeUpload?(
    input: HookInput & { filename: string; size: number; mimeType?: string },
  ): Promise<void>;
  afterUpload?(input: HookInput & { versionId: string }): Promise<void>;
  beforeDownload?(input: HookInput & { variant: DownloadVariant }): Promise<void>;
  afterDownload?(input: HookInput & { variant: DownloadVariant }): Promise<void>;
  /**
   * Produces a variant of a document (a watermarked copy, viewer pages). The first hook that returns a result
   * serves it; a variant no hook produces is refused, so a watermarked download never falls back to the original.
   */
  transformDownload?(input: DownloadTransformInput): Promise<DownloadTransform | undefined>;
  beforePermissionChange?(input: HookInput & { changes: readonly unknown[] }): Promise<void>;
  onRoomStatusChange?(
    input: HookInput & { from: Room['status']; to: Room['status'] },
  ): Promise<void>;
  /** Removes capabilities after resolution (an NDA not yet accepted, a quarantined version). */
  clampCapabilities?(input: HookInput): Promise<readonly AccessClamp[]>;
  /**
   * Runs for every room and node operation once both authorization layers allowed it. Return a reason to refuse it
   * (`FORBIDDEN`), or a code and message (`NDA_REQUIRED`, `MFA_REQUIRED`): plugin room features behind an NDA.
   */
  gateRoom?(
    input: HookInput & { operation: OperationSpec },
  ): Promise<string | { code: BetterFilesErrorCode; message: string } | undefined>;
  /**
   * Legal holds and retention: return a reason to keep content, and deleting it (trash, trash purge, room deletion)
   * is refused. `nodeIds` are the items about to go; absent for the whole room.
   */
  retains?(input: {
    db: DatabaseAdapter;
    tenantId: string;
    roomId: string;
    nodeIds?: readonly string[];
  }): Promise<string | undefined>;
}

/**
 * A Better Files plugin. Unlike Better IAM plugins it may own tables, add fields to core tables, register capabilities
 * and expose typed endpoints: `dr.api[plugin.id][name]` on the server and the same path on the client.
 */
export interface BetterFilesPlugin<
  Id extends string = string,
  Endpoints extends Record<string, EndpointDefinition> = Record<string, EndpointDefinition>,
> {
  id: Id;
  schema?: Record<string, TableDefinition>;
  extendSchema?: Record<string, { additionalFields: Fields }>;
  capabilities?: Record<string, CapabilityDefinition>;
  /** Identity-system actions this plugin authorizes; all must be in the `better-files:` namespace. */
  actions?: readonly string[];
  /** Which room relations may perform the plugin's actions; merged into the identity system's access model. */
  accessModel?: readonly AccessGrant[];
  endpoints?: Endpoints;
  hooks?: BetterFilesHooks;
  /** Plugins this one needs, by id. */
  dependsOn?: readonly string[];
  /** Validates configuration once, when `betterFiles()` builds the instance. */
  init?(context: { plugins: readonly BetterFilesPlugin[] }): void;
  /** Periodic work, called from `dr.maintain()`. */
  maintain?(context: MaintenanceContext): Promise<void>;
  /** Durable background jobs, enqueued as `{id}.{name}` with `context.enqueue`. */
  jobs?: Record<string, JobDefinition<never>>;
  /** Every event after it is published (webhooks, notifications, search indexing). Errors are logged. */
  onEvent?(event: BetterFilesEvent, context: MaintenanceContext): Promise<void>;
}

/**
 * Declares a plugin while keeping its literal type — id, endpoint inputs and outputs, and additional fields — so
 * `dr.api`, the client and `dr.$Infer` can see them.
 */
export const definePlugin = <const P extends BetterFilesPlugin>(plugin: P): P => plugin;
