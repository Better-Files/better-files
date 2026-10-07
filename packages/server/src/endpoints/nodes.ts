import {
  Capability,
  createId,
  BetterFilesError,
  forbidden,
  hasAll,
  invalidInput,
  notFound,
  operationMatrix,
  prefixedId,
  resourceTypes,
  v,
  type DataRoomDocument,
  type DataRoomNode,
  type DocumentVersion,
  type Upload,
} from '@better-files/core';
import { assertNotRetained, auditSecurity, type CoreContext } from '../engine.js';
import { loadNode } from '../pipeline.js';
import {
  assertNameFree,
  children,
  createNode,
  moveNode,
  numberTree,
  restoreNode,
  subtree,
  trashNode,
  validateName,
} from '../tree.js';
import {
  coreEndpoint,
  nameSchema,
  nodeView,
  requireNode,
  requireRoom,
  visibleViews,
} from './common.js';

const mimeSchema = v.optional(
  v.string({ max: 255, pattern: /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i }),
);

async function loadDocument(context: CoreContext, node: DataRoomNode): Promise<DataRoomDocument> {
  const document = await context.db.findOne<DataRoomDocument>('documents', {
    id: node.id,
    tenantId: node.tenantId,
  });
  if (!document) throw notFound('Document');
  return document;
}

/** The items among `nodeIds` a hook retains (legal holds, retention rules), with the reason. */
async function retainedItems(
  context: CoreContext,
  roomId: string,
  nodeIds: readonly string[],
): Promise<Map<string, string>> {
  const retained = new Map<string, string>();
  const reasonFor = async (ids: readonly string[]) => {
    for (const hooks of context.engine.hooks) {
      const reason = await hooks.retains?.({
        db: context.db,
        tenantId: context.tenantId,
        roomId,
        nodeIds: ids,
      });
      if (reason) return reason;
    }
    return undefined;
  };
  // One question for the whole set first: most moves involve nothing retained.
  if (nodeIds.length === 0 || !(await reasonFor(nodeIds))) return retained;
  for (const id of nodeIds) {
    const reason = await reasonFor([id]);
    if (reason) retained.set(id, reason);
  }
  return retained;
}

async function rename(context: CoreContext, kind: 'folder' | 'document', name: string) {
  const node = requireNode(context, kind);
  if (!node.parentId) throw invalidInput('The root folder cannot be renamed');
  const valid = validateName(name);
  await assertNameFree(
    context.db,
    { tenantId: node.tenantId, roomId: node.roomId, parentId: node.parentId },
    valid.nameKey,
    node.id,
  );
  await context.db.update(
    'nodes',
    { id: node.id, tenantId: node.tenantId },
    { ...valid, updatedAt: context.now },
  );
  await context.activity({
    roomId: node.roomId,
    action: `${kind}.renamed`,
    nodeId: node.id,
    metadata: { from: node.name, to: valid.name },
  });
  context.emit(`${kind}.renamed`, { nodeId: node.id, name: valid.name });
  return nodeView(context, { ...node, ...valid, updatedAt: context.now });
}

async function move(context: CoreContext, kind: 'folder' | 'document', destinationId: string) {
  const node = requireNode(context, kind);
  const destination = await loadNode(context.db, context.tenantId, destinationId);
  if (destination.roomId !== node.roomId) throw notFound('Folder');
  const masks = await context.capabilitiesOf([destination]);
  const mask = masks.get(destination.id) ?? 0;
  if ((mask & Capability.LIST) === 0) throw notFound('Folder');
  if (!hasAll(mask, Capability.UPLOAD)) throw forbidden('You cannot add items to that folder');
  // A hold or retention rule on a folder covers its subtree, so moving content out of that folder would release
  // it. Items retained before the move must still be retained after it (the transaction rolls back otherwise).
  const affected = (await subtree(context.db, context.tenantId, node.id)).map(
    (row) => row.descendantId,
  );
  const retainedBefore = await retainedItems(context, node.roomId, affected);
  const moved = await moveNode(context.db, node, destination, context.now);
  if (retainedBefore.size) {
    const retainedAfter = await retainedItems(context, node.roomId, [...retainedBefore.keys()]);
    for (const [id, reason] of retainedBefore)
      if (!retainedAfter.has(id))
        throw new BetterFilesError('LEGAL_HOLD', `${reason}; moving them there would release them`);
  }
  await context.activity({
    roomId: node.roomId,
    action: `${kind}.moved`,
    nodeId: node.id,
    metadata: { from: node.parentId, to: destination.id },
  });
  context.emit(`${kind}.moved`, { nodeId: node.id, parentId: destination.id });
  return nodeView(context, moved);
}

