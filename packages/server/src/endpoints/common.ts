import {
  Capability,
  BetterFilesError,
  forbidden,
  invalidInput,
  notFound,
  v,
  type DataRoomDocument,
  type DataRoomNode,
  type EndpointDefinition,
  type Room,
  type StandardSchemaV1,
} from '@better-files/core';
import type { CoreContext } from '../engine.js';

/** Declares a core endpoint; its handler receives the engine as well as the plugin context. */
export const coreEndpoint = <Input extends StandardSchemaV1, Output>(
  definition: EndpointDefinition<Input, Output, CoreContext>,
): EndpointDefinition<Input, Output, CoreContext> => definition;

export const settingsSchema = v.object({
  downloadsEnabled: v.optional(v.boolean()),
  printEnabled: v.optional(v.boolean()),
  requireMfaForDownload: v.optional(v.boolean()),
  requireAncestorList: v.optional(v.boolean()),
  trashRetentionDays: v.optional(v.number({ int: true, min: 1, max: 3650 })),
  classification: v.optional(v.string({ min: 1, max: 64, pattern: /^[a-z0-9][a-z0-9_-]*$/ })),
});

export const nameSchema = v.string({ min: 1, max: 255, trim: true });
export const fieldsSchema = v.optional(v.record(v.json({ maxBytes: 4096 }), { maxKeys: 64 }));

/** Room as returned by the API: encryption and chain internals stay on the server. */
export function roomView(room: Room) {
  const { kmsKeyId: _key, activityHash: _hash, activitySequence: _sequence, ...view } = room;
  // Host-defined fields (`schema.rooms.additionalFields`) come along; `dr.$Infer.Room` has their exact types.
  return view as typeof view & { [field: string]: unknown };
}

export type RoomView = ReturnType<typeof roomView>;

export interface NodeView {
  id: string;
  roomId: string;
  parentId?: string;
  kind: 'folder' | 'document';
  name: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
  capabilities?: string[];
  document?: {
    currentVersionId?: string;
    latestVersion: number;
    size: number;
    mimeType?: string;
    flags: DataRoomDocument['flags'];
  };
  [field: string]: unknown;
}

export function nodeView(
  context: CoreContext,
  node: DataRoomNode,
  extra: { mask?: number; document?: DataRoomDocument } = {},
): NodeView {
  const { nameKey: _key, sortKey: _sort, deletedWith: _with, tenantId: _tenant, ...view } = node;
  return {
    ...view,
    ...(extra.mask === undefined ? {} : { capabilities: context.capabilities.namesOf(extra.mask) }),
    ...(extra.document
      ? {
          document: {
            ...(extra.document.currentVersionId
              ? { currentVersionId: extra.document.currentVersionId }
              : {}),
            latestVersion: extra.document.latestVersion,
            size: extra.document.size,
            ...(extra.document.mimeType ? { mimeType: extra.document.mimeType } : {}),
            flags: extra.document.flags,
          },
        }
      : {}),
  };
}

/** Views for many nodes with their capabilities and document details, keeping only what the caller may LIST. */
export async function visibleViews(
  context: CoreContext,
  nodes: readonly DataRoomNode[],
): Promise<NodeView[]> {
  if (nodes.length === 0) return [];
  // One fetch serves both the access engine (document clamps) and the views.
  const documentIds = nodes.filter((node) => node.kind === 'document').map((node) => node.id);
  const documents = documentIds.length
    ? await context.db.findMany<DataRoomDocument>('documents', {
        where: { tenantId: context.tenantId, id: { in: documentIds } },
      })
    : [];
  const byId = new Map(documents.map((document) => [document.id, document]));
  const masks = await context.capabilitiesOf(nodes, { documents: byId });
  const visible = nodes.filter((node) => ((masks.get(node.id) ?? 0) & Capability.LIST) !== 0);
  return visible.map((node) =>
    nodeView(context, node, {
      mask: masks.get(node.id) ?? 0,
      ...(byId.has(node.id) ? { document: byId.get(node.id)! } : {}),
    }),
  );
}

export function requireRoom(context: CoreContext): Room {
  if (!context.room) throw new BetterFilesError('INTERNAL_ERROR', 'Operation has no room target');
  return context.room;
}

export function requireNode(context: CoreContext, kind?: 'folder' | 'document'): DataRoomNode {
  const node = context.node;
  if (!node) throw new BetterFilesError('INTERNAL_ERROR', 'Operation has no node target');
  if (kind && node.kind !== kind) throw invalidInput(`Expected a ${kind}`);
  return node;
}

/** A second identity-system decision inside an operation (for example granting a role needs more than inviting). */
export async function requireAction(context: CoreContext, action: string) {
  const room = requireRoom(context);
  const decision = await context.engine.iam.authz.authorize(context.credential, {
    tenantId: context.tenantId,
    action,
    resource: { type: 'better-files-room', id: room.id },
  });
  if (!decision.allowed) throw forbidden();
}

/**
 * Validates host-defined additional fields (`schema.rooms.additionalFields`) passed through the API: only declared,
 * non-core fields of the right type are accepted.
 */
export function additionalFields(
  context: CoreContext,
  model: string,
  fields: Record<string, unknown> | undefined,
  options: { requireAll?: boolean } = {},
): Record<string, unknown> {
  const table = context.engine.schema.tables[model];
  if (!table) throw notFound('Table');
  // Only fields the host declared in schema are writable through the API; plugin fields belong to the plugin.
  const hostFields =
    (
      context.engine.options.schema as
        | Record<string, { additionalFields?: object } | undefined>
        | undefined
    )?.[model]?.additionalFields ?? {};
  const declared = Object.keys(hostFields).flatMap((name) =>
    table.fields[name] ? [table.fields[name]] : [],
  );
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(fields ?? {})) {
    const field = declared.find((candidate) => candidate.name === name);
    if (!field) throw invalidInput(`Unknown field ${name}`);
    if (value === null) {
      if (field.required) throw invalidInput(`${name} is required`);
      out[name] = null;
      continue;
    }
    const ok =
      (field.type === 'string' && typeof value === 'string' && value.length <= 10_000) ||
      ((field.type === 'number' || field.type === 'timestamp') &&
        typeof value === 'number' &&
        Number.isFinite(value)) ||
      (field.type === 'boolean' && typeof value === 'boolean') ||
      (field.type === 'enum' &&
        typeof value === 'string' &&
        (field.values ?? []).includes(value)) ||
      field.type === 'json';
    if (!ok) throw invalidInput(`${name} has the wrong type`);
    out[name] = value;
  }
  if (options.requireAll)
    for (const field of declared)
      if (field.required && out[field.name] === undefined && field.name !== 'id')
        throw invalidInput(`${field.name} is required`);
  return out;
}

export const slugify = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'room';
