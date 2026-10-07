import {
  BetterFilesError,
  defineTable,
  definePlugin,
  endpoint,
  field,
  notFound,
  prefixedId,
  v,
  type DataRoomNode,
  type PluginContext,
} from '@better-files/core';
import type { Connector, RemoteItem } from './providers.js';

export { box, dropbox, googleDrive, microsoftGraph } from './providers.js';
export type { Connector, ConnectorCall, RemoteItem } from './providers.js';

export interface ConnectorsOptions {
  connectors: readonly Connector[];
  /**
   * The caller's OAuth access token for a provider, from your app's own OAuth flow and token store. Called before
   * each provider request, so it can refresh. Throw (or return undefined) when the user has not connected it.
   */
  token(input: {
    connector: string;
    principalId: string;
    tenantId: string;
  }): Promise<string | undefined>;
  /** Files per import. Default 2000. */
  maxFiles?: number;
  /** Largest file imported. Default 250 MiB. */
  maxBytes?: number;
  fetch?: typeof fetch;
}

export interface ConnectorImport {
  id: string;
  tenantId: string;
  roomId: string;
  connector: string;
  destinationId: string;
  status: 'running' | 'done' | 'failed';
  imported: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: { name: string; message: string }[];
  createdBy: string;
  finishedAt?: number;
  updatedAt: number;
  createdAt: number;
}

interface ConnectorLink {
  id: string;
  tenantId: string;
  roomId: string;
  connector: string;
  remoteId: string;
  nodeId: string;
  revision?: string;
  updatedAt: number;
}

const USE = 'better-files:connectors:use';

/** Remote names may hold characters room names refuse. */
const safeName = (name: string) =>
  name
    .replace(/[\u0000-\u001f\u007f/\\]/g, '_')
    .trim()
    .slice(0, 255) || 'untitled';

const itemSchema = v.object({
  id: v.string({ min: 1, max: 512 }),
  name: v.string({ min: 1, max: 1024 }),
  kind: v.enum(['folder', 'file'] as const),
  mimeType: v.optional(v.string({ max: 255 })),
  size: v.optional(v.number({ min: 0 })),
  revision: v.optional(v.string({ max: 512 })),
});

/**
 * Imports from cloud drives into a room: pick files and folders from `connectors.browse`, then `connectors.import`
 * copies them (folders become folders) in the background, encrypted like any upload and recorded as the caller's.
 * Importing again brings changed files in as new versions and skips the rest. Needs `UPLOAD` on the destination.
 */
