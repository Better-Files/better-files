import {
  Capability,
  coreTables,
  createCapabilityRegistry,
  BetterFilesError,
  hasAll,
  invalidConfig,
  isBetterFilesAction,
  notFound,
  resolveSchema,
  resourceTypes,
  systemClock,
  type CapabilityDefinition,
  type CapabilityRegistry,
  type Credential,
  type DataRoomNode,
  type BetterFilesHooks,
  type BetterFilesPlugin,
  type Logger,
  type MaintenanceContext,
  type Member,
  type MigrationResult,
  type ResolvedSchema,
  type Room,
  type SchemaSource,
  type Ticket,
  type Upload,
} from '@better-files/core';
import { SEGMENT_SIZE, tokenSigner } from '@better-files/crypto';
import { createAccessEngine } from './access.js';
import { verifyActivity, type ChainVerification } from './activity.js';
import { defaultLimits, type Engine } from './engine.js';
import { coreEndpoints, detach, discardUpload, transition } from './endpoints/index.js';
import { createEventBus, type BetterFilesEvent, type EventHandler } from './events.js';
import { createFiles } from './files.js';
import { createHttp, type ApiTable } from './http.js';
import { createJobs, jobDefinitions, type Jobs } from './jobs.js';
import { openApiDocument, type OpenApiDocument, type OpenApiOptions } from './openapi.js';
import { renditionStore } from './renditions.js';
import { createActivityStream, type StreamOptions } from './stream.js';
import type { InferApi, InferTypes } from './infer.js';
import type { BetterFilesOptions } from './options.js';
import {
  assertWritable,
  createContext,
  loadNode,
  loadRoom,
  runEndpoint,
  type AnyEndpoint,
  type RequestInfo,
} from './pipeline.js';

export type { BetterFilesOptions, SchemaOptions } from './options.js';
export type { InferApi, InferRecord, InferTypes, CoreApi, EndpointCall } from './infer.js';
export type { BetterFilesEvent, EventHandler } from './events.js';
export type { CoreContext, Engine, EngineLimits } from './engine.js';
export type { NodeView, RoomView } from './endpoints/index.js';
export type { ChainVerification } from './activity.js';
export type { OpenApiDocument, OpenApiOptions } from './openapi.js';
export type { StreamOptions } from './stream.js';
export type { Jobs, JobsOptions } from './jobs.js';
export { createAccessEngine, roomClamps, documentClamps, type AccessEngine } from './access.js';
export { coreEndpoints } from './endpoints/index.js';
export { canonicalJson, activityHash } from './activity.js';
export { numberTree } from './tree.js';

/** What `betterFilesResolver` needs to describe folders and documents to the identity system. */
export interface IamResourceResolution {
  tenantId: string;
  type: string;
  id: string;
  attributes: Record<string, string | number | boolean>;
}