async function trash(context: CoreContext, kind: 'folder' | 'document') {
  const node = requireNode(context, kind);
  const affected = (await subtree(context.db, context.tenantId, node.id)).map(
    (row) => row.descendantId,
  );
  await assertNotRetained(context.engine, context.db, {
    tenantId: context.tenantId,
    roomId: node.roomId,
    nodeIds: affected,
  });
  const count = await trashNode(context.db, node, context.now);
  await context.activity({
    roomId: node.roomId,
    action: `${kind}.deleted`,
    nodeId: node.id,
    metadata: { items: count },
  });
  context.emit(`${kind}.deleted`, { nodeId: node.id, items: count });
  return { deleted: count };
}

/**
 * Earlier versions are for people who may edit the document. Replacing a version (a redaction, a corrected
 * draft) must not leave the old content to everyone who can read the current one.
 */
async function seesHistory(context: CoreContext, node: DataRoomNode) {
  const masks = await context.capabilitiesOf([node]);
  return hasAll(masks.get(node.id) ?? 0, Capability.EDIT);
}

type Variant = 'original' | 'watermarked' | 'view';

async function requestFile(
  context: CoreContext,
  input: { versionId?: string | undefined; disposition?: 'attachment' | 'inline' | undefined },
  variant: Variant,
) {
  const room = requireRoom(context);
  const node = requireNode(context, 'document');
  const document = await loadDocument(context, node);
  const versionId = input.versionId ?? document.currentVersionId;
  if (!versionId) throw new BetterFilesError('CONFLICT', 'The document has no content yet');
  if (versionId !== document.currentVersionId && !(await seesHistory(context, node)))
    throw forbidden('Earlier versions need edit access to the document');
  const version = await context.db.findOne<DocumentVersion>('versions', {
    id: versionId,
    tenantId: node.tenantId,
    documentId: node.id,
  });
  if (!version) throw notFound('Version');
  if (version.status === 'quarantined' || version.status === 'processing')
    throw new BetterFilesError('QUARANTINED', 'The file is still being checked');
  if (version.status !== 'ready')
    throw new BetterFilesError('CONFLICT', `The file is ${version.status}`);
  if (room.settings.requireMfaForDownload && variant !== 'view' && !context.principal.mfa)
    throw new BetterFilesError(
      'MFA_REQUIRED',
      'Sign in with a second factor to download from this room',
    );
  for (const hooks of context.engine.hooks)
    await hooks.beforeDownload?.({ context, room, node, variant });
  const disposition = variant === 'view' ? 'inline' : (input.disposition ?? 'attachment');
  const ticket = await context.engine.files.issueTicket(context, {
    room,
    document,
    version,
    variant,
    disposition,
  });
  await context.activity({
    roomId: room.id,
    action: variant === 'view' ? 'document.viewed' : 'document.downloaded',
    nodeId: node.id,
    metadata: { variant, versionId: version.id, version: version.number },
  });
  if (variant === 'original')
    auditSecurity(context, {
      action: 'better-files:documents:download-original',
      resource: { type: resourceTypes.document, id: node.id },
      metadata: { roomId: room.id, versionId: version.id, filename: version.filename },
    });
  for (const hooks of context.engine.hooks)
    await hooks.afterDownload?.({ context, room, node, variant });
  context.emit(variant === 'view' ? 'document.viewed' : 'document.downloaded', {
    nodeId: node.id,
    variant,
    versionId: version.id,
  });
  return { ...ticket, filename: version.filename, size: version.size, variant };
}

