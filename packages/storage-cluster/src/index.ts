import { createHash, randomBytes } from 'node:crypto';
import {
  BetterFilesError,
  defineTable,
  definePlugin,
  endpoint,
  field,
  notFound,
  prefixedId,
  resolveSchema,
  v,
  type ByteSource,
  type DatabaseAdapter,
  type MaintenanceContext,
  type MigrationResult,
  type PluginContext,
  type ResolvedSchema,
  type StorageAdapter,
  type StoredObject,
} from '@better-files/core';
import {
  deriveNodeSecret,
  isValidKey,
  routes,
  signToken,
  verifyHeartbeat,
  type DataToken,
  type HeartbeatBody,
  type NodeCommand,
} from './protocol.js';

export * from './protocol.js';

/** Rows of the cluster index live under one scope rather than a tenant: the fleet is shared infrastructure. */
const SCOPE = 'cluster';
const ADMIN = 'better-files:storage:admin';

export interface StorageClusterOptions {
  /**
   * The cluster index. Give it its own handle (a separate PostgreSQL pool, or its own SQLite/PGlite file): storage
   * calls can happen while Better Files holds a transaction on its own database.
   */
  database: DatabaseAdapter;
  /** At least 32 characters. Node secrets are derived from it; rotating it re-keys every node. */
  secret: string;
  /** The tenant whose administrators run the fleet (the `better-files:storage:admin` action). Nodes join it. */
  operatorTenant: string;
  /** Copies of every object. Default 2. */
  replicas?: number;
  /** Copies written before a write succeeds. Default: a majority of `replicas`. */
  writeQuorum?: number;
  /** Default 10 s. */
  heartbeatMs?: number;
  /** A node that has not reported for this long is disconnected: reads and placement skip it. Default 40 s. */
  disconnectedAfterMs?: number;
  /** A disconnected node's objects are copied elsewhere after this long. Default 15 min. Disconnected is not dead. */
  lostAfterMs?: number;
  /** Free space kept on every node. Default 1 GiB. */
  reserveBytes?: number;
  /** Lifetime of data-plane tokens. Default 15 min. */
  tokenTtlSeconds?: number;
  /** Prefer nodes in this zone for reads (the control plane's own zone). */
  zone?: string;
  /** Bytes buffered per replica while writing. Default 4 MiB. */
  fanOutBufferBytes?: number;
  /** Fleet events, in addition to `dr.events` (which the plugin feeds). */
  onEvent?: (event: StorageClusterEvent) => void;
  fetch?: typeof fetch;
  clock?: { now(): number };
  logger?: {
    warn?(message: string, data?: unknown): void;
    error?(message: string, data?: unknown): void;
  };
}

export interface StorageNodeRecord {
  id: string;
  tenantId: string;
  name: string;
  zone?: string;
  url: string;
  state: 'active' | 'draining' | 'removed';
  cordoned: boolean;
  generation: number;
  capacityBytes: number;
  usedBytes: number;
  freeBytes: number;
  objects: number;
  version?: string;
  connectivity?: string;
  lastSeenAt: number;
  lastHeartbeat: number;
  updatedAt: number;
  createdAt: number;
}

interface ObjectRecord {
  id: string;
  tenantId: string;
  key: string;
  size: number;
  sha256: string;
  replicas: number;
  updatedAt: number;
  createdAt: number;
}

interface ReplicaRecord {
  id: string;
  tenantId: string;
  objectId: string;
  key: string;
  nodeId: string;
  state: 'stored' | 'missing' | 'corrupt';
  verifiedAt?: number;
  updatedAt: number;
  createdAt: number;
}

interface JoinTokenRecord {
  id: string;
  tenantId: string;
  tokenHash: string;
  zone?: string;
  expiresAt: number;
  usedAt?: number;
  nodeId?: string;
  createdBy: string;
  createdAt: number;
}

interface CommandRecord {
  id: string;
  tenantId: string;
  nodeId: string;
  type: 'delete';
  key: string;
  state: 'pending' | 'sent';
  sentAt?: number;
  createdAt: number;
}

export type StorageClusterEventType =
  | 'storage.node.joined'
  | 'storage.node.disconnected'
  | 'storage.node.reconnected'
  | 'storage.node.lost'
  | 'storage.node.drained'
  | 'storage.node.removed'
  | 'storage.object.repaired'
  | 'storage.replica.corrupt';

export interface StorageClusterEvent {
  type: StorageClusterEventType;
  data: Record<string, unknown>;
}

export interface ReconcileReport {
  /** Another control-plane instance holds the reconcile lease. */
  skipped?: boolean;
  checked: number;
  replicated: number;
  trimmed: number;
  failed: number;
  underReplicated: number;
  verified: number;
  corrupt: number;
}

export const clusterTables = {
  nodes: defineTable({
    fields: {
      name: field.string(),
      zone: field.string({ required: false }),
      url: field.string(),
      state: field.enum(['active', 'draining', 'removed'] as const),
      cordoned: field.boolean(),
      generation: field.number(),
      capacityBytes: field.number(),
      usedBytes: field.number(),
      freeBytes: field.number(),
      objects: field.number(),
      version: field.string({ required: false }),
      /** Last connectivity reconcile announced, so transitions are reported once. */
      connectivity: field.string({ required: false }),
      lastSeenAt: field.timestamp(),
      lastHeartbeat: field.number(),
      updatedAt: field.timestamp(),
    },
  }),
  objects: defineTable({
    fields: {
      key: field.string(),
      size: field.number(),
      sha256: field.string(),
      replicas: field.number(),
      updatedAt: field.timestamp(),
    },
    indexes: [{ fields: ['tenantId', 'key'], unique: true }, { fields: ['replicas'] }],
  }),
  replicas: defineTable({
    fields: {
      objectId: field.string(),
      key: field.string(),
      nodeId: field.string(),
      state: field.enum(['stored', 'missing', 'corrupt'] as const),
      verifiedAt: field.timestamp({ required: false }),
      updatedAt: field.timestamp(),
    },
    indexes: [
      { fields: ['tenantId', 'objectId', 'nodeId'], unique: true },
      { fields: ['tenantId', 'nodeId'] },
      { fields: ['tenantId', 'key'] },
    ],
  }),
  joinTokens: defineTable({
    fields: {
      tokenHash: field.string(),
      zone: field.string({ required: false }),
      expiresAt: field.timestamp(),
      usedAt: field.timestamp({ required: false }),
      nodeId: field.string({ required: false }),
      createdBy: field.string(),
    },
    indexes: [{ fields: ['tenantId', 'tokenHash'], unique: true }],
  }),
  /** Leader leases between control-plane instances (one reconciler at a time). */
  leases: defineTable({
    fields: {
      name: field.string(),
      holder: field.string(),
      expiresAt: field.timestamp(),
    },
    indexes: [{ fields: ['tenantId', 'name'], unique: true }],
  }),
  commands: defineTable({
    fields: {
      nodeId: field.string(),
      type: field.enum(['delete'] as const),
      key: field.string(),
      state: field.enum(['pending', 'sent'] as const),
      sentAt: field.timestamp({ required: false }),
    },
    indexes: [{ fields: ['tenantId', 'nodeId', 'state'] }],
  }),
};

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