export function connectorsPlugin(options: ConnectorsOptions) {
  const byId = new Map(options.connectors.map((connector) => [connector.id, connector]));
  const maxFiles = options.maxFiles ?? 2000;
  const maxBytes = options.maxBytes ?? 250 * 1024 * 1024;
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));

  function connectorOf(id: string) {
    const connector = byId.get(id);
    if (!connector) throw new BetterFilesError('INVALID_INPUT', `Unknown connector ${id}`);
    return connector;
  }

  async function tokenFor(context: PluginContext, connector: Connector) {
    const token = await options.token({
      connector: connector.id,
      principalId: context.principal.id,
      tenantId: context.tenantId,
    });
    if (!token) throw new BetterFilesError('FORBIDDEN', `Connect ${connector.label} first`);
    return token;
  }

  async function folderNamed(
    context: PluginContext,
    parent: DataRoomNode,
    name: string,
  ): Promise<string> {
    const existing = await context.db.findOne<DataRoomNode>('nodes', {
      tenantId: context.tenantId,
      parentId: parent.id,
      nameKey: name.toLocaleLowerCase('en-US'),
      deletedAt: { isNull: true },
    });
    if (existing?.kind === 'folder') return existing.id;
    const created = await context.call<{ id: string }>('folders.create', {
      parentId: parent.id,
      name,
    });
    return created.id;
  }

  async function run(
    context: PluginContext,
    job: ConnectorImport,
    connector: Connector,
    items: RemoteItem[],
  ) {
    const counts = { imported: 0, updated: 0, skipped: 0, failed: 0 };
    const errors: { name: string; message: string }[] = [];
    let files = 0;
    const save = (patch: Partial<ConnectorImport>) =>
      context.db.transaction((tx) =>
        tx.update(
          'connectorImports',
          { id: job.id, tenantId: job.tenantId },
          { ...counts, errors: errors.slice(0, 50), updatedAt: Date.now(), ...patch },
        ),
      );
    const queue: { item: RemoteItem; parentId: string }[] = items.map((item) => ({
      item,
      parentId: job.destinationId,
    }));
    try {
      while (queue.length) {
        const { item, parentId } = queue.shift()!;
        const name = safeName(item.name);
        try {
          if (item.kind === 'folder') {
            const parent = await context.db.findOne<DataRoomNode>('nodes', {
              id: parentId,
              tenantId: job.tenantId,
            });
            if (!parent) throw notFound('Folder');
            const folderId = await folderNamed(context, parent, name);
            const children = await connector.list({
              token: await tokenFor(context, connector),
              fetch: doFetch,
              folderId: item.id,
            });
            queue.push(...children.map((child) => ({ item: child, parentId: folderId })));
            continue;
          }
          if (++files > maxFiles) {
            errors.push({ name, message: `Import limit of ${maxFiles} files reached` });
            counts.failed++;
            continue;
          }
          const link = await context.db.findOne<ConnectorLink>('connectorLinks', {
            tenantId: job.tenantId,
            roomId: job.roomId,
            connector: connector.id,
            remoteId: item.id,
          });
          const linked = link
            ? await context.db.findOne<DataRoomNode>('nodes', {
                id: link.nodeId,
                tenantId: job.tenantId,
                deletedAt: { isNull: true },
              })
            : undefined;
          if (linked && link!.revision && link!.revision === item.revision) {
            counts.skipped++;
            continue;
          }
          const file = await connector.download({
            token: await tokenFor(context, connector),
            fetch: doFetch,
            item,
            maxBytes,
          });
          const stored = await context.addDocument({
            ...(linked ? { versionOf: linked.id } : { parentId }),
            filename: safeName(file.filename),
            content: file.bytes,
            ...(file.mimeType ? { mimeType: file.mimeType } : {}),
            comment: `Imported from ${connector.label}`,
          });
          const record = {
            nodeId: stored.nodeId,
            ...(item.revision ? { revision: item.revision } : {}),
            updatedAt: Date.now(),
          };
          await context.db.transaction(async (tx) => {
            if (link)
              await tx.update('connectorLinks', { id: link.id, tenantId: job.tenantId }, record);
            else
              await tx.insert('connectorLinks', {
                id: prefixedId('clink'),
                tenantId: job.tenantId,
                roomId: job.roomId,
                connector: connector.id,
                remoteId: item.id,
                createdAt: Date.now(),
                ...record,
              });
          });
          if (linked) counts.updated++;
          else counts.imported++;
        } catch (error) {
          counts.failed++;
          errors.push({ name, message: error instanceof Error ? error.message : String(error) });
        }
        if ((counts.imported + counts.updated + counts.skipped + counts.failed) % 25 === 0)
          await save({});
      }
      await save({ status: 'done', finishedAt: Date.now() });
    } catch (error) {
      errors.push({ name: '', message: error instanceof Error ? error.message : String(error) });
      await save({ status: 'failed', finishedAt: Date.now() });
    }
    await context.activity({
      roomId: job.roomId,
      action: 'connector.imported',
      nodeId: job.destinationId,
      metadata: { connector: connector.id, importId: job.id, ...counts },
    });
    context.emit('connectors.import.finished', {
      importId: job.id,
      connector: connector.id,
      ...counts,
    });
  }

  return definePlugin({
    id: 'connectors',
    actions: [USE],
    accessModel: [
      { relations: ['owner', 'admin', 'publisher', 'editor', 'contributor'], actions: [USE] },
    ],
    schema: {
      connectorImports: defineTable({
        fields: {
          roomId: field.string(),
          connector: field.string(),
          destinationId: field.string(),
          status: field.enum(['running', 'done', 'failed'] as const),
          imported: field.number(),
          updated: field.number(),
          skipped: field.number(),
          failed: field.number(),
          errors: field.json<{ name: string; message: string }[]>(),
          createdBy: field.string(),
          finishedAt: field.timestamp({ required: false }),
          updatedAt: field.timestamp(),
        },
        indexes: [{ fields: ['tenantId', 'roomId'] }],
      }),
      connectorLinks: defineTable({
        fields: {
          roomId: field.string(),
          connector: field.string(),
          remoteId: field.string(),
          nodeId: field.string(),
          revision: field.string({ required: false }),
          updatedAt: field.timestamp(),
        },
        indexes: [{ fields: ['tenantId', 'roomId', 'connector', 'remoteId'], unique: true }],
      }),
    },
    endpoints: {
      /** The configured connectors. */
      list: endpoint({
        operation: { action: USE, target: 'room', mutates: false, allowClosed: true },
        input: v.object({ roomId: v.id() }),
        target: (input) => ({ roomId: input.roomId }),
        handler: async () => options.connectors.map(({ id, label }) => ({ id, label })),
      }),
      browse: endpoint({
        operation: { action: USE, target: 'room', mutates: false },
        input: v.object({
          roomId: v.id(),
          connector: v.string({ min: 1, max: 128 }),
          folderId: v.optional(v.string({ max: 512 })),
        }),
        target: (input) => ({ roomId: input.roomId }),
        async handler(context, input) {
          const connector = connectorOf(input.connector);
          const items = await connector.list({
            token: await tokenFor(context, connector),
            fetch: doFetch,
            ...(input.folderId ? { folderId: input.folderId } : {}),
          });
          return items.sort((a, b) =>
            a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1,
          );
        },
      }),
      import: endpoint({
        operation: { action: USE, target: 'node', capabilities: ['UPLOAD'], mutates: true },
        input: v.object({
          connector: v.string({ min: 1, max: 128 }),
          destinationId: v.id(),
          items: v.array(itemSchema, { min: 1, max: 500 }),
        }),
        target: (input) => ({ nodeId: input.destinationId }),
        async handler(context, input) {
          const connector = connectorOf(input.connector);
          const destination = context.node!;
          if (destination.kind !== 'folder')
            throw new BetterFilesError('INVALID_INPUT', 'Import into a folder');
          await tokenFor(context, connector);
          const now = context.now;
          const job: ConnectorImport = {
            id: prefixedId('cimp', now),
            tenantId: context.tenantId,
            roomId: destination.roomId,
            connector: connector.id,
            destinationId: destination.id,
            status: 'running',
            imported: 0,
            updated: 0,
            skipped: 0,
            failed: 0,
            errors: [],
            createdBy: context.principal.id,
            updatedAt: now,
            createdAt: now,
          };
          await context.db.insert('connectorImports', job);
          const items: RemoteItem[] = input.items.map((item) => ({
            id: item.id,
            name: item.name,
            kind: item.kind,
            ...(item.mimeType ? { mimeType: item.mimeType } : {}),
            ...(item.size !== undefined ? { size: item.size } : {}),
            ...(item.revision ? { revision: item.revision } : {}),
          }));
          // The copy runs after this request commits; progress is in connectors.status.
          context.afterCommit((live) => run(live, job, connector, items));
          return { importId: job.id, status: job.status };
        },
      }),
      status: endpoint({
        operation: { action: USE, target: 'room', mutates: false, allowClosed: true },
        input: v.object({ importId: v.id() }),
        target: async (input, lookup) => {
          const job = await lookup.db.findOne<ConnectorImport>('connectorImports', {
            id: input.importId,
            tenantId: lookup.tenantId,
          });
          if (!job) throw notFound('Import');
          return { roomId: job.roomId };
        },
        async handler(context, input) {
          const job = await context.db.findOne<ConnectorImport>('connectorImports', {
            id: input.importId,
            tenantId: context.tenantId,
          });
          if (
            !job ||
            (job.createdBy !== context.principal.id &&
              !(await context.authorize('better-files:admin')))
          )
            throw notFound('Import');
          const { tenantId: _tenant, ...view } = job;
          return view;
        },
      }),
    },
  });
}
