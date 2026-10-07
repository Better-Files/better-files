import {
  Capability,
  createId,
  BetterFilesError,
  forbidden,
  hasAll,
  invalidInput,
  notFound,
  resourceTypes,
  validateInput,
  type Credential,
  type DatabaseAdapter,
  type DataRoomDocument,
  type DataRoomNode,
  type DocumentVersion,
  type EndpointDefinition,
  type JobEnvelope,
  type Principal,
  type Room,
  type StandardSchemaV1,
} from '@better-files/core';
import { recordActivity } from './activity.js';
import type { CoreContext, Engine } from './engine.js';
import { renditionStore } from './renditions.js';
import { createNode } from './tree.js';

/** Any core or plugin endpoint; handler parameters are checked where each endpoint is declared. */
export type AnyEndpoint = EndpointDefinition<StandardSchemaV1, unknown, CoreContext>;

export function splitTenant(raw: unknown): { tenantId: string; input: Record<string, unknown> } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw invalidInput('Input must be an object');
  const { tenantId, ...input } = raw as Record<string, unknown>;
  if (typeof tenantId !== 'string' || tenantId.length === 0 || tenantId.length > 128)
    throw invalidInput('tenantId is required');
  return { tenantId, input };
}

export async function loadRoom(
  db: DatabaseAdapter,
  tenantId: string,
  roomId: unknown,
): Promise<Room> {
  if (typeof roomId !== 'string') throw invalidInput('roomId is required');
  // Look up by id and tenant together: an id from another tenant is simply not found.
  const room = await db.findOne<Room>('rooms', { id: roomId, tenantId });
  if (!room || room.status === 'provisioning') throw notFound('Room');
  return room;
}

export async function loadNode(
  db: DatabaseAdapter,
  tenantId: string,
  nodeId: unknown,
  includeDeleted = false,
): Promise<DataRoomNode> {
  if (typeof nodeId !== 'string') throw invalidInput('nodeId is required');
  const node = await db.findOne<DataRoomNode>('nodes', { id: nodeId, tenantId });
  if (!node || (!includeDeleted && node.deletedAt !== undefined)) throw notFound('Node');
  return node;
}

export function assertWritable(room: Room) {
  if (room.status === 'closed' || room.status === 'archived')
    throw new BetterFilesError('ROOM_CLOSED', `The room is ${room.status}`);
}

export interface RequestInfo {
  ip?: string;
  userAgent?: string;
}