async function toStream(body: ByteSource): Promise<ReadableStream<Uint8Array>> {
  if (body instanceof ReadableStream) return body;
  if (body instanceof Uint8Array)
    return new ReadableStream({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    });
  const iterator = (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
  });
}

/**
 * Splits one stream into `count` streams in lock step: the source is read only when every live branch has room,
 * so memory stays within `bufferBytes` per branch and a slow replica slows the write instead of piling it up.
 * A cancelled branch (a replica whose request failed) drops out; the rest continue.
 */
export function fanOut(
  source: ReadableStream<Uint8Array>,
  count: number,
  bufferBytes = 4 * 1024 * 1024,
): ReadableStream<Uint8Array>[] {
  const reader = source.getReader();
  const controllers: (ReadableStreamDefaultController<Uint8Array> | null)[] = new Array(count).fill(
    null,
  );
  const waiters: (() => void)[] = [];
  let pumping: Promise<void> | undefined;
  let finished = false;
  const wake = () => {
    for (const resolve of waiters.splice(0)) resolve();
  };
  const live = () =>
    controllers.filter(
      (controller): controller is ReadableStreamDefaultController<Uint8Array> =>
        controller !== null,
    );
  async function pump() {
    while (!finished) {
      const branches = live();
      if (branches.length === 0) {
        finished = true;
        await reader.cancel().catch(() => undefined);
        return;
      }
      if (branches.some((controller) => (controller.desiredSize ?? 0) <= 0)) {
        await new Promise<void>((resolve) => waiters.push(resolve));
        continue;
      }
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        for (const controller of live()) controller.close();
        return;
      }
      for (const controller of live()) controller.enqueue(value);
    }
  }
  return Array.from(
    { length: count },
    (_, index) =>
      new ReadableStream<Uint8Array>(
        {
          start(controller) {
            controllers[index] = controller;
          },
          pull() {
            pumping ??= pump().catch((error: unknown) => {
              finished = true;
              for (const controller of live()) controller.error(error);
            });
            wake();
          },
          cancel() {
            controllers[index] = null;
            wake();
          },
        },
        new ByteLengthQueuingStrategy({ highWaterMark: bufferBytes }),
      ),
  );
}

/** Weighted rendezvous hashing: stable per key, proportional to free space, spread across zones. */
export function placeReplicas<N extends { id: string; zone?: string; freeBytes: number }>(
  key: string,
  count: number,
  nodes: readonly N[],
  /** Nodes already holding the object: their zones count as covered. */
  holding: readonly { id: string; zone?: string }[] = [],
): N[] {
  const scored = nodes
    .map((node) => {
      const digest = createHash('sha256').update(`${key}\n${node.id}`).digest();
      const u = (digest.readUIntBE(0, 6) + 1) / (2 ** 48 + 2);
      return { node, score: Math.max(1, node.freeBytes) / -Math.log(u) };
    })
    .sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id));
  const chosen: N[] = [];
  const zones = new Set<string>(holding.map((node) => node.zone ?? `node:${node.id}`));
  // First pass: one node per zone; second pass: fill with the best remaining.
  for (const { node } of scored) {
    if (chosen.length === count) break;
    const zone = node.zone ?? `node:${node.id}`;
    if (!zones.has(zone)) {
      chosen.push(node);
      zones.add(zone);
    }
  }
  for (const { node } of scored) {
    if (chosen.length === count) break;
    if (!chosen.includes(node)) chosen.push(node);
  }
  return chosen;
}

/**
 * A storage control plane in the style of better-compute: servers with local disks run
 * `@better-files/storage-node`, join with a single-use token, and heartbeat outbound; the control plane
 * places each object on `replicas` nodes (zone-spread, weighted by free space), reads from any live replica,
 * repairs under-replicated objects, drains nodes, and scrubs replicas against their checksums.
 *
 * ```ts
 * const cluster = storageCluster({ database: clusterDb, secret, operatorTenant: 'ops' });
 * const dr = betterFiles({ storage: cluster.storage, plugins: [cluster.plugin], ...options });
 * await cluster.initialize();
 * ```
 */