const ticketInput = v.object({
  nodeId: v.id(),
  versionId: v.optional(v.id()),
  disposition: v.optional(v.enum(['attachment', 'inline'] as const)),
});

export const folderEndpoints = {
  create: coreEndpoint({
    operation: operationMatrix['folders.create'],
    input: v.object({ parentId: v.id(), name: nameSchema }),
    target: (input) => ({ nodeId: input.parentId }),
    async handler(context, input) {
      const parent = requireNode(context, 'folder');
      const node = await createNode(context.db, {
        tenantId: context.tenantId,
        roomId: parent.roomId,
        parent,
        kind: 'folder',
        name: input.name,
        createdBy: context.principal.id,
        now: context.now,
      });
      await context.activity({
        roomId: parent.roomId,
        action: 'folder.created',
        nodeId: node.id,
        metadata: { name: node.name },
      });
      context.emit('folder.created', { nodeId: node.id, parentId: parent.id, name: node.name });
      return nodeView(context, node);
    },
  }),
  list: coreEndpoint({
    operation: operationMatrix['folders.list'],
    input: v.object({ nodeId: v.id() }),
    target: (input) => ({ nodeId: input.nodeId }),
    async handler(context) {
      const folder = requireNode(context, 'folder');
      // The folder and its children in one pass, so the room floor, closure and matrix load once.
      const views = await visibleViews(context, [
        folder,
        ...(await children(context.db, context.tenantId, folder.id, { roomId: folder.roomId })),
      ]);
      const self = views[0]?.id === folder.id ? views.shift() : undefined;
      return { folder: self!, items: views };
    },
  }),
  rename: coreEndpoint({
    operation: operationMatrix['folders.rename'],
    input: v.object({ nodeId: v.id(), name: nameSchema }),
    target: (input) => ({ nodeId: input.nodeId }),
    handler: (context, input) => rename(context, 'folder', input.name),
  }),
  move: coreEndpoint({
    operation: operationMatrix['folders.move'],
    input: v.object({ nodeId: v.id(), destinationId: v.id() }),
    target: (input) => ({ nodeId: input.nodeId }),
    handler: (context, input) => move(context, 'folder', input.destinationId),
  }),
  delete: coreEndpoint({
    operation: operationMatrix['folders.delete'],
    input: v.object({ nodeId: v.id() }),
    target: (input) => ({ nodeId: input.nodeId }),
    handler: (context) => trash(context, 'folder'),
  }),
  /**
   * A ZIP of the folder as the caller may take it: every document under it they may download, current versions,
   * in index order. `watermarked` stamps each file for them (the watermark plugin) as it is zipped; `original`
   * needs original-download access per file. Documents they may not take are left out and counted.
   */
  requestDownload: coreEndpoint({
    operation: operationMatrix['folders.requestDownload'],
    input: v.object({
      nodeId: v.id(),
      variant: v.optional(v.enum(['watermarked', 'original'] as const)),
    }),
    target: (input) => ({ nodeId: input.nodeId }),
    async handler(context, input) {
      const room = requireRoom(context);
      const folder = requireNode(context, 'folder');
      const variant = input.variant ?? 'watermarked';
      const needed =
        variant === 'original' ? Capability.DOWNLOAD_ORIGINAL : Capability.DOWNLOAD_WATERMARKED;
      // Every ZIP variant is a download, originals included (single documents exempt only the viewer).
      if (room.settings.requireMfaForDownload && !context.principal.mfa)
        throw new BetterFilesError(
          'MFA_REQUIRED',
          'Sign in with a second factor to download from this room',
        );
      const pairs = await subtree(context.db, context.tenantId, folder.id);
      const nodes = pairs.length
        ? await context.db.findMany<DataRoomNode>('nodes', {
            where: {
              tenantId: context.tenantId,
              id: { in: pairs.map((pair) => pair.descendantId) },
              deletedAt: { isNull: true },
            },
          })
        : [];
      const masks = await context.capabilitiesOf(nodes);
      const listable = nodes.filter((node) => ((masks.get(node.id) ?? 0) & Capability.LIST) !== 0);
      const numbered = numberTree(listable, folder.id);
      const byId = new Map(numbered.map((entry) => [entry.node.id, entry]));
      const safe = (name: string) => name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
      const pathOf = (node: DataRoomNode): string => {
        const own = safe(node.name);
        const parent = node.parentId ? byId.get(node.parentId) : undefined;
        return parent ? `${pathOf(parent.node)}/${own}` : own;
      };
      const documents = numbered.filter((entry) => entry.node.kind === 'document');
      if (documents.length > context.engine.limits.maxBundleFiles)
        throw new BetterFilesError(
          'PAYLOAD_TOO_LARGE',
          `Folders are downloaded up to ${context.engine.limits.maxBundleFiles} files at a time`,
        );
      const allowed = documents.filter((entry) => ((masks.get(entry.node.id) ?? 0) & needed) !== 0);
      const rows = allowed.length
        ? await context.db.findMany<DataRoomDocument>('documents', {
            where: {
              tenantId: context.tenantId,
              id: { in: allowed.map((entry) => entry.node.id) },
            },
          })
        : [];
      const versionIds = rows.flatMap((row) =>
        row.currentVersionId ? [row.currentVersionId] : [],
      );
      const versions = versionIds.length
        ? await context.db.findMany<DocumentVersion>('versions', {
            where: { tenantId: context.tenantId, id: { in: versionIds }, status: 'ready' },
          })
        : [];
      const byDocument = new Map(versions.map((version) => [version.documentId, version]));
      const items = [];
      for (const entry of allowed) {
        const version = byDocument.get(entry.node.id);
        if (!version) continue;
        // Download hooks run per file: NDA gates, network rules and rate limits see every document.
        for (const hooks of context.engine.hooks)
          await hooks.beforeDownload?.({ context, room, node: entry.node, variant });
        items.push({
          path: pathOf(entry.node),
          nodeId: entry.node.id,
          versionId: version.id,
          size: version.size,
          ...(version.sha256 ? { sha256: version.sha256 } : {}),
        });
      }
      const record = {
        id: prefixedId('exp', context.now),
        tenantId: context.tenantId,
        roomId: room.id,
        principalId: context.principal.id,
        items,
        excluded: documents.length - items.length,
        includeActivity: false,
        folderId: folder.id,
        variant,
        label: `${safe(folder.parentId ? folder.name : room.name)}.zip`,
        expiresAt: context.now + 10 * 60_000,
        createdAt: context.now,
      };
      await context.db.transaction((tx) => tx.insert('exports', record));
      const ticket = await context.engine.files.issueExportTicket(context, record);
      await context.activity({
        roomId: room.id,
        action: 'folder.downloaded',
        nodeId: folder.id,
        metadata: { files: items.length, excluded: record.excluded, variant },
      });
      if (variant === 'original')
        auditSecurity(context, {
          action: 'better-files:documents:download-original',
          resource: { type: resourceTypes.folder, id: folder.id },
          metadata: { roomId: room.id, files: items.length },
        });
      context.emit('folder.downloaded', { nodeId: folder.id, files: items.length, variant });
      return {
        ...ticket,
        files: items.length,
        excluded: record.excluded,
        bytes: items.reduce((sum, item) => sum + item.size, 0),
      };
    },
  }),
  restore: coreEndpoint({
    operation: operationMatrix['folders.restore'],
    includeDeleted: true,
    input: v.object({ nodeId: v.id() }),
    target: (input) => ({ nodeId: input.nodeId }),
    handler: (context) => restore(context, 'folder'),
  }),
};