export interface BetterFiles<O extends BetterFilesOptions = BetterFilesOptions> {
  readonly options: O;
  readonly schema: ResolvedSchema;
  readonly capabilities: CapabilityRegistry;
  readonly plugins: readonly BetterFilesPlugin[];
  /** Server-side calls: `dr.api[group][method](credential, { tenantId, ... })`. */
  readonly api: InferApi<O>;
  /** Fetch handler for the mounted protocol; pass the client address when the framework knows it. */
  handler(request: Request, info?: { ip?: string }): Promise<Response>;
  /** Node `http` handler for the same protocol. */
  nodeHandler: ReturnType<typeof createHttp>['nodeHandler'];
  /** Streaming file operations, for hosts that route them themselves. */
  /**
   * A room's activity as Server-Sent Events (also served at `GET {basePath}/rooms/{roomId}/events`). Entries carry
   * their activity sequence as the event id, so clients resume with `Last-Event-ID`.
   */
  stream(credential: Credential, options: StreamOptions): Promise<Response>;
  readonly files: {
    /** Receives a whole file (`part` omitted) or one part of an upload session created with `uploads.create`. */
    upload(
      credential: Credential,
      input: {
        tenantId: string;
        uploadId: string;
        part?: number;
        body: ReadableStream<Uint8Array> | Uint8Array;
      },
      request?: RequestInfo,
    ): Promise<{ uploadId: string; received: number; part?: number }>;
    /** Serves a download or viewer ticket; the response streams. */
    serve(token: string, request?: { method?: string; range?: string | null }): Promise<Response>;
  };
  readonly events: {
    /** `dr.events.subscribe('document.*', handler)`; returns an unsubscribe function. */
    subscribe(patterns: string | readonly string[], handler: EventHandler): () => void;
  };
  /** Effective capability masks for nodes of one room (layer A only; advisory for rendering). */
  capabilitiesFor(
    credential: Credential,
    input: { tenantId: string; roomId: string; nodeIds: readonly string[] },
  ): Promise<Record<string, string[]>>;
  /** Describes a folder or document for the identity system's policy engine; used by `betterFilesResolver`. */
  resolveForIam(reference: {
    tenantId: string;
    type: string;
    id: string;
  }): Promise<IamResourceResolution | undefined>;
  /** Recomputes a room's activity hash chain. */
  verifyActivity(input: { tenantId: string; roomId: string }): Promise<ChainVerification>;
  /** An OpenAPI 3.1 document for the mounted protocol, including plugin operations. */
  openapi(options?: OpenApiOptions): OpenApiDocument;
  /** Creates or upgrades Better Files tables. Run it at deploy time, like `iam.initialize()`. */
  initialize(): Promise<MigrationResult>;
  /** Periodic work: expired tickets and uploads, trash retention, plugin sweeps. Schedule it every few minutes. */
  maintain(): Promise<{
    tickets: number;
    uploads: number;
    purged: number;
    /** Rooms closed because their `closesAt` passed. */
    closed: number;
    /** Members whose access window ended. */
    expiredMembers: number;
    /** Jobs run because their runner had not (a crashed process, a lost queue message, the deferred runner). */
    jobs: number;
  }>;
  /** Durable background jobs: `work()` for deferred runners, `run(id)` for queue consumers, inspection and retry. */
  readonly jobs: Jobs;
  /** Stops the job runner (waiting for inline jobs in progress) and closes the database adapter. */
  close(): Promise<void>;
  /** Type helpers: `typeof dr.$Infer.Room` includes additional fields. */
  readonly $Infer: InferTypes<O>;
}

const pluginId = /^[a-z][a-zA-Z0-9-]{0,47}$/;
const endpointName = /^[a-z][a-zA-Z0-9]{0,63}$/;
// Path segments the protocol serves itself. (`viewer` belongs to @better-files/viewer's plugin.)
const coreGroupNames = [...Object.keys(coreEndpoints), 'files', 'health', 'downloads'];

function validatePlugins(plugins: readonly BetterFilesPlugin[]) {
  const ids = new Set<string>();
  for (const plugin of plugins) {
    if (!pluginId.test(plugin.id)) throw invalidConfig(`Invalid plugin id ${plugin.id}`);
    if (ids.has(plugin.id)) throw invalidConfig(`Plugin ${plugin.id} is registered more than once`);
    if (coreGroupNames.includes(plugin.id))
      throw invalidConfig(`Plugin id ${plugin.id} is reserved for the core API`);
    ids.add(plugin.id);
    for (const action of plugin.actions ?? [])
      if (!isBetterFilesAction(action))
        throw invalidConfig(
          `Plugin ${plugin.id}: action ${action} must be in the better-files: namespace`,
        );
    for (const [name, endpoint] of Object.entries(plugin.endpoints ?? {})) {
      if (!endpointName.test(name))
        throw invalidConfig(`Plugin ${plugin.id}: invalid endpoint ${name}`);
      if (!isBetterFilesAction(endpoint.operation.action))
        throw invalidConfig(`Plugin ${plugin.id}: endpoint ${name} needs a better-files: action`);
      if (
        endpoint.operation.target !== 'tenant' &&
        endpoint.operation.target !== 'public' &&
        !endpoint.target
      )
        throw invalidConfig(
          `Plugin ${plugin.id}: endpoint ${name} targets a ${endpoint.operation.target} but has no target()`,
        );
    }
  }
  for (const plugin of plugins)
    for (const dependency of plugin.dependsOn ?? [])
      if (!ids.has(dependency))
        throw invalidConfig(`Plugin ${plugin.id} needs plugin ${dependency}`);
}