/** Builds the context handlers and hooks receive; effects queue until `flush` runs after commit. */
export function createContext(
  engine: Engine,
  base: { tenantId: string; principal: Principal; credential: Credential; request?: RequestInfo },
) {
  const after: {
    fn: (context: CoreContext) => Promise<void> | void;
    target: { room?: Room; node?: DataRoomNode };
  }[] = [];
  const events: { type: string; roomId?: string; data: Record<string, unknown> }[] = [];
  const jobs: JobEnvelope[] = [];
  const publish = (event: { type: string; roomId?: string; data: Record<string, unknown> }) =>
    engine.events.publish({
      type: event.type,
      tenantId: base.tenantId,
      actorId: base.principal.id,
      occurredAt: engine.clock.now(),
      data: event.data,
      ...(event.roomId ? { roomId: event.roomId } : {}),
    });
  const logFailure = (error: unknown) =>
    engine.logger.error('Better Files post-commit step failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  /**
   * `live` contexts are for work after the commit (and background work started from it): their events publish at
   * once and their after-commit steps run at once, since there is no transaction left to wait for.
   */
  const make = (
    db: DatabaseAdapter,
    target: { room?: Room; node?: DataRoomNode },
    live = false,
  ): CoreContext => {
    const context: CoreContext = {
      engine,
      rebind: (other) => make(other, target, live),
      tenantId: base.tenantId,
      principal: base.principal,
      credential: base.credential,
      db,
      storage: engine.storage,
      now: engine.clock.now(),
      logger: engine.logger,
      capabilities: engine.capabilities,
      ...(target.room ? { room: target.room } : {}),
      ...(target.node ? { node: target.node } : {}),
      ...(base.request ? { request: base.request } : {}),
      async capabilitiesOf(nodes, options) {
        const room = target.room;
        if (!room)
          throw new BetterFilesError('INTERNAL_ERROR', 'capabilitiesOf needs a room target');
        return engine.access.capabilities({
          db,
          credential: base.credential,
          principal: base.principal,
          room,
          nodes,
          context,
          ...(options?.documents ? { documents: options.documents } : {}),
        });
      },
      async activity(event) {
        await db.transaction((tx) =>
          recordActivity(tx, {
            tenantId: base.tenantId,
            actorId: base.principal.id,
            createdAt: engine.clock.now(),
            ...event,
            ...(base.request?.ip ? { ip: base.request.ip } : {}),
            ...(base.request?.userAgent ? { userAgent: base.request.userAgent.slice(0, 512) } : {}),
          }),
        );
      },
      emit(type, data, options) {
        const event = { type, data, ...(target.room ? { roomId: target.room.id } : {}) };
        if (live || options?.immediate) void publish(event);
        else events.push(event);
      },
      afterCommit(fn) {
        if (live) void Promise.resolve(fn(make(engine.db, target, true))).catch(logFailure);
        else after.push({ fn, target });
      },
      async enqueue(name, payload, options) {
        // Written on the context's database: inside a mutating endpoint, its transaction.
        const { envelope, fresh } = await engine.jobs.insert(
          db,
          base.tenantId,
          name,
          payload,
          options,
        );
        if (fresh) {
          if (live) await engine.jobs.dispatch([envelope]);
          else jobs.push(envelope);
        }
        return envelope;
      },
      readVersion: (versionId) => engine.files.readVersion(base.tenantId, versionId),
      renditions: renditionStore(engine, db, base.tenantId),
      async addDocument(input) {
        const { tenantId } = base;
        // The context's database: inside a mutating endpoint that is its transaction, which this joins.
        const anchor = await loadNode(db, tenantId, input.versionOf ?? input.parentId);
        if (input.versionOf ? anchor.kind !== 'document' : anchor.kind !== 'folder')
          throw new BetterFilesError(
            'INVALID_INPUT',
            input.versionOf ? 'versionOf must be a document' : 'parentId must be a folder',
          );
        const room = await loadRoom(db, tenantId, anchor.roomId);
        const now = engine.clock.now();
        const actorId = input.actorId ?? base.principal.id;
        const blob = await engine.files.newBlob({
          tenantId,
          room,
          size: input.content.byteLength,
          now,
        });
        const sha256 = await engine.files.storeBytes(blob, input.content);
        const stored = await db.transaction(async (tx) => {
          await tx.insert('blobs', blob);
          let documentId = anchor.id;
          let documentNode = anchor;
          if (!input.versionOf) {
            // Keep the requested name, adding " (2)", " (3)" … when the folder already has it.
            const dot = input.filename.lastIndexOf('.');
            const stem = dot > 0 ? input.filename.slice(0, dot) : input.filename;
            const extension = dot > 0 ? input.filename.slice(dot) : '';
            let name = input.filename;
            for (
              let n = 2;
              await tx.findOne('nodes', {
                tenantId,
                parentId: anchor.id,
                nameKey: name.toLocaleLowerCase('en-US'),
                deletedAt: { isNull: true },
              });
              n++
            )
              name = `${stem} (${n})${extension}`;
            const node = await createNode(tx, {
              tenantId,
              roomId: room.id,
              parent: anchor,
              kind: 'document',
              name,
              createdBy: actorId,
              now,
            });
            await tx.insert('documents', {
              id: node.id,
              tenantId,
              roomId: room.id,
              latestVersion: 0,
              size: 0,
              flags: {},
              createdAt: now,
            });
            documentId = node.id;
            documentNode = node;
          }
          const number = await tx.increment(
            'documents',
            { id: documentId, tenantId },
            'latestVersion',
          );
          const versionId = createId('version', now);
          await tx.insert('versions', {
            id: versionId,
            tenantId,
            roomId: room.id,
            documentId,
            number: number!,
            blobId: blob.id,
            status: 'ready',
            filename: input.filename,
            ...(input.mimeType ? { mimeType: input.mimeType } : {}),
            sha256,
            size: input.content.byteLength,
            uploadedBy: actorId,
            ...(input.comment ? { comment: input.comment } : {}),
            createdAt: now,
          });
          await tx.update(
            'documents',
            { id: documentId, tenantId },
            {
              currentVersionId: versionId,
              size: input.content.byteLength,
              mimeType: input.mimeType ?? null,
            },
          );
          await recordActivity(tx, {
            tenantId,
            roomId: room.id,
            actorId,
            action: input.versionOf ? 'version.created' : 'document.uploaded',
            nodeId: documentId,
            createdAt: now,
            metadata: {
              filename: input.filename,
              size: input.content.byteLength,
              sha256,
              generated: true,
            },
          });
          const event = {
            type: input.versionOf ? 'version.created' : 'document.uploaded',
            roomId: room.id,
            data: { nodeId: documentId, versionId, filename: input.filename },
          };
          events.push(event);
          // The same upload hooks as a client upload (scanning, processing); their after-commit work is queued.
          const hookContext = make(tx, { room, node: documentNode });
          for (const hooks of engine.hooks)
            await hooks.afterUpload?.({
              context: hookContext,
              room,
              node: documentNode,
              versionId,
            });
          return { nodeId: documentId, versionId, sha256 };
        });
        // A live context has no request left to flush for it: run the queued work now that the rows are committed.
        if (live) await flush();
        return stored;
      },
      async call(operation, input) {
        if (base.principal.id === 'anonymous') throw forbidden();
        const [group, method] = operation.split('.');
        const found = group && method ? engine.operations[group]?.[method] : undefined;
        if (!found || !Object.hasOwn(engine.operations[group!]!, method!))
          throw notFound('Operation');
        return runEndpoint(
          engine,
          found,
          base.credential,
          { ...input, tenantId: base.tenantId },
          base.request,
        ) as never;
      },
      async authorize(action, resource) {
        if (base.principal.id === 'anonymous') return false;
        const on =
          resource ??
          (target.room
            ? { type: resourceTypes.room, id: target.room.id }
            : { type: 'iam', id: base.tenantId });
        const decision = await engine.iam.authz.authorize(base.credential, {
          tenantId: base.tenantId,
          action,
          resource: on,
        });
        return decision.allowed;
      },
      async issueTicket(input) {
        const node = await loadNode(db, base.tenantId, input.documentId);
        if (node.kind !== 'document') throw notFound('Document');
        const room = await loadRoom(db, base.tenantId, node.roomId);
        const document = await db.findOne<DataRoomDocument>('documents', {
          id: node.id,
          tenantId: base.tenantId,
        });
        const versionId = input.versionId ?? document?.currentVersionId;
        const version = versionId
          ? await db.findOne<DocumentVersion>('versions', {
              id: versionId,
              tenantId: base.tenantId,
              documentId: node.id,
            })
          : null;
        if (!document || !version) throw notFound('Version');
        if (version.status !== 'ready')
          throw new BetterFilesError('QUARANTINED', 'The file is not available yet');
        return engine.files.issueTicket(context, {
          room,
          document,
          version,
          variant: input.variant,
          disposition: input.disposition ?? (input.variant === 'view' ? 'inline' : 'attachment'),
          ...(input.recipient ? { recipient: input.recipient } : {}),
        });
      },
    };
    return context;
  };
  async function flush() {
    for (const event of events.splice(0)) await publish(event);
    await engine.jobs.dispatch(jobs.splice(0));
    for (const { fn, target } of after.splice(0))
      try {
        await fn(make(engine.db, target, true));
      } catch (error) {
        logFailure(error);
      }
  }
  const discard = () => {
    after.length = 0;
    events.length = 0;
    jobs.length = 0;
  };
  return { make, flush, discard };
}

/**
 * Runs one endpoint: validate, authenticate, resolve the target, check the permission matrix (layer A) and the
 * identity-system decision (layer B) immediately before the handler, then run it — in one transaction when it
 * mutates — and deliver its after-commit effects and events.
 */
export async function runEndpoint(
  engine: Engine,
  endpoint: AnyEndpoint,
  credential: Credential,
  raw: unknown,
  request?: RequestInfo,
): Promise<unknown> {
  const definition = endpoint;
  const { tenantId, input: rawInput } = splitTenant(raw);
  const input = await validateInput(definition.input, rawInput);
  const operation = definition.operation;
  if (operation.target === 'public') {
    // No credential and no identity-system decision: the handler checks its own bearer secret (share links).
    const anonymous: Principal = {
      id: 'anonymous',
      tenantId,
      kind: 'service',
      groups: [],
      guest: true,
      mfa: false,
    };
    const scope = createContext(engine, {
      tenantId,
      principal: anonymous,
      credential: {},
      ...(request ? { request } : {}),
    });
    let result: unknown;
    try {
      result = await (operation.mutates
        ? engine.db.transaction((tx) => definition.handler(scope.make(tx, {}), input))
        : definition.handler(scope.make(engine.db, {}), input));
    } catch (error) {
      scope.discard();
      throw error;
    }
    await scope.flush();
    return result;
  }
  const principal = await engine.iam.identity.authenticate(credential, tenantId);
  const scope = createContext(engine, {
    tenantId,
    principal,
    credential,
    ...(request ? { request } : {}),
  });

  let room: Room | undefined;
  let node: DataRoomNode | undefined;
  let resource: { type: string; id: string };
  if (operation.target === 'tenant') {
    // Tenant-wide operations are authorized on the tenant, as Better IAM authorizes plugin endpoints.
    resource = { type: 'iam', id: tenantId };
  } else {
    const target = (await definition.target?.(input, { db: engine.db, tenantId })) ?? {};
    if (operation.target === 'room') {
      room = await loadRoom(engine.db, tenantId, target.roomId);
      if (operation.mutates && !operation.allowClosed) assertWritable(room);
      resource = { type: resourceTypes.room, id: room.id };
    } else {
      node = await loadNode(engine.db, tenantId, target.nodeId, definition.includeDeleted === true);
      room = await loadRoom(engine.db, tenantId, node.roomId);
      if (operation.mutates && !operation.allowClosed) assertWritable(room);
      const masks = await engine.access.capabilities({
        db: engine.db,
        credential,
        principal,
        room,
        nodes: [node],
        context: scope.make(engine.db, { room, node }),
      });
      const mask = masks.get(node.id) ?? 0;
      const required = engine.capabilities.mask(operation.capabilities ?? []);
      // Without LIST the node does not exist for this caller; do not confirm that it does.
      if ((mask & Capability.LIST) === 0) throw notFound('Node');
      if (!hasAll(mask, required)) throw forbidden();
      resource = {
        type: node.kind === 'folder' ? resourceTypes.folder : resourceTypes.document,
        id: node.id,
      };
    }
  }

  const decision = await engine.iam.authz.authorize(credential, {
    tenantId,
    action: operation.action,
    resource,
  });
  if (!decision.allowed) {
    if (definition.denied) return definition.denied();
    throw forbidden();
  }

  const target = { ...(room ? { room } : {}), ...(node ? { node } : {}) };
  if (room && !operation.ungated)
    for (const hooks of engine.hooks) {
      if (!hooks.gateRoom) continue;
      const gate = await hooks.gateRoom({
        context: scope.make(engine.db, target),
        room,
        ...(node ? { node } : {}),
        operation,
      });
      if (gate === undefined) continue;
      scope.discard();
      throw typeof gate === 'string'
        ? forbidden(gate)
        : new BetterFilesError(gate.code, gate.message);
    }
  let result: unknown;
  try {
    if (!operation.mutates || definition.transaction === 'manual')
      result = await definition.handler(scope.make(engine.db, target), input);
    else
      result = await engine.db.transaction((tx) =>
        definition.handler(scope.make(tx, target), input),
      );
  } catch (error) {
    scope.discard();
    throw error;
  }
  await scope.flush();
  return result;
}