async function restore(context: CoreContext, kind?: 'folder' | 'document') {
  const node = requireNode(context, kind);
  const count = await restoreNode(context.db, node, context.now);
  await context.activity({
    roomId: node.roomId,
    action: `${node.kind}.restored`,
    nodeId: node.id,
    metadata: { items: count },
  });
  context.emit(`${node.kind}.restored`, { nodeId: node.id, items: count });
  return { restored: count };
}

export const documentEndpoints = {
  get: coreEndpoint({
    operation: operationMatrix['documents.get'],
    input: v.object({ nodeId: v.id() }),
    target: (input) => ({ nodeId: input.nodeId }),
    async handler(context) {
      const node = requireNode(context, 'document');
      const [view] = await visibleViews(context, [node]);
      const document = await loadDocument(context, node);
      const version = document.currentVersionId
        ? await context.db.findOne<DocumentVersion>('versions', {
            id: document.currentVersionId,
            tenantId: node.tenantId,
          })
        : null;
      return { ...view!, currentVersion: version ? versionView(version) : null };
    },
  }),
  rename: coreEndpoint({
    operation: operationMatrix['documents.rename'],
    input: v.object({ nodeId: v.id(), name: nameSchema }),
    target: (input) => ({ nodeId: input.nodeId }),
    handler: (context, input) => rename(context, 'document', input.name),
  }),
  move: coreEndpoint({
    operation: operationMatrix['documents.move'],
    input: v.object({ nodeId: v.id(), destinationId: v.id() }),
    target: (input) => ({ nodeId: input.nodeId }),
    handler: (context, input) => move(context, 'document', input.destinationId),
  }),
  delete: coreEndpoint({
    operation: operationMatrix['documents.delete'],
    input: v.object({ nodeId: v.id() }),
    target: (input) => ({ nodeId: input.nodeId }),
    handler: (context) => trash(context, 'document'),
  }),
  restore: coreEndpoint({
    operation: operationMatrix['documents.restore'],
    includeDeleted: true,
    input: v.object({ nodeId: v.id() }),
    target: (input) => ({ nodeId: input.nodeId }),
    // Restores folders too, for callers working from the trash listing, which mixes both kinds.
    handler: (context) => restore(context),
  }),
  setFlags: coreEndpoint({
    operation: operationMatrix['documents.setFlags'],
    input: v.object({
      nodeId: v.id(),
      flags: v.object({
        viewOnly: v.optional(v.boolean()),
        noPrint: v.optional(v.boolean()),
        noCopy: v.optional(v.boolean()),
      }),
    }),
    target: (input) => ({ nodeId: input.nodeId }),
    async handler(context, input) {
      const node = requireNode(context, 'document');
      const document = await loadDocument(context, node);
      const flags = { ...document.flags, ...input.flags };
      await context.db.update('documents', { id: node.id, tenantId: node.tenantId }, { flags });
      await context.activity({
        roomId: node.roomId,
        action: 'document.flags-changed',
        nodeId: node.id,
        metadata: { flags },
      });
      auditSecurity(context, {
        action: 'better-files:document.flags-changed',
        resource: { type: resourceTypes.document, id: node.id },
        metadata: { flags: JSON.stringify(flags) },
      });
      return { flags };
    },
  }),
  requestView: coreEndpoint({
    operation: operationMatrix['documents.requestView'],
    input: v.object({ nodeId: v.id(), versionId: v.optional(v.id()) }),
    target: (input) => ({ nodeId: input.nodeId }),
    handler: (context, input) => requestFile(context, input, 'view'),
  }),
  requestDownload: coreEndpoint({
    operation: operationMatrix['documents.requestDownload'],
    input: ticketInput,
    target: (input) => ({ nodeId: input.nodeId }),
    handler: (context, input) => requestFile(context, input, 'watermarked'),
  }),
  requestOriginal: coreEndpoint({
    operation: operationMatrix['documents.requestOriginal'],
    input: ticketInput,
    target: (input) => ({ nodeId: input.nodeId }),
    handler: (context, input) => requestFile(context, input, 'original'),
  }),
};