/**
 * Creates a Better Files instance. Nothing touches the database until `initialize()` or the first call.
 *
 * ```ts
 * export const dr = betterFiles({ iam: betterIamIntegration(iam), database, storage, secret, plugins: [] });
 * ```
 */
export function betterFiles<const O extends BetterFilesOptions>(options: O): BetterFiles<O> {
  if (!options.iam?.identity || !options.iam.authz)
    throw invalidConfig(
      'betterFiles() needs an identity integration: iam: betterIamIntegration(iam)',
    );
  if (!options.database) throw invalidConfig('betterFiles() needs a database adapter');
  if (!options.storage) throw invalidConfig('betterFiles() needs a storage adapter');
  if (typeof options.secret !== 'string' || options.secret.length < 32)
    throw invalidConfig('betterFiles() needs a secret of at least 32 characters');
  const keys =
    options.encryption === false ? undefined : (options.encryption?.keys ?? options.iam.keys);
  if (options.encryption !== false && !keys)
    throw invalidConfig(
      'Configure encryption: { keys } (localKeyProvider, betterIamKeys or a cloud KMS), or encryption: false for development',
    );
  const plugins = [...(options.plugins ?? [])];
  validatePlugins(plugins);
  for (const plugin of plugins) plugin.init?.({ plugins });
  options.iam.validate?.({ plugins });

  const limits = { ...defaultLimits, ...options.limits };
  if (limits.partSize % SEGMENT_SIZE !== 0 || limits.partSize < SEGMENT_SIZE)
    throw invalidConfig(
      `limits.partSize must be a positive multiple of ${SEGMENT_SIZE} bytes (S3 needs at least 5 MiB)`,
    );

  const { tablePrefix, ...tableOptions } = options.schema ?? {};
  const sources: SchemaSource[] = [
    { source: 'core', tables: coreTables },
    ...plugins.map((plugin) => ({
      source: plugin.id,
      ...(plugin.schema ? { tables: plugin.schema } : {}),
      ...(plugin.extendSchema ? { extend: plugin.extendSchema } : {}),
    })),
  ];
  const schema = resolveSchema(sources, {
    ...(tablePrefix === undefined ? {} : { tablePrefix }),
    tables: tableOptions,
  });
  options.database.bind?.(schema);

  const extensions: Record<string, CapabilityDefinition> = { ...options.capabilities?.extensions };
  for (const plugin of plugins)
    for (const [name, definition] of Object.entries(plugin.capabilities ?? {})) {
      if (extensions[name]) throw invalidConfig(`Capability ${name} is declared more than once`);
      extensions[name] = definition;
    }
  const capabilities = createCapabilityRegistry({
    extensions,
    ...(options.capabilities?.presets ? { presets: options.capabilities.presets } : {}),
  });

  const clock = options.clock ?? systemClock;
  const logger: Logger = options.logger ?? console;
  const hooks: BetterFilesHooks[] = [
    ...plugins.flatMap((plugin) => (plugin.hooks ? [plugin.hooks] : [])),
    ...(options.hooks ? [options.hooks] : []),
  ];
  const engine = {
    options,
    schema,
    db: options.database,
    storage: options.storage,
    iam: options.iam,
    keys,
    capabilities,
    access: createAccessEngine({ iam: options.iam, capabilities, hooks, now: () => clock.now() }),
    clock,
    logger,
    hooks,
    plugins,
    events: createEventBus(logger),
    tickets: tokenSigner(options.secret, 'tickets'),
    basePath: (options.basePath ?? '/api/better-files').replace(/\/+$/, ''),
    limits,
    operations: {},
  } as Omit<Engine, 'files' | 'jobs'> as Engine;
  engine.files = createFiles(engine);

  /** The context for work outside any request: maintenance and plugin event hooks. */
  const maintenance = (): MaintenanceContext => ({
    db: engine.db,
    storage: engine.storage,
    now: clock.now(),
    logger,
    readVersion: (tenantId, versionId) => engine.files.readVersion(tenantId, versionId),
    renditions: (tenantId) => renditionStore(engine, engine.db, tenantId),
    emit: (event) =>
      engine.events.publish({ ...event, actorId: 'system', occurredAt: clock.now() }),
    enqueue: (tenantId, name, payload, enqueueOptions) =>
      engine.jobs.api.enqueue(tenantId, name, payload, enqueueOptions),
  });
  engine.jobs = createJobs({
    db: engine.db,
    clock,
    logger,
    definitions: jobDefinitions(plugins, options.jobs?.handlers),
    options: options.jobs,
    maintenance,
  });
  for (const plugin of plugins)
    if (plugin.onEvent) engine.events.addSink((event) => plugin.onEvent!(event, maintenance()));

  // Invitations sent to an email address are claimed the first time that person calls Better Files.
  const claimed = new Map<string, number>();
  async function claimInvitations(
    principalId: string,
    tenantId: string,
    email: string | undefined,
  ) {
    if (!email) return;
    const key = `${tenantId}:${email.toLowerCase()}`;
    const now = clock.now();
    if ((claimed.get(key) ?? 0) > now) return;
    claimed.set(key, now + 5 * 60_000);
    if (claimed.size > 10_000) claimed.clear();
    const pending = await engine.db.findMany<Member>('members', {
      where: { tenantId, email: email.toLowerCase(), status: 'invited' },
    });
    if (pending.length === 0) return;
    await engine.db.transaction(async (tx) => {
      for (const member of pending) {
        const existing = await tx.findOne<Member>('members', {
          tenantId,
          roomId: member.roomId,
          identityId: principalId,
        });
        if (existing) {
          await tx.update(
            'members',
            { id: existing.id, tenantId },
            {
              status: 'active',
              groupIds: [...new Set([...existing.groupIds, ...member.groupIds])],
              updatedAt: now,
            },
          );
          await tx.delete('members', { id: member.id, tenantId });
        } else
          await tx.update(
            'members',
            { id: member.id, tenantId },
            { identityId: principalId, status: 'active', updatedAt: now },
          );
      }
    });
    for (const member of pending)
      await engine.events.publish({
        type: 'member.joined',
        tenantId,
        roomId: member.roomId,
        actorId: principalId,
        occurredAt: now,
        data: { memberId: member.id, email: email.toLowerCase() },
      });
  }

  const call =
    (endpoint: AnyEndpoint) =>
    async (credential: Credential, input: unknown, request?: RequestInfo) => {
      const result = await runEndpoint(engine, endpoint, credential, input, request);
      return result;
    };
  // Wrap authentication once to claim invitations; the pipeline authenticates through the same provider.
  const identity = options.iam.identity;
  engine.iam = {
    ...options.iam,
    identity: {
      async authenticate(credential, tenantId) {
        const principal = await identity.authenticate(credential, tenantId);
        await claimInvitations(principal.id, tenantId, principal.email).catch((error: unknown) =>
          logger.warn('Could not claim invitations', {
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        return principal;
      },
    },
  };

  const api: ApiTable = {};
  for (const [group, endpoints] of Object.entries(coreEndpoints)) {
    api[group] = {};
    for (const [name, endpoint] of Object.entries(endpoints))
      api[group]![name] = call(endpoint as AnyEndpoint);
  }
  for (const plugin of plugins) {
    if (!plugin.endpoints || Object.keys(plugin.endpoints).length === 0) continue;
    const group: ApiTable[string] = {};
    for (const [name, endpoint] of Object.entries(plugin.endpoints))
      group[name] = call(endpoint as AnyEndpoint);
    api[plugin.id] = group;
  }
  engine.operations = {
    ...Object.fromEntries(
      Object.entries(coreEndpoints).map(([group, endpoints]) => [
        group,
        endpoints as Record<string, AnyEndpoint>,
      ]),
    ),
    ...Object.fromEntries(
      plugins
        .filter((plugin) => plugin.endpoints)
        .map((plugin) => [plugin.id, plugin.endpoints as Record<string, AnyEndpoint>]),
    ),
  };

  async function upload(
    credential: Credential,
    input: {
      tenantId: string;
      uploadId: string;
      part?: number;
      body: ReadableStream<Uint8Array> | Uint8Array;
    },
    request?: RequestInfo,
  ) {
    const principal = await engine.iam.identity.authenticate(credential, input.tenantId);
    const record = await engine.db.findOne<Upload>('uploads', {
      id: input.uploadId,
      tenantId: input.tenantId,
    });
    if (!record || record.createdBy !== principal.id) throw notFound('Upload');
    if (record.status !== 'pending')
      throw new BetterFilesError('CONFLICT', `The upload is ${record.status}`);
    if (record.expiresAt <= clock.now())
      throw new BetterFilesError('CONFLICT', 'The upload has expired');
    // Access may have changed since the session opened: check the target again.
    const target = await loadNode(engine.db, input.tenantId, record.targetId);
    const room = await loadRoom(engine.db, input.tenantId, target.roomId);
    assertWritable(room);
    const scope = createContext(engine, {
      tenantId: input.tenantId,
      principal,
      credential,
      ...(request ? { request } : {}),
    });
    const masks = await engine.access.capabilities({
      db: engine.db,
      credential,
      principal,
      room,
      nodes: [target],
      context: scope.make(engine.db, { room, node: target }),
    });
    if (!hasAll(masks.get(target.id) ?? 0, Capability.UPLOAD | Capability.LIST))
      throw notFound('Upload');
    const received = await engine.files.receive(record, input.body, input.part);
    if (input.part === undefined)
      await engine.db.transaction((tx) =>
        tx.update(
          'uploads',
          { id: record.id, tenantId: input.tenantId },
          {
            status: 'uploaded',
            ...(received.sha256 ? { receivedSha256: received.sha256 } : {}),
          },
        ),
      );
    return {
      uploadId: record.id,
      received: received.size,
      ...(input.part === undefined ? {} : { part: input.part }),
    };
  }

  const activityStream = createActivityStream(engine);

  const serve = (token: string, request: { method?: string; range?: string | null } = {}) =>
    engine.files.serve(token, { method: request.method ?? 'GET', range: request.range ?? null });

  const http = createHttp({
    basePath: engine.basePath,
    trustedOrigins: options.trustedOrigins ?? [],
    maxJsonBodyBytes: options.maxJsonBodyBytes ?? 64 * 1024,
    trustProxy: options.trustProxy === true,
    logger,
    api,
    upload,
    serve: (token, request) => serve(token, request),
    stream: (credential, streamOptions) => activityStream(credential, streamOptions),
  });

  /** Work that runs as the system, not as a person: scheduled room closes and expired access. */
  const systemScope = (tenantId: string) =>
    createContext(engine, {
      tenantId,
      principal: {
        id: 'system',
        tenantId,
        kind: 'service',
        groups: [],
        guest: false,
        mfa: false,
        name: 'Better Files',
      },
      credential: {},
    });

  async function schedules(now: number) {
    let closed = 0;
    // Rooms whose scheduled close has come: closed exactly as an administrator would close them.
    const due = await engine.db.findMany<Room>('rooms', {
      where: { status: 'live', closesAt: { lt: now + 1 } },
      limit: 100,
    });
    for (const room of due) {
      const scope = systemScope(room.tenantId);
      try {
        await engine.db.transaction((tx) => transition(scope.make(tx, { room }), 'close'));
        await scope.flush();
        closed++;
      } catch (error) {
        scope.discard();
        logger.error('Scheduled room close failed', { roomId: room.id, error: String(error) });
      }
    }
    // Access windows that ended. Group memberships and relations carry the expiry in the identity system, but not
    // every path does (member invitations on Better IAM releases without guests), so the member is detached here too:
    // out of the room's groups, its relation revoked, or its unredeemed invitation withdrawn.
    let expiredMembers = 0;
    const members = await engine.db.findMany<Member>('members', {
      where: { status: { in: ['active', 'invited'] }, expiresAt: { lt: now + 1 } },
      limit: 500,
    });
    for (const member of members) {
      const room = await engine.db.findOne<Room>('rooms', {
        id: member.roomId,
        tenantId: member.tenantId,
      });
      if (!room) continue;
      const scope = systemScope(member.tenantId);
      try {
        await engine.db.transaction(async (tx) => {
          const context = scope.make(tx, { room });
          if (engine.iam.directory) await detach(context, member);
          await tx.update(
            'members',
            { id: member.id, tenantId: member.tenantId },
            { status: 'expired', updatedAt: now },
          );
          await context.activity({
            roomId: room.id,
            action: 'member.expired',
            metadata: { memberId: member.id, email: member.email ?? null },
          });
          context.emit('member.expired', {
            roomId: room.id,
            memberId: member.id,
            identityId: member.identityId ?? null,
          });
        });
        await scope.flush();
        expiredMembers++;
      } catch (error) {
        // Left as it is, so the next run tries again.
        scope.discard();
        logger.error('Expiring a member failed', { memberId: member.id, error: String(error) });
      }
    }
    return { closed, expiredMembers };
  }

  async function purgeNodes(tenantId: string, nodes: DataRoomNode[]) {
    const ids = nodes.map((node) => node.id);
    const versions = await engine.db.findMany<{ id: string; blobId?: string }>('versions', {
      where: { tenantId, documentId: { in: ids } },
    });
    const blobIds = versions.flatMap((version) => (version.blobId ? [version.blobId] : []));
    const renditions = blobIds.length
      ? await engine.db.findMany<{ blobId: string }>('renditions', {
          where: { tenantId, versionId: { in: versions.map((v) => v.id) } },
        })
      : [];
    const allBlobIds = [...blobIds, ...renditions.map((r) => r.blobId)];
    const blobs = allBlobIds.length
      ? await engine.db.findMany<{ id: string; storageKey: string }>('blobs', {
          where: { tenantId, id: { in: allBlobIds } },
        })
      : [];
    await engine.db.transaction(async (tx) => {
      await tx.delete('renditions', { tenantId, versionId: { in: versions.map((v) => v.id) } });
      await tx.delete('versions', { tenantId, documentId: { in: ids } });
      await tx.delete('documents', { tenantId, id: { in: ids } });
      await tx.delete('aclEntries', { tenantId, nodeId: { in: ids } });
      await tx.delete('nodeClosure', { tenantId, descendantId: { in: ids } });
      await tx.delete('nodes', { tenantId, id: { in: ids } });
      if (blobs.length) await tx.delete('blobs', { tenantId, id: { in: blobs.map((b) => b.id) } });
    });
    for (const blob of blobs) await engine.storage.delete(blob.storageKey).catch(() => undefined);
  }

  return {
    options,
    schema,
    capabilities,
    plugins,
    api: api as InferApi<O>,
    handler: http.handler,
    nodeHandler: http.nodeHandler,
    files: { upload, serve },
    stream: activityStream,
    events: { subscribe: (patterns, handler) => engine.events.subscribe(patterns, handler) },
    async capabilitiesFor(credential, input) {
      const principal = await engine.iam.identity.authenticate(credential, input.tenantId);
      const room = await loadRoom(engine.db, input.tenantId, input.roomId);
      const nodes = input.nodeIds.length
        ? await engine.db.findMany<DataRoomNode>('nodes', {
            where: {
              tenantId: input.tenantId,
              roomId: room.id,
              id: { in: [...input.nodeIds] },
              deletedAt: { isNull: true },
            },
          })
        : [];
      const scope = createContext(engine, { tenantId: input.tenantId, principal, credential });
      const masks = await engine.access.capabilities({
        db: engine.db,
        credential,
        principal,
        room,
        nodes,
        context: scope.make(engine.db, { room }),
      });
      const result: Record<string, string[]> = {};
      for (const [id, mask] of masks) result[id] = capabilities.namesOf(mask);
      return result;
    },
    async resolveForIam(reference) {
      const kind =
        reference.type === resourceTypes.folder
          ? 'folder'
          : reference.type === resourceTypes.document
            ? 'document'
            : undefined;
      if (!kind) return undefined;
      const node = await engine.db.findOne<DataRoomNode>('nodes', {
        id: reference.id,
        tenantId: reference.tenantId,
      });
      if (!node || node.kind !== kind) throw notFound('Node');
      const room = await engine.db.findOne<Room>('rooms', {
        id: node.roomId,
        tenantId: reference.tenantId,
      });
      if (!room) throw notFound('Room');
      const document =
        kind === 'document'
          ? await engine.db.findOne<{ flags: { viewOnly?: boolean } }>('documents', {
              id: node.id,
              tenantId: reference.tenantId,
            })
          : null;
      return {
        tenantId: reference.tenantId,
        type: reference.type,
        id: node.id,
        attributes: {
          roomId: room.id,
          roomStatus: room.status,
          classification: room.settings.classification ?? 'none',
          ...(document ? { viewOnly: document.flags.viewOnly === true } : {}),
          // Better IAM exposes the room's relations to policies as resource.parentRelations.
          parentType: resourceTypes.room,
          parentId: room.id,
        },
      };
    },
    verifyActivity: (input) => verifyActivity(engine.db, input.tenantId, input.roomId),
    openapi: (openApiOptions) =>
      openApiDocument(
        engine.operations as Parameters<typeof openApiDocument>[0],
        engine.basePath,
        openApiOptions,
      ),
    initialize: () => options.database.migrate(schema),
    async maintain() {
      const now = clock.now();
      const tickets = await engine.db.transaction((tx) =>
        tx.delete('tickets', { expiresAt: { lt: now - 60_000 } }),
      );
      const stale = await engine.db.findMany<Upload>('uploads', {
        where: { status: { in: ['pending', 'uploaded'] }, expiresAt: { lt: now } },
        limit: 200,
      });
      for (const record of stale)
        await discardUpload({ db: engine.db, storage: engine.storage, logger }, record);
      await engine.db.transaction((tx) =>
        tx.delete('uploads', {
          status: { in: ['completed', 'aborted'] },
          expiresAt: { lt: now - 7 * 86_400_000 },
        }),
      );
      // Trash retention, per room.
      let purged = 0;
      const trashed = await engine.db.findMany<DataRoomNode>('nodes', {
        where: { deletedAt: { lt: now - 86_400_000 } },
        limit: 1000,
      });
      const rooms = new Map<string, Room | null>();
      const expired: DataRoomNode[] = [];
      for (const node of trashed) {
        const key = `${node.tenantId}:${node.roomId}`;
        if (!rooms.has(key))
          rooms.set(
            key,
            await engine.db.findOne<Room>('rooms', { id: node.roomId, tenantId: node.tenantId }),
          );
        const days = rooms.get(key)?.settings.trashRetentionDays ?? 30;
        if (node.deletedAt! < now - days * 86_400_000) expired.push(node);
      }
      const byRoom = new Map<string, DataRoomNode[]>();
      for (const node of expired) {
        const key = `${node.tenantId}:${node.roomId}`;
        byRoom.set(key, [...(byRoom.get(key) ?? []), node]);
      }
      for (const nodes of byRoom.values()) {
        const { tenantId, roomId } = nodes[0]!;
        // Held content stays in the trash until the hold is released.
        let held: string | undefined;
        for (const hook of hooks)
          held ??= await hook.retains?.({
            db: engine.db,
            tenantId,
            roomId,
            nodeIds: nodes.map((n) => n.id),
          });
        if (held) continue;
        await purgeNodes(tenantId, nodes);
        purged += nodes.length;
      }
      const { closed, expiredMembers } = await schedules(now);
      for (const plugin of plugins) await plugin.maintain?.(maintenance());
      const jobs = await engine.jobs.recover();
      return { tickets, uploads: stale.length, purged, closed, expiredMembers, jobs };
    },
    jobs: engine.jobs.api,
    async close() {
      await engine.jobs.close();
      await options.database.close?.();
    },
    $Infer: undefined as unknown as InferTypes<O>,
  };
}

export type { Ticket, BetterFilesEvent as Event };