export function storageCluster(options: StorageClusterOptions) {
  if (options.secret.length < 32)
    throw new BetterFilesError('INVALID_CONFIG', 'The cluster secret needs 32+ characters');
  const db = options.database;
  const target = Math.max(1, options.replicas ?? 2);
  const quorum = Math.min(target, Math.max(1, options.writeQuorum ?? Math.floor(target / 2) + 1));
  const heartbeatMs = options.heartbeatMs ?? 10_000;
  const disconnectedAfter = options.disconnectedAfterMs ?? heartbeatMs * 4;
  const lostAfter = options.lostAfterMs ?? 15 * 60_000;
  const reserve = options.reserveBytes ?? 1024 ** 3;
  const ttl = (options.tokenTtlSeconds ?? 900) * 1000;
  const now = () => options.clock?.now() ?? Date.now();
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const log = options.logger ?? {};
  const schema: ResolvedSchema = resolveSchema(
    [{ source: 'storage-cluster', tables: clusterTables }],
    {
      tablePrefix: 'better_files_storage_',
    },
  );
  db.bind?.(schema);
  // Nodes that just failed a request are tried last for a few seconds.
  const suspect = new Map<string, number>();
  /** This control-plane instance, for leases. */
  const instance = `cp_${randomBytes(9).toString('base64url')}`;
  /** Where fleet events go besides `onEvent`: set by the plugin to publish on `dr.events`. */
  let sink: ((event: StorageClusterEvent) => Promise<void> | void) | undefined;
  const emit = (type: StorageClusterEventType, data: Record<string, unknown>) => {
    const event = { type, data };
    try {
      options.onEvent?.(event);
    } catch (error) {
      log.error?.('Storage event handler failed', { type, error: String(error) });
    }
    void Promise.resolve(sink?.(event)).catch((error: unknown) =>
      log.error?.('Storage event publish failed', { type, error: String(error) }),
    );
  };

  /**
   * Takes (or renews) a named lease for `ttlMs`. Two instances racing for a free lease both try to insert; the
   * unique index lets one win.
   */
  async function acquire(name: string, ttlMs: number): Promise<boolean> {
    try {
      return await write(async (tx) => {
        const lease = await tx.findOne<{ id: string; holder: string; expiresAt: number }>(
          'leases',
          { tenantId: SCOPE, name },
        );
        const at = now();
        if (!lease) {
          await tx.insert('leases', {
            id: prefixedId('slease', at),
            tenantId: SCOPE,
            name,
            holder: instance,
            expiresAt: at + ttlMs,
            createdAt: at,
          });
          return true;
        }
        if (lease.holder !== instance && lease.expiresAt > at) return false;
        const taken = await tx.update(
          'leases',
          { id: lease.id, tenantId: SCOPE, holder: lease.holder, expiresAt: lease.expiresAt },
          { holder: instance, expiresAt: at + ttlMs },
        );
        return taken === 1;
      });
    } catch {
      return false;
    }
  }
  const release = (name: string) =>
    write((tx) =>
      tx.update('leases', { tenantId: SCOPE, name, holder: instance }, { expiresAt: 0 }),
    ).catch(() => undefined);

  // ---------------------------------------------------------------- nodes

  const connected = (node: StorageNodeRecord) =>
    node.state !== 'removed' && now() - node.lastSeenAt <= disconnectedAfter;
  const lost = (node: StorageNodeRecord) =>
    node.state !== 'removed' && now() - node.lastSeenAt > lostAfter;
  const allNodes = () => db.findMany<StorageNodeRecord>('nodes', { where: { tenantId: SCOPE } });
  const writable = (node: StorageNodeRecord, size: number) =>
    node.state === 'active' &&
    !node.cordoned &&
    connected(node) &&
    node.freeBytes - reserve >= size;

  const secretOf = (node: StorageNodeRecord) =>
    deriveNodeSecret(options.secret, node.id, node.generation);
  const token = (node: StorageNodeRecord, claims: Omit<DataToken, 'n' | 'e'>, ttlMs = ttl) =>
    signToken(secretOf(node), { n: node.id, e: now() + ttlMs, ...claims });

  async function call(
    node: StorageNodeRecord,
    path: string,
    init: RequestInit & { token: string },
  ) {
    const { token: bearer, headers, ...rest } = init;
    try {
      return await doFetch(`${node.url.replace(/\/+$/, '')}${path}`, {
        ...rest,
        headers: { ...(headers as Record<string, string>), authorization: `Bearer ${bearer}` },
      });
    } catch (error) {
      suspect.set(node.id, now() + 10_000);
      throw error;
    }
  }

  async function fail(response: Response, what: string): Promise<never> {
    const detail = await response.text().catch(() => '');
    throw new BetterFilesError(
      'INTERNAL_ERROR',
      `Storage node refused ${what} (${response.status}) ${detail.slice(0, 200)}`,
    );
  }

  /** Readable replicas of an object, best first. */
  async function sources(object: ObjectRecord) {
    const [replicas, nodes] = await Promise.all([
      db.findMany<ReplicaRecord>('replicas', {
        where: { tenantId: SCOPE, objectId: object.id, state: 'stored' },
      }),
      allNodes(),
    ]);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    return replicas
      .map((replica) => byId.get(replica.nodeId))
      .filter((node): node is StorageNodeRecord => !!node && connected(node))
      .sort(
        (a, b) =>
          Number((suspect.get(a.id) ?? 0) > now()) - Number((suspect.get(b.id) ?? 0) > now()) ||
          Number(options.zone !== undefined && b.zone === options.zone) -
            Number(options.zone !== undefined && a.zone === options.zone) ||
          a.usedBytes / Math.max(1, a.capacityBytes) - b.usedBytes / Math.max(1, b.capacityBytes),
      );
  }

  const findObject = (key: string) => db.findOne<ObjectRecord>('objects', { tenantId: SCOPE, key });
  /** Every index write runs in a transaction (the cluster database is its own, so this never waits on Better Files). */
  const write = <R>(fn: (tx: DatabaseAdapter) => Promise<R>) => db.transaction(fn);

  function recordReplica(object: ObjectRecord, nodeId: string) {
    return write(async (tx) => {
      const existing = await tx.findOne<ReplicaRecord>('replicas', {
        tenantId: SCOPE,
        objectId: object.id,
        nodeId,
      });
      const at = now();
      if (existing)
        await tx.update(
          'replicas',
          { id: existing.id, tenantId: SCOPE },
          { state: 'stored', verifiedAt: at, updatedAt: at },
        );
      else
        await tx.insert('replicas', {
          id: prefixedId('srep', at),
          tenantId: SCOPE,
          objectId: object.id,
          key: object.key,
          nodeId,
          state: 'stored',
          verifiedAt: at,
          updatedAt: at,
          createdAt: at,
        });
    });
  }

  function recount(object: Pick<ObjectRecord, 'id'>) {
    return write(async (tx) => {
      const stored = await tx.count('replicas', {
        tenantId: SCOPE,
        objectId: object.id,
        state: 'stored',
      });
      await tx.update(
        'objects',
        { id: object.id, tenantId: SCOPE },
        { replicas: stored, updatedAt: now() },
      );
      return stored;
    });
  }

  const setReplicaState = (id: string, patch: Record<string, unknown>) =>
    write((tx) => tx.update('replicas', { id, tenantId: SCOPE }, { ...patch, updatedAt: now() }));
  const dropReplica = (id: string) => write((tx) => tx.delete('replicas', { id, tenantId: SCOPE }));

  /** Records a written object, replacing the replica set of an earlier object under the same key. */
  async function recordObject(
    key: string,
    size: number,
    sha256: string,
    nodeIds: readonly string[],
  ) {
    const at = now();
    const { object, stale } = await write(async (tx) => {
      let found = await tx.findOne<ObjectRecord>('objects', { tenantId: SCOPE, key });
      const stale: ReplicaRecord[] = [];
      if (found) {
        const previous = await tx.findMany<ReplicaRecord>('replicas', {
          where: { tenantId: SCOPE, objectId: found.id },
        });
        for (const replica of previous)
          if (!nodeIds.includes(replica.nodeId)) {
            stale.push(replica);
            await tx.delete('replicas', { id: replica.id, tenantId: SCOPE });
          }
        await tx.update(
          'objects',
          { id: found.id, tenantId: SCOPE },
          { size, sha256, updatedAt: at },
        );
        found = { ...found, size, sha256 };
      } else {
        found = {
          id: prefixedId('sobj', at),
          tenantId: SCOPE,
          key,
          size,
          sha256,
          replicas: 0,
          updatedAt: at,
          createdAt: at,
        };
        await tx.insert('objects', found);
      }
      return { object: found, stale };
    });
    for (const nodeId of nodeIds) await recordReplica(object, nodeId);
    // An overwrite that landed on other nodes leaves old bytes behind: remove them.
    for (const replica of stale) await removeFrom(replica.nodeId, key);
    await recount(object);
    return object;
  }

  /** Deletes a key from one node now, or queues the deletion for the node's next heartbeat. */
  async function removeFrom(nodeId: string, key: string) {
    const node = await db.findOne<StorageNodeRecord>('nodes', { id: nodeId, tenantId: SCOPE });
    if (!node || node.state === 'removed') return;
    if (connected(node)) {
      const response = await call(node, routes.object(key), {
        method: 'DELETE',
        token: token(node, { o: 'delete', k: key }),
      }).catch(() => undefined);
      if (response && (response.ok || response.status === 404)) return;
    }
    await write((tx) =>
      tx.insert('commands', {
        id: prefixedId('scmd', now()),
        tenantId: SCOPE,
        nodeId,
        type: 'delete',
        key,
        state: 'pending',
        createdAt: now(),
      }),
    );
  }

  /** Streams an object from one node to another and checks the copy. */
  async function copyBetween(object: ObjectRecord, from: StorageNodeRecord, to: StorageNodeRecord) {
    const source = await call(from, routes.object(object.key), {
      method: 'GET',
      token: token(from, { o: 'get', k: object.key }),
    });
    if (!source.ok || !source.body) await fail(source, `reading ${object.key}`);
    const written = await call(to, routes.object(object.key), {
      method: 'PUT',
      token: token(to, { o: 'put', k: object.key, m: object.size }),
      body: source.body,
      headers: { 'content-length': String(object.size) },
      duplex: 'half',
    } as RequestInit & { token: string });
    if (!written.ok) await fail(written, `writing ${object.key}`);
    const result = (await written.json()) as { size: number; sha256: string };
    if (result.sha256 !== object.sha256 || result.size !== object.size) {
      await removeFrom(to.id, object.key);
      throw new BetterFilesError(
        'INTERNAL_ERROR',
        `Copy of ${object.key} to ${to.name} did not match its checksum`,
      );
    }
    await recordReplica(object, to.id);
  }

  // ---------------------------------------------------------------- storage adapter

  const storage: StorageAdapter = {
    id: 'storage-cluster',
    async put(key, body, putOptions): Promise<StoredObject> {
      if (!isValidKey(key)) throw new BetterFilesError('INVALID_INPUT', 'Invalid storage key');
      const size = putOptions?.contentLength ?? (body instanceof Uint8Array ? body.byteLength : 0);
      const candidates = placeReplicas(
        key,
        target,
        (await allNodes()).filter((node) => writable(node, size)),
      );
      if (candidates.length < quorum)
        throw new BetterFilesError(
          'CONFLICT',
          `Not enough storage nodes available (${candidates.length} of ${quorum} needed)`,
        );
      // One read of the body feeds every replica, in lock step (bounded memory).
      const branches: (ReadableStream<Uint8Array> | Uint8Array)[] =
        body instanceof Uint8Array
          ? candidates.map(() => body)
          : fanOut(await toStream(body), candidates.length, options.fanOutBufferBytes);
      const outcomes = await Promise.all(
        candidates.map(async (node, index) => {
          const branch = branches[index]!;
          try {
            const response = await call(node, routes.object(key), {
              method: 'PUT',
              token: token(node, { o: 'put', k: key, ...(size ? { m: size } : {}) }),
              body: branch as BodyInit,
              ...(size ? { headers: { 'content-length': String(size) } } : {}),
              ...(branch instanceof ReadableStream ? { duplex: 'half' } : {}),
            } as RequestInit & { token: string });
            if (!response.ok) await fail(response, `storing ${key}`);
            return { node, result: (await response.json()) as { size: number; sha256: string } };
          } catch (error) {
            // A branch nobody reads would buffer the whole file: release it.
            if (branch instanceof ReadableStream) await branch.cancel().catch(() => undefined);
            log.warn?.('Replica write failed', { node: node.name, key, error: String(error) });
            return undefined;
          }
        }),
      );
      const stored = outcomes.filter((outcome) => outcome !== undefined);
      const digests = new Set(stored.map((outcome) => outcome.result.sha256));
      if (stored.length < quorum || digests.size > 1) {
        for (const outcome of stored) await removeFrom(outcome.node.id, key);
        throw new BetterFilesError(
          'INTERNAL_ERROR',
          digests.size > 1
            ? 'Replicas disagree on the stored bytes'
            : `Only ${stored.length} of ${quorum} replicas were written`,
        );
      }
      const [first] = stored;
      await recordObject(
        key,
        first!.result.size,
        first!.result.sha256,
        stored.map((outcome) => outcome.node.id),
      );
      return { key, size: first!.result.size };
    },
    async get(key, range) {
      const object = await findObject(key);
      if (!object) throw notFound('Object');
      const nodes = await sources(object);
      for (const node of nodes) {
        try {
          const response = await call(node, routes.object(key), {
            method: 'GET',
            token: token(node, { o: 'get', k: key }),
            ...(range ? { headers: { range: `bytes=${range.start}-${range.end ?? ''}` } } : {}),
          });
          if ((response.ok || response.status === 206) && response.body) return response.body;
          if (response.status === 404) {
            // The node lost it: stop counting on this replica.
            const replica = await db.findOne<ReplicaRecord>('replicas', {
              tenantId: SCOPE,
              objectId: object.id,
              nodeId: node.id,
            });
            if (replica) await setReplicaState(replica.id, { state: 'missing' });
            await recount(object);
          }
          await response.body?.cancel().catch(() => undefined);
        } catch {
          /* try the next replica */
        }
      }
      throw new BetterFilesError('INTERNAL_ERROR', `No storage node holding ${key} is reachable`);
    },
    async head(key) {
      const object = await findObject(key);
      return object ? { key, size: object.size, etag: object.sha256 } : null;
    },
    async delete(key) {
      const object = await findObject(key);
      if (!object) return;
      const replicas = await db.findMany<ReplicaRecord>('replicas', {
        where: { tenantId: SCOPE, objectId: object.id },
      });
      await write(async (tx) => {
        await tx.delete('replicas', { tenantId: SCOPE, objectId: object.id });
        await tx.delete('objects', { id: object.id, tenantId: SCOPE });
      });
      for (const replica of replicas) await removeFrom(replica.nodeId, key);
    },
    async copy(from, to) {
      return storage.put(to, await storage.get(from), {
        contentLength: (await storage.head(from))?.size ?? 0,
      });
    },
    multipart: {
      async create(key) {
        if (!isValidKey(key)) throw new BetterFilesError('INVALID_INPUT', 'Invalid storage key');
        // Parts land on one node, chosen like the object's first replica; completing copies to the rest.
        const [primary] = placeReplicas(
          key,
          1,
          (await allNodes()).filter((node) => writable(node, 0)),
        );
        if (!primary) throw new BetterFilesError('CONFLICT', 'No storage node is available');
        return { uploadId: `${primary.id}~${randomBytes(12).toString('base64url')}` };
      },
      async uploadPart(key, uploadId, part, body) {
        const node = await uploadNode(uploadId);
        const size = body instanceof Uint8Array ? body.byteLength : undefined;
        const stream = body instanceof Uint8Array ? body : await toStream(body);
        const response = await call(node, routes.part(uploadId, part), {
          method: 'PUT',
          token: token(node, { o: 'part', k: key, u: uploadId, p: part }),
          body: stream as BodyInit,
          ...(size !== undefined
            ? { headers: { 'content-length': String(size) } }
            : { duplex: 'half' }),
        } as RequestInit & { token: string });
        if (!response.ok) await fail(response, `part ${part} of ${key}`);
        return {
          etag: response.headers.get('etag') ?? ((await response.json()) as { etag: string }).etag,
        };
      },
      async complete(key, uploadId, parts) {
        const node = await uploadNode(uploadId);
        const response = await call(node, routes.complete(uploadId), {
          method: 'POST',
          token: token(node, { o: 'complete', k: key, u: uploadId }),
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ parts }),
        });
        if (!response.ok) await fail(response, `completing ${key}`);
        const result = (await response.json()) as { size: number; sha256: string };
        const object = await recordObject(key, result.size, result.sha256, [node.id]);
        // Reach the write quorum before reporting success; the remaining copies follow in the background.
        const holders = new Set([node.id]);
        const others = placeReplicas(
          key,
          target - 1,
          (await allNodes()).filter(
            (candidate) => !holders.has(candidate.id) && writable(candidate, result.size),
          ),
          [node],
        );
        let copies = 1;
        for (const other of others) {
          if (copies >= quorum) {
            void copyBetween(object, node, other)
              .then(() => recount(object))
              .catch((error: unknown) =>
                log.warn?.('Background replica failed', { key, error: String(error) }),
              );
            continue;
          }
          try {
            await copyBetween(object, node, other);
            copies++;
          } catch (error) {
            log.warn?.('Replica copy failed', { key, error: String(error) });
          }
        }
        await recount(object);
        if (copies < quorum) {
          await storage.delete(key);
          throw new BetterFilesError(
            'INTERNAL_ERROR',
            `Only ${copies} of ${quorum} replicas were written`,
          );
        }
        return { key, size: result.size };
      },
      async abort(_key, uploadId) {
        const node = await uploadNode(uploadId).catch(() => undefined);
        if (!node) return;
        await call(node, routes.upload(uploadId), {
          method: 'DELETE',
          token: token(node, { o: 'abort', u: uploadId }),
        }).catch(() => undefined);
      },
      async presignPart(key, uploadId, part, presignOptions) {
        const node = await uploadNode(uploadId);
        const bearer = token(
          node,
          { o: 'part', k: key, u: uploadId, p: part },
          presignOptions.expiresInSeconds * 1000,
        );
        return `${node.url.replace(/\/+$/, '')}${routes.part(uploadId, part)}?t=${encodeURIComponent(bearer)}`;
      },
    },
    async presign(key, presignOptions) {
      if (presignOptions.method !== 'GET')
        throw new BetterFilesError('UNSUPPORTED', 'Direct writes go through multipart uploads');
      const object = await findObject(key);
      if (!object) throw notFound('Object');
      const [node] = await sources(object);
      if (!node)
        throw new BetterFilesError('INTERNAL_ERROR', `No storage node holding ${key} is reachable`);
      const bearer = token(node, { o: 'get', k: key }, presignOptions.expiresInSeconds * 1000);
      return `${node.url.replace(/\/+$/, '')}${routes.object(key)}?t=${encodeURIComponent(bearer)}`;
    },
  };

  async function uploadNode(uploadId: string) {
    const nodeId = uploadId.split('~')[0]!;
    const node = await db.findOne<StorageNodeRecord>('nodes', { id: nodeId, tenantId: SCOPE });
    if (!node || !connected(node))
      throw new BetterFilesError('INTERNAL_ERROR', "The upload's storage node is not reachable");
    return node;
  }

  // ---------------------------------------------------------------- reconcile

  /**
   * Brings every object back to `replicas` copies on active, connected nodes: copies from a live replica to a new
   * node, trims copies on draining or removed nodes (and extras once a lost node returns), and verifies a sample of
   * replicas against their checksums. Run it from `dr.maintain()` (the plugin does) or on its own schedule.
   */
  async function reconcile(
    input: { limit?: number; verify?: number } = {},
  ): Promise<ReconcileReport> {
    // One reconciler across control-plane instances; the lease outlives a slow run rather than a crashed one.
    if (!(await acquire('reconcile', 10 * 60_000)))
      return {
        skipped: true,
        checked: 0,
        replicated: 0,
        trimmed: 0,
        failed: 0,
        underReplicated: 0,
        verified: 0,
        corrupt: 0,
      };
    try {
      await announceConnectivity();
      const report = await reconcileOnce(input);
      await announceDrained();
      return report;
    } finally {
      await release('reconcile');
    }
  }

  /** Reports connectivity changes once each: disconnected, lost, reconnected. */
  async function announceConnectivity() {
    for (const node of await allNodes()) {
      if (node.state === 'removed') continue;
      const current = connected(node) ? 'connected' : lost(node) ? 'lost' : 'disconnected';
      const previous =
        !node.connectivity || node.connectivity === 'drained' ? 'connected' : node.connectivity;
      if (current === previous) continue;
      await patchNode(node.id, { connectivity: current });
      const data = {
        nodeId: node.id,
        name: node.name,
        zone: node.zone ?? null,
        lastSeenAt: node.lastSeenAt,
      };
      if (current === 'connected') emit('storage.node.reconnected', data);
      else if (current === 'lost') emit('storage.node.lost', data);
      else if (previous === 'connected') emit('storage.node.disconnected', data);
    }
  }

  /** A draining node that holds nothing any more is ready to remove. */
  async function announceDrained() {
    for (const node of await allNodes())
      if (node.state === 'draining' && node.connectivity !== 'drained') {
        const held = await db.count('replicas', { tenantId: SCOPE, nodeId: node.id });
        if (held > 0) continue;
        await patchNode(node.id, { connectivity: 'drained' });
        emit('storage.node.drained', { nodeId: node.id, name: node.name });
      }
  }

  async function reconcileOnce(input: {
    limit?: number;
    verify?: number;
  }): Promise<ReconcileReport> {
    const report: ReconcileReport = {
      checked: 0,
      replicated: 0,
      trimmed: 0,
      failed: 0,
      underReplicated: 0,
      verified: 0,
      corrupt: 0,
    };
    const nodes = await allNodes();
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const healthy = (id: string) => {
      const node = byId.get(id);
      return !!node && node.state === 'active' && connected(node);
    };
    // Objects that may need work: too few copies, or copies on nodes that are leaving or lost.
    const leaving = nodes
      .filter((node) => node.state !== 'active' || lost(node) || !connected(node))
      .map((node) => node.id);
    const suspects = leaving.length
      ? await db.findMany<ReplicaRecord>('replicas', {
          where: { tenantId: SCOPE, nodeId: { in: leaving } },
          limit: input.limit ?? 500,
        })
      : [];
    const thin = await db.findMany<ObjectRecord>('objects', {
      where: { tenantId: SCOPE, replicas: { ne: target } },
      limit: input.limit ?? 500,
    });
    const ids = new Set([
      ...thin.map((object) => object.id),
      ...suspects.map((replica) => replica.objectId),
    ]);
    for (const objectId of ids) {
      const object = await db.findOne<ObjectRecord>('objects', { id: objectId, tenantId: SCOPE });
      if (!object) continue;
      report.checked++;
      try {
        const replicas = await db.findMany<ReplicaRecord>('replicas', {
          where: { tenantId: SCOPE, objectId },
        });
        const stored = replicas.filter((replica) => replica.state === 'stored');
        const good = stored.filter((replica) => healthy(replica.nodeId));
        // Disconnected nodes still count until they are lost: a reboot must not trigger a copy storm.
        const waiting = stored.filter((replica) => {
          const node = byId.get(replica.nodeId);
          return node && node.state === 'active' && !connected(node) && !lost(node);
        });
        let have = good.length + waiting.length;
        if (have < target) {
          const readable = stored
            .map((replica) => byId.get(replica.nodeId))
            .filter((node): node is StorageNodeRecord => !!node && connected(node));
          const holders = new Set(replicas.map((replica) => replica.nodeId));
          const targets = placeReplicas(
            object.key,
            target - have,
            nodes.filter((node) => !holders.has(node.id) && writable(node, object.size)),
            // Zones already covered by healthy copies are filled last.
            good
              .map((replica) => byId.get(replica.nodeId)!)
              .concat(waiting.map((replica) => byId.get(replica.nodeId)!)),
          );
          for (const to of targets) {
            let copied = false;
            for (const from of readable) {
              try {
                await copyBetween(object, from, to);
                copied = true;
                break;
              } catch (error) {
                log.warn?.('Repair copy failed', { key: object.key, error: String(error) });
              }
            }
            if (copied) {
              report.replicated++;
              have++;
              emit('storage.object.repaired', { key: object.key, nodeId: to.id, copies: have });
            } else report.failed++;
          }
        }
        // Enough healthy copies: trim the ones on nodes that are leaving, then any extras.
        const healthyNow = await db.findMany<ReplicaRecord>('replicas', {
          where: { tenantId: SCOPE, objectId, state: 'stored' },
        });
        const healthyCount = healthyNow.filter((replica) => healthy(replica.nodeId)).length;
        if (healthyCount >= target) {
          const extras = healthyNow
            .filter(
              (replica) => !healthy(replica.nodeId) && byId.get(replica.nodeId)?.state !== 'active',
            )
            .concat(
              healthyNow
                .filter((replica) => healthy(replica.nodeId))
                .sort(
                  (a, b) =>
                    (byId.get(a.nodeId)!.freeBytes ?? 0) - (byId.get(b.nodeId)!.freeBytes ?? 0),
                )
                .slice(0, healthyCount - target),
            );
          for (const replica of extras) {
            await dropReplica(replica.id);
            await removeFrom(replica.nodeId, object.key);
            report.trimmed++;
          }
        }
        for (const replica of replicas.filter(
          (replica) => replica.state !== 'stored' && healthyCount >= target,
        )) {
          await dropReplica(replica.id);
          // A corrupt copy is still on disk: remove it too.
          if (replica.state === 'corrupt') await removeFrom(replica.nodeId, object.key);
          report.trimmed++;
        }
        if ((await recount(object)) < target) report.underReplicated++;
      } catch (error) {
        report.failed++;
        log.error?.('Reconcile failed for an object', { objectId, error: String(error) });
      }
    }
    // Scrub: re-hash the least recently verified replicas on live nodes.
    if (input.verify ?? 20) {
      const oldest = await db.findMany<ReplicaRecord>('replicas', {
        where: { tenantId: SCOPE, state: 'stored', verifiedAt: { lt: now() - 24 * 3_600_000 } },
        orderBy: [{ field: 'verifiedAt' }],
        limit: input.verify ?? 20,
      });
      for (const replica of oldest) {
        const node = byId.get(replica.nodeId);
        const object = await db.findOne<ObjectRecord>('objects', {
          id: replica.objectId,
          tenantId: SCOPE,
        });
        if (!node || !object || !connected(node)) continue;
        const outcome = await verifyReplica(node, object, replica);
        report.verified++;
        if (!outcome) report.corrupt++;
      }
    }
    return report;
  }

  /** Re-hashes one replica on its node; a mismatch marks it corrupt (and reconcile replaces it). */
  async function verifyReplica(
    node: StorageNodeRecord,
    object: ObjectRecord,
    replica: ReplicaRecord,
  ) {
    const response = await call(node, routes.verify(object.key), {
      method: 'POST',
      token: token(node, { o: 'verify', k: object.key }),
    }).catch(() => undefined);
    if (!response) return true;
    const result = response.ok
      ? ((await response.json()) as { size: number; sha256: string })
      : undefined;
    const ok = !!result && result.sha256 === object.sha256 && result.size === object.size;
    if (response.ok || response.status === 404)
      await setReplicaState(
        replica.id,
        ok ? { verifiedAt: now() } : { state: response.status === 404 ? 'missing' : 'corrupt' },
      );
    if (!ok) {
      await recount(object);
      emit('storage.replica.corrupt', {
        key: object.key,
        nodeId: node.id,
        reason: response.status === 404 ? 'missing' : 'checksum',
      });
    }
    return ok;
  }

  /** Verifies every replica of the given keys now (operations; tests). */
  async function verify(keys: readonly string[]) {
    const out: Record<string, { nodeId: string; ok: boolean }[]> = {};
    const nodes = new Map((await allNodes()).map((node) => [node.id, node]));
    for (const key of keys) {
      const object = await findObject(key);
      if (!object) continue;
      out[key] = [];
      for (const replica of await db.findMany<ReplicaRecord>('replicas', {
        where: { tenantId: SCOPE, objectId: object.id },
      })) {
        const node = nodes.get(replica.nodeId);
        if (!node || !connected(node)) continue;
        out[key]!.push({ nodeId: node.id, ok: await verifyReplica(node, object, replica) });
      }
    }
    return out;
  }

  /**
   * Anti-entropy: reads every connected node's inventory and reconciles the index with it. Objects the index lost
   * (a restored database) come back; replicas a node no longer has are marked missing and get repaired.
   */
  async function sync() {
    const report = { nodes: 0, recovered: 0, attached: 0, missing: 0 };
    for (const node of (await allNodes()).filter(connected)) {
      report.nodes++;
      const present = new Set<string>();
      let after = '';
      for (;;) {
        const response = await call(
          node,
          `${routes.inventory}?limit=1000${after ? `&after=${after}` : ''}`,
          {
            method: 'GET',
            token: token(node, { o: 'inventory' }),
          },
        );
        if (!response.ok) await fail(response, 'its inventory');
        const page = (await response.json()) as {
          items: { key: string; size: number; sha256: string }[];
          next?: string;
        };
        for (const item of page.items) {
          present.add(item.key);
          let object = await findObject(item.key);
          if (!object) {
            object = await recordObject(item.key, item.size, item.sha256, [node.id]);
            report.recovered++;
            continue;
          }
          if (object.sha256 !== item.sha256) continue; // stale bytes of an overwritten key: reconcile trims
          const replica = await db.findOne<ReplicaRecord>('replicas', {
            tenantId: SCOPE,
            objectId: object.id,
            nodeId: node.id,
          });
          if (!replica || replica.state !== 'stored') {
            await recordReplica(object, node.id);
            await recount(object);
            report.attached++;
          }
        }
        if (!page.next) break;
        after = page.next;
      }
      for (const replica of await db.findMany<ReplicaRecord>('replicas', {
        where: { tenantId: SCOPE, nodeId: node.id, state: 'stored' },
      }))
        if (!present.has(replica.key)) {
          await setReplicaState(replica.id, { state: 'missing' });
          const object = await db.findOne<ObjectRecord>('objects', {
            id: replica.objectId,
            tenantId: SCOPE,
          });
          if (object) await recount(object);
          report.missing++;
        }
    }
    return report;
  }

  // ---------------------------------------------------------------- fleet API

  async function status() {
    const nodes = await allNodes();
    const objects = await db.findMany<ObjectRecord>('objects', { where: { tenantId: SCOPE } });
    return {
      replicas: target,
      writeQuorum: quorum,
      nodes: {
        total: nodes.filter((node) => node.state !== 'removed').length,
        connected: nodes.filter(connected).length,
        draining: nodes.filter((node) => node.state === 'draining').length,
        lost: nodes.filter(lost).length,
      },
      objects: objects.length,
      bytes: objects.reduce((sum, object) => sum + object.size, 0),
      underReplicated: objects.filter((object) => object.replicas < target).length,
      capacityBytes: nodes
        .filter((node) => node.state !== 'removed')
        .reduce((sum, node) => sum + node.capacityBytes, 0),
      freeBytes: nodes
        .filter((node) => writable(node, 0))
        .reduce((sum, node) => sum + node.freeBytes, 0),
    };
  }

  const view = (node: StorageNodeRecord) => ({
    id: node.id,
    name: node.name,
    zone: node.zone ?? null,
    url: node.url,
    state: node.state,
    cordoned: node.cordoned,
    connectivity: connected(node)
      ? ('connected' as const)
      : lost(node)
        ? ('lost' as const)
        : ('disconnected' as const),
    capacityBytes: node.capacityBytes,
    usedBytes: node.usedBytes,
    freeBytes: node.freeBytes,
    objects: node.objects,
    version: node.version ?? null,
    lastSeenAt: node.lastSeenAt,
    joinedAt: node.createdAt,
  });

  /** Fleet events reach `dr.events` (and webhooks) in the operator tenant once the engine hands over its emitter. */
  const publishWith = (context: MaintenanceContext) => {
    sink ??= (event) =>
      context.emit({ type: event.type, tenantId: options.operatorTenant, data: event.data });
  };

  const patchNode = (id: string, patch: Partial<StorageNodeRecord>) =>
    write((tx) => tx.update('nodes', { id, tenantId: SCOPE }, { ...patch, updatedAt: now() }));

  async function loadNode(nodeId: string) {
    const node = await db.findOne<StorageNodeRecord>('nodes', { id: nodeId, tenantId: SCOPE });
    if (!node || node.state === 'removed') throw notFound('Storage node');
    return node;
  }

  const operator = (context: PluginContext) => {
    if (context.tenantId !== options.operatorTenant)
      throw new BetterFilesError('FORBIDDEN', 'Storage is run from the operator tenant');
  };
  const adminOperation = { action: ADMIN, target: 'tenant', mutates: false } as const;
  const publicOperation = {
    action: 'better-files:storage:agent',
    target: 'public',
    mutates: false,
  } as const;
  const nodeInput = v.object({ nodeId: v.id() });

  const plugin = definePlugin({
    id: 'storage',
    actions: [ADMIN],
    endpoints: {
      /** A single-use join token for a new node; hand it to the node through its environment. */
      createJoinToken: endpoint({
        operation: adminOperation,
        input: v.object({
          ttlSeconds: v.optional(v.number({ int: true, min: 60, max: 7 * 86_400 })),
          zone: v.optional(v.string({ max: 64 })),
        }),
        async handler(context, input) {
          operator(context);
          const value = `bfj_${randomBytes(24).toString('base64url')}`;
          const expiresAt = now() + (input.ttlSeconds ?? 3600) * 1000;
          await write((tx) =>
            tx.insert('joinTokens', {
              id: prefixedId('sjt', now()),
              tenantId: SCOPE,
              tokenHash: hashToken(value),
              ...(input.zone ? { zone: input.zone } : {}),
              expiresAt,
              createdBy: context.principal.id,
              createdAt: now(),
            }),
          );
          return { token: value, expiresAt };
        },
      }),
      nodes: endpoint({
        operation: adminOperation,
        input: v.object({ includeRemoved: v.optional(v.boolean()) }),
        async handler(context, input) {
          operator(context);
          return (await allNodes())
            .filter((node) => input.includeRemoved || node.state !== 'removed')
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(view);
        },
      }),
      status: endpoint({
        operation: adminOperation,
        input: v.object({}),
        async handler(context) {
          operator(context);
          return status();
        },
      }),
      cordon: endpoint({
        operation: adminOperation,
        input: nodeInput,
        async handler(context, input) {
          operator(context);
          await loadNode(input.nodeId);
          await patchNode(input.nodeId, { cordoned: true });
          return view(await loadNode(input.nodeId));
        },
      }),
      uncordon: endpoint({
        operation: adminOperation,
        input: nodeInput,
        async handler(context, input) {
          operator(context);
          await loadNode(input.nodeId);
          await patchNode(input.nodeId, { cordoned: false });
          return view(await loadNode(input.nodeId));
        },
      }),
      /** Moves every object off a node (reconcile does the copying), before maintenance or removal. */
      drain: endpoint({
        operation: adminOperation,
        input: nodeInput,
        async handler(context, input) {
          operator(context);
          await loadNode(input.nodeId);
          await patchNode(input.nodeId, { state: 'draining' });
          return view(await loadNode(input.nodeId));
        },
      }),
      /** Returns a draining node to service. */
      activate: endpoint({
        operation: adminOperation,
        input: nodeInput,
        async handler(context, input) {
          operator(context);
          await loadNode(input.nodeId);
          await patchNode(input.nodeId, { state: 'active' });
          return view(await loadNode(input.nodeId));
        },
      }),
      /** Removes a node once it holds nothing (drain it first); `force` accepts losing its copies. */
      remove: endpoint({
        operation: adminOperation,
        input: v.object({ nodeId: v.id(), force: v.optional(v.boolean()) }),
        async handler(context, input) {
          operator(context);
          const node = await loadNode(input.nodeId);
          const held = await db.count('replicas', { tenantId: SCOPE, nodeId: node.id });
          if (held > 0 && !input.force)
            throw new BetterFilesError(
              'CONFLICT',
              `${node.name} still holds ${held} object copies: drain it first`,
            );
          await db.transaction(async (tx) => {
            if (held) {
              const replicas = await tx.findMany<ReplicaRecord>('replicas', {
                where: { tenantId: SCOPE, nodeId: node.id },
              });
              await tx.delete('replicas', { tenantId: SCOPE, nodeId: node.id });
              for (const objectId of new Set(replicas.map((replica) => replica.objectId))) {
                const stored = await tx.count('replicas', {
                  tenantId: SCOPE,
                  objectId,
                  state: 'stored',
                });
                await tx.update(
                  'objects',
                  { id: objectId, tenantId: SCOPE },
                  { replicas: stored, updatedAt: now() },
                );
              }
            }
            await tx.delete('commands', { tenantId: SCOPE, nodeId: node.id });
            // A generation bump revokes the node's secret: its tokens and heartbeats stop verifying.
            await tx.update(
              'nodes',
              { id: node.id, tenantId: SCOPE },
              { state: 'removed', generation: node.generation + 1, updatedAt: now() },
            );
          });
          emit('storage.node.removed', { nodeId: node.id, name: node.name, droppedCopies: held });
          return { removed: node.id, droppedCopies: held };
        },
      }),
      reconcile: endpoint({
        operation: adminOperation,
        input: v.object({ verify: v.optional(v.number({ int: true, min: 0, max: 10_000 })) }),
        async handler(context, input) {
          operator(context);
          return reconcile(input.verify === undefined ? {} : { verify: input.verify });
        },
      }),
      sync: endpoint({
        operation: adminOperation,
        input: v.object({}),
        async handler(context) {
          operator(context);
          return sync();
        },
      }),

      // Agent protocol: no IAM decision on fleet paths; the join token or the node's signature is the credential.
      join: endpoint({
        operation: publicOperation,
        input: v.object({
          token: v.string({ min: 10, max: 200 }),
          name: v.string({ min: 1, max: 100, pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/ }),
          zone: v.optional(v.string({ max: 64 })),
          url: v.string({ min: 8, max: 500, pattern: /^https?:\/\/[^\s]+$/ }),
          capacityBytes: v.number({ min: 0 }),
          version: v.string({ max: 32 }),
        }),
        async handler(context, input) {
          if (context.tenantId !== options.operatorTenant) throw notFound('Cluster');
          const at = now();
          const record = await db.findOne<JoinTokenRecord>('joinTokens', {
            tenantId: SCOPE,
            tokenHash: hashToken(input.token),
          });
          if (!record || record.usedAt || record.expiresAt <= at)
            throw new BetterFilesError('FORBIDDEN', 'The join token is invalid, used or expired');
          const nodeId = prefixedId('snode', at);
          const zone = record.zone ?? input.zone;
          await db.transaction(async (tx) => {
            const claimed = await tx.update(
              'joinTokens',
              { id: record.id, tenantId: SCOPE, usedAt: { isNull: true } },
              { usedAt: at, nodeId },
            );
            if (claimed !== 1)
              throw new BetterFilesError('FORBIDDEN', 'The join token is invalid, used or expired');
            await tx.insert('nodes', {
              id: nodeId,
              tenantId: SCOPE,
              name: input.name,
              ...(zone ? { zone } : {}),
              url: input.url,
              state: 'active',
              cordoned: false,
              generation: 1,
              capacityBytes: input.capacityBytes,
              usedBytes: 0,
              freeBytes: input.capacityBytes,
              objects: 0,
              version: input.version,
              lastSeenAt: at,
              lastHeartbeat: 0,
              updatedAt: at,
              createdAt: at,
            });
          });
          emit('storage.node.joined', {
            nodeId,
            name: input.name,
            zone: zone ?? null,
            url: input.url,
          });
          return {
            nodeId,
            secret: deriveNodeSecret(options.secret, nodeId, 1),
            generation: 1,
            heartbeatMs,
          };
        },
      }),
      heartbeat: endpoint({
        operation: publicOperation,
        input: v.object({
          nodeId: v.id(),
          timestamp: v.number({ int: true, min: 0 }),
          body: v.string({ max: 1_000_000 }),
          signature: v.string({ min: 20, max: 100 }),
        }),
        async handler(context, input) {
          if (context.tenantId !== options.operatorTenant) throw notFound('Cluster');
          const node = await db.findOne<StorageNodeRecord>('nodes', {
            id: input.nodeId,
            tenantId: SCOPE,
          });
          if (
            !node ||
            node.state === 'removed' ||
            !verifyHeartbeat(secretOf(node), node.id, input.timestamp, input.body, input.signature)
          )
            throw new BetterFilesError('UNAUTHENTICATED', 'Unknown node or bad signature');
          const at = now();
          // Fresh and in order: a captured heartbeat cannot be replayed.
          if (Math.abs(at - input.timestamp) > 5 * 60_000 || input.timestamp <= node.lastHeartbeat)
            throw new BetterFilesError('UNAUTHENTICATED', 'Stale heartbeat');
          const body = JSON.parse(input.body) as HeartbeatBody & { url?: string };
          const commands = await write(async (tx) => {
            await tx.update(
              'nodes',
              { id: node.id, tenantId: SCOPE },
              {
                lastSeenAt: at,
                lastHeartbeat: input.timestamp,
                capacityBytes: body.stats.capacityBytes,
                usedBytes: body.stats.usedBytes,
                freeBytes: body.stats.freeBytes,
                objects: body.stats.objects,
                version: body.version,
                ...(body.url && /^https?:\/\/[^\s]+$/.test(body.url) ? { url: body.url } : {}),
                updatedAt: at,
              },
            );
            for (const result of body.results ?? [])
              if (result.ok)
                await tx.delete('commands', { id: result.id, tenantId: SCOPE, nodeId: node.id });
            const due = await tx.findMany<CommandRecord>('commands', {
              where: { tenantId: SCOPE, nodeId: node.id },
              limit: 200,
            });
            const out: NodeCommand[] = [];
            for (const command of due) {
              // Sent and unanswered for a minute: send again (the node's delete is idempotent).
              if (command.state === 'sent' && (command.sentAt ?? 0) > at - 60_000) continue;
              await tx.update(
                'commands',
                { id: command.id, tenantId: SCOPE },
                { state: 'sent', sentAt: at },
              );
              out.push({ id: command.id, type: command.type, key: command.key });
            }
            return out;
          });
          return { heartbeatMs, commands };
        },
      }),
    },
    async maintain(context) {
      publishWith(context);
      await reconcile().catch((error: unknown) =>
        log.error?.('Storage reconcile failed', { error: String(error) }),
      );
    },
    async onEvent(_event, context) {
      publishWith(context);
    },
  });

  return {
    storage,
    plugin,
    schema,
    /** Creates the cluster index tables. */
    initialize: (): Promise<MigrationResult> => db.migrate(schema),
    reconcile,
    sync,
    verify,
    status,
    nodes: async () => (await allNodes()).map(view),
    close: async () => db.close?.(),
  };
}

export type StorageCluster = ReturnType<typeof storageCluster>;