function versionView(version: DocumentVersion) {
  const { tenantId: _tenant, blobId: _blob, ...view } = version;
  return view;
}

export const versionEndpoints = {
  list: coreEndpoint({
    operation: operationMatrix['versions.list'],
    input: v.object({ nodeId: v.id() }),
    target: (input) => ({ nodeId: input.nodeId }),
    async handler(context) {
      const node = requireNode(context, 'document');
      const versions = await context.db.findMany<DocumentVersion>('versions', {
        where: { tenantId: node.tenantId, documentId: node.id },
        orderBy: [{ field: 'number', direction: 'desc' }],
      });
      if (await seesHistory(context, node)) return versions.map(versionView);
      const document = await loadDocument(context, node);
      return versions
        .filter((version) => version.id === document.currentVersionId)
        .map(versionView);
    },
  }),
  restore: coreEndpoint({
    operation: operationMatrix['versions.restore'],
    input: v.object({ nodeId: v.id(), versionId: v.id() }),
    target: (input) => ({ nodeId: input.nodeId }),
    async handler(context, input) {
      const node = requireNode(context, 'document');
      const version = await context.db.findOne<DocumentVersion>('versions', {
        id: input.versionId,
        tenantId: node.tenantId,
        documentId: node.id,
      });
      if (!version || version.status !== 'ready') throw notFound('Version');
      await context.db.update(
        'documents',
        { id: node.id, tenantId: node.tenantId },
        { currentVersionId: version.id, size: version.size, mimeType: version.mimeType ?? null },
      );
      await context.activity({
        roomId: node.roomId,
        action: 'version.restored',
        nodeId: node.id,
        metadata: { version: version.number },
      });
      context.emit('version.restored', { nodeId: node.id, versionId: version.id });
      return versionView(version);
    },
  }),
};

async function uploadTarget(
  input: { uploadId: string },
  lookup: { db: CoreContext['db']; tenantId: string },
) {
  const upload = await lookup.db.findOne<Upload>('uploads', {
    id: input.uploadId,
    tenantId: lookup.tenantId,
  });
  if (!upload) throw notFound('Upload');
  return { nodeId: upload.targetId };
}

async function ownUpload(context: CoreContext, uploadId: string): Promise<Upload> {
  const upload = await context.db.findOne<Upload>('uploads', {
    id: uploadId,
    tenantId: context.tenantId,
  });
  if (!upload || upload.createdBy !== context.principal.id) throw notFound('Upload');
  return upload;
}

export const uploadEndpoints = {
  create: coreEndpoint({
    operation: operationMatrix['uploads.create'],
    input: v.object({
      /** The folder a new document goes into. */
      parentId: v.optional(v.id()),
      /** Or the document this is a new version of. */
      documentId: v.optional(v.id()),
      filename: nameSchema,
      size: v.number({ int: true, min: 0 }),
      mimeType: mimeSchema,
      sha256: v.optional(v.string({ pattern: /^[a-fA-F0-9]{64}$/ })),
      comment: v.optional(v.string({ max: 1000 })),
      /**
       * Upload straight to object storage: the response carries presigned part URLs and the encryption parameters,
       * the client encrypts and PUTs each part, then completes with the parts' ETags.
       */
      direct: v.optional(v.boolean()),
    }),
    target(input) {
      if ((input.parentId === undefined) === (input.documentId === undefined))
        throw invalidInput('Give either parentId (a new document) or documentId (a new version)');
      return { nodeId: (input.documentId ?? input.parentId)! };
    },
    async handler(context, input) {
      const { engine } = context;
      const room = requireRoom(context);
      const target = requireNode(context, input.documentId ? 'document' : 'folder');
      if (input.size > engine.limits.maxFileSize)
        throw new BetterFilesError(
          'PAYLOAD_TOO_LARGE',
          `Files are limited to ${engine.limits.maxFileSize} bytes`,
        );
      const { name } = validateName(input.filename);
      if (!input.documentId)
        await assertNameFree(
          context.db,
          { tenantId: context.tenantId, roomId: room.id, parentId: target.id },
          validateName(name).nameKey,
        );
      for (const hooks of engine.hooks)
        await hooks.beforeUpload?.({
          context,
          room,
          node: target,
          filename: name,
          size: input.size,
          ...(input.mimeType ? { mimeType: input.mimeType } : {}),
        });
      const blob = await engine.files.newBlob({
        tenantId: context.tenantId,
        room,
        size: input.size,
        now: context.now,
      });
      if (input.direct && !engine.storage.multipart?.presignPart)
        throw new BetterFilesError(
          'UNSUPPORTED',
          'The storage adapter does not support direct uploads',
        );
      // Direct uploads always go through the store's multipart API, even as a single part.
      const multipart =
        engine.storage.multipart !== undefined &&
        (input.direct === true || input.size > engine.limits.partSize);
      const multipartId = multipart
        ? (await engine.storage.multipart!.create(blob.storageKey)).uploadId
        : undefined;
      const upload: Upload = {
        id: createId('upload', context.now),
        tenantId: context.tenantId,
        roomId: room.id,
        targetId: target.id,
        mode: input.documentId ? 'version' : 'document',
        filename: name,
        ...(input.mimeType ? { mimeType: input.mimeType.toLowerCase() } : {}),
        size: input.size,
        ...(input.sha256 ? { sha256: input.sha256.toLowerCase() } : {}),
        ...(input.comment ? { comment: input.comment } : {}),
        blobId: blob.id,
        storageKey: blob.storageKey,
        ...(multipartId ? { multipartId } : {}),
        partSize: engine.limits.partSize,
        status: 'pending',
        createdBy: context.principal.id,
        expiresAt: context.now + engine.limits.uploadTtlMs,
        createdAt: context.now,
      };
      await context.db.insert('blobs', blob);
      await context.db.insert('uploads', upload);
      const base = `${engine.basePath}/uploads/${upload.id}`;
      return {
        uploadId: upload.id,
        multipart,
        partSize: upload.partSize,
        parts: multipart ? engine.files.partCount(upload) : 1,
        /** PUT the whole file here (single uploads). */
        contentUrl: `${base}/content?tenantId=${encodeURIComponent(context.tenantId)}`,
        /** PUT each part here, replacing {part} with 1…parts (multipart uploads). */
        partUrl: `${base}/parts/{part}?tenantId=${encodeURIComponent(context.tenantId)}`,
        expiresAt: upload.expiresAt,
        ...(input.direct
          ? {
              direct: await engine.files.directUpload(
                upload,
                blob,
                Math.max(60, Math.floor((upload.expiresAt - context.now) / 1000)),
              ),
            }
          : {}),
      };
    },
  }),
  complete: coreEndpoint({
    operation: operationMatrix['uploads.complete'],
    transaction: 'manual',
    input: v.object({
      uploadId: v.id(),
      /** Direct uploads: each part's ETag as the object store returned it. */
      parts: v.optional(
        v.array(
          v.object({ part: v.number({ int: true, min: 1 }), etag: v.string({ min: 1, max: 256 }) }),
          {
            max: 10_000,
          },
        ),
      ),
    }),
    target: uploadTarget,
    async handler(context, input) {
      const { engine } = context;
      const room = requireRoom(context);
      const target = requireNode(context);
      const upload = await ownUpload(context, input.uploadId);
      if (upload.status !== 'pending' && upload.status !== 'uploaded')
        throw new BetterFilesError('CONFLICT', `The upload is ${upload.status}`);
      if (upload.expiresAt <= context.now)
        throw new BetterFilesError('CONFLICT', 'The upload has expired');
      if (input.parts) {
        if (!upload.multipartId) throw invalidInput('This upload was not made in parts');
        const count = engine.files.partCount(upload);
        await context.db.transaction(async (tx) => {
          await tx.delete('uploadParts', { tenantId: context.tenantId, uploadId: upload.id });
          for (const { part, etag } of input.parts!) {
            if (part > count) throw invalidInput(`This upload has ${count} parts`);
            const start = (part - 1) * upload.partSize;
            await tx.insert('uploadParts', {
              id: createId('upload', context.now),
              tenantId: context.tenantId,
              uploadId: upload.id,
              part,
              etag,
              size: Math.min(upload.partSize, upload.size - start),
              createdAt: context.now,
            });
          }
        });
      }
      const { sha256 } = await engine.files.finish(upload);
      const result = await context.db.transaction(async (tx) => {
        const txContext = context.rebind(tx);
        let documentNode = target;
        if (upload.mode === 'document') {
          documentNode = await createNode(tx, {
            tenantId: context.tenantId,
            roomId: room.id,
            parent: target,
            kind: 'document',
            name: upload.filename,
            createdBy: context.principal.id,
            now: context.now,
          });
          await tx.insert('documents', {
            id: documentNode.id,
            tenantId: context.tenantId,
            roomId: room.id,
            latestVersion: 0,
            size: 0,
            flags: {},
            createdAt: context.now,
          } satisfies DataRoomDocument);
        }
        const number = await tx.increment(
          'documents',
          { id: documentNode.id, tenantId: context.tenantId },
          'latestVersion',
        );
        const version: DocumentVersion = {
          id: createId('version', context.now),
          tenantId: context.tenantId,
          roomId: room.id,
          documentId: documentNode.id,
          number: number!,
          blobId: upload.blobId,
          status: 'ready',
          filename: upload.filename,
          ...(upload.mimeType ? { mimeType: upload.mimeType } : {}),
          sha256,
          size: upload.size,
          uploadedBy: context.principal.id,
          ...(upload.comment ? { comment: upload.comment } : {}),
          createdAt: context.now,
        };
        await tx.insert('versions', version);
        await tx.update(
          'documents',
          { id: documentNode.id, tenantId: context.tenantId },
          { currentVersionId: version.id, size: upload.size, mimeType: upload.mimeType ?? null },
        );
        if (upload.mode === 'version')
          await tx.update(
            'nodes',
            { id: documentNode.id, tenantId: context.tenantId },
            { updatedAt: context.now },
          );
        await tx.update(
          'uploads',
          { id: upload.id, tenantId: context.tenantId },
          { status: 'completed', receivedSha256: sha256 },
        );
        await tx.delete('uploadParts', { tenantId: context.tenantId, uploadId: upload.id });
        await txContext.activity({
          roomId: room.id,
          action: upload.mode === 'document' ? 'document.uploaded' : 'version.created',
          nodeId: documentNode.id,
          metadata: {
            filename: upload.filename,
            size: upload.size,
            version: version.number,
            sha256,
          },
        });
        for (const hooks of engine.hooks)
          await hooks.afterUpload?.({
            context: txContext,
            room,
            node: documentNode,
            versionId: version.id,
          });
        // Hooks may quarantine the version (scanning); report what they left.
        const final = await tx.findOne<DocumentVersion>('versions', {
          id: version.id,
          tenantId: context.tenantId,
        });
        return { node: documentNode, version: final ?? version };
      });
      context.emit(upload.mode === 'document' ? 'document.uploaded' : 'version.created', {
        nodeId: result.node.id,
        versionId: result.version.id,
        filename: upload.filename,
      });
      const [view] = await visibleViews(context, [result.node]);
      return {
        document: view ?? nodeView(context, result.node),
        version: versionView(result.version),
      };
    },
  }),
  abort: coreEndpoint({
    operation: operationMatrix['uploads.abort'],
    input: v.object({ uploadId: v.id() }),
    target: uploadTarget,
    async handler(context, input) {
      const upload = await ownUpload(context, input.uploadId);
      if (upload.status === 'completed')
        throw new BetterFilesError('CONFLICT', 'The upload is complete');
      await discardUpload(context, upload);
      return { aborted: true as const };
    },
  }),
};

/** Removes an unfinished upload's stored bytes and rows. */
export async function discardUpload(
  context: Pick<CoreContext, 'db' | 'storage' | 'logger'>,
  upload: Upload,
) {
  try {
    if (upload.multipartId)
      await context.storage.multipart?.abort(upload.storageKey, upload.multipartId);
    await context.storage.delete(upload.storageKey);
  } catch (error) {
    context.logger.warn('Could not remove an abandoned upload', {
      key: upload.storageKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  await context.db.transaction(async (tx) => {
    await tx.delete('uploadParts', { tenantId: upload.tenantId, uploadId: upload.id });
    await tx.delete('blobs', { tenantId: upload.tenantId, id: upload.blobId });
    await tx.update('uploads', { id: upload.id, tenantId: upload.tenantId }, { status: 'aborted' });
  });
}
