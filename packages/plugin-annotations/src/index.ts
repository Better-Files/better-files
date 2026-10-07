import {
  Capability,
  BetterFilesError,
  defineTable,
  definePlugin,
  endpoint,
  field,
  notFound,
  prefixedId,
  v,
  type DataRoomDocument,
  type DataRoomNode,
  type PluginContext,
} from '@better-files/core';

export type Visibility = 'private' | 'group' | 'room';

export interface Annotation {
  id: string;
  tenantId: string;
  roomId: string;
  nodeId: string;
  versionId: string;
  /** 1-based page; absent for whole-document notes. */
  page?: number;
  /** Area on the page, as fractions of its width and height (0–1), origin top-left. */
  rect?: { x: number; y: number; width: number; height: number };
  /** The highlighted text, when the note is on a selection. */
  quote?: string;
  body: string;
  visibility: Visibility;
  /** The permission group a `group` note is shared with. */
  groupId?: string;
  /** The note this one replies to. */
  parentId?: string;
  authorId: string;
  authorName?: string;
  resolvedAt?: number;
  resolvedBy?: string;
  updatedAt: number;
  createdAt: number;
}

interface GroupRow {
  id: string;
  name: string;
  iamGroupId: string;
}

const rectSchema = v.object({
  x: v.number({ min: 0, max: 1 }),
  y: v.number({ min: 0, max: 1 }),
  width: v.number({ min: 0, max: 1 }),
  height: v.number({ min: 0, max: 1 }),
});

async function loadAnnotation(context: PluginContext, id: string) {
  const annotation = await context.db.findOne<Annotation>('annotations', {
    id,
    tenantId: context.tenantId,
  });
  if (!annotation) throw notFound('Annotation');
  return annotation;
}

const annotationTarget = async (
  input: { annotationId: string },
  lookup: { db: PluginContext['db']; tenantId: string },
) => {
  const annotation = await lookup.db.findOne<Annotation>('annotations', {
    id: input.annotationId,
    tenantId: lookup.tenantId,
  });
  if (!annotation) throw notFound('Annotation');
  return { nodeId: annotation.nodeId };
};

/** Whether the caller may read a note: their own, their group's, or room-wide. */
async function readable(
  context: PluginContext,
  annotation: Annotation,
  groups: Map<string, GroupRow>,
) {
  if (annotation.authorId === context.principal.id) return true;
  if (annotation.visibility === 'room') return true;
  if (annotation.visibility === 'group' && annotation.groupId) {
    const group = groups.get(annotation.groupId);
    return !!group && context.principal.groups.includes(group.iamGroupId);
  }
  return false;
}

/**
 * Annotations: notes and highlights on documents, anchored to a page and area, with replies and resolution.
 * Visibility is chosen per note: `private` (the author only; administrators cannot read it either), `group`
 * (a permission group the author belongs to, such as one bidder's team) or `room` (everyone who may view the
 * document; needs `EDIT`, for the sell side's guidance). The activity log records that a note exists, never its text.
 */
export function annotationsPlugin(options: { maxLength?: number } = {}) {
  const maxLength = options.maxLength ?? 10_000;
  const view = {
    action: 'better-files:documents:view',
    target: 'node',
    capabilities: ['VIEW'],
  } as const;

  async function roomGroups(context: PluginContext) {
    const groups = await context.db.findMany<GroupRow>('permissionGroups', {
      where: { tenantId: context.tenantId, roomId: context.room!.id },
    });
    return new Map(groups.map((group) => [group.id, group]));
  }

  const present = ({ tenantId: _tenant, ...annotation }: Annotation, callerId: string) => ({
    ...annotation,
    mine: annotation.authorId === callerId,
  });

  return definePlugin({
    id: 'annotations',
    schema: {
      annotations: defineTable({
        fields: {
          roomId: field.string(),
          nodeId: field.string(),
          versionId: field.string(),
          page: field.number({ required: false }),
          rect: field.json<{ x: number; y: number; width: number; height: number }>({
            required: false,
          }),
          quote: field.string({ required: false }),
          body: field.string(),
          visibility: field.enum(['private', 'group', 'room'] as const),
          groupId: field.string({ required: false }),
          parentId: field.string({ required: false }),
          authorId: field.string(),
          authorName: field.string({ required: false }),
          resolvedAt: field.timestamp({ required: false }),
          resolvedBy: field.string({ required: false }),
          updatedAt: field.timestamp(),
        },
        indexes: [{ fields: ['tenantId', 'nodeId'] }, { fields: ['tenantId', 'parentId'] }],
      }),
    },
    endpoints: {
      create: endpoint({
        operation: { ...view, mutates: true },
        input: v.object({
          nodeId: v.id(),
          body: v.string({ min: 1, max: maxLength, trim: true }),
          visibility: v.optional(v.enum(['private', 'group', 'room'] as const)),
          groupId: v.optional(v.id()),
          page: v.optional(v.number({ int: true, min: 1, max: 100_000 })),
          rect: v.optional(rectSchema),
          quote: v.optional(v.string({ max: 2000 })),
          parentId: v.optional(v.id()),
        }),
        target: (input) => ({ nodeId: input.nodeId }),
        async handler(context, input) {
          const node = context.node!;
          if (node.kind !== 'document')
            throw new BetterFilesError('INVALID_INPUT', 'Annotate documents');
          const document = await context.db.findOne<DataRoomDocument>('documents', {
            id: node.id,
            tenantId: context.tenantId,
          });
          if (!document?.currentVersionId)
            throw new BetterFilesError('CONFLICT', 'The document has no content yet');
          const groups = await roomGroups(context);
          let visibility: Visibility = input.visibility ?? 'private';
          let groupId = input.groupId;
          let versionId = document.currentVersionId;
          if (input.parentId) {
            // A reply is seen by exactly who sees the note it answers.
            const parent = await loadAnnotation(context, input.parentId);
            if (parent.nodeId !== node.id || !(await readable(context, parent, groups)))
              throw notFound('Annotation');
            visibility = parent.visibility;
            groupId = parent.groupId;
            versionId = parent.versionId;
          } else if (visibility === 'group') {
            const mine = [...groups.values()].filter((group) =>
              context.principal.groups.includes(group.iamGroupId),
            );
            const group = groupId ? groups.get(groupId) : mine.length === 1 ? mine[0] : undefined;
            if (!group)
              throw new BetterFilesError(
                'INVALID_INPUT',
                'Name one of your groups to share the note with',
              );
            if (!context.principal.groups.includes(group.iamGroupId))
              throw new BetterFilesError('FORBIDDEN', 'Share notes only with groups you belong to');
            groupId = group.id;
          } else if (visibility === 'room') {
            const [mask] = [...(await context.capabilitiesOf([node])).values()];
            if (((mask ?? 0) & Capability.EDIT) === 0)
              throw new BetterFilesError(
                'FORBIDDEN',
                'Room-wide notes need edit access to the document',
              );
          }
          const annotation: Annotation = {
            id: prefixedId('ann', context.now),
            tenantId: context.tenantId,
            roomId: node.roomId,
            nodeId: node.id,
            versionId,
            ...(input.page ? { page: input.page } : {}),
            ...(input.rect ? { rect: input.rect } : {}),
            ...(input.quote ? { quote: input.quote } : {}),
            body: input.body,
            visibility,
            ...(visibility === 'group' && groupId ? { groupId } : {}),
            ...(input.parentId ? { parentId: input.parentId } : {}),
            authorId: context.principal.id,
            ...(context.principal.name ? { authorName: context.principal.name } : {}),
            updatedAt: context.now,
            createdAt: context.now,
          };
          await context.db.insert('annotations', annotation);
          await context.activity({
            roomId: node.roomId,
            action: 'annotation.created',
            nodeId: node.id,
            metadata: { visibility, ...(input.parentId ? { reply: true } : {}) },
          });
          // Shared notes can notify their readers; private ones stay private.
          if (visibility !== 'private')
            context.emit('annotation.created', {
              nodeId: node.id,
              annotationId: annotation.id,
              visibility,
              ...(annotation.groupId ? { groupId: annotation.groupId } : {}),
            });
          return present(annotation, context.principal.id);
        },
      }),
      list: endpoint({
        operation: { ...view, mutates: false, allowClosed: true },
        input: v.object({
          nodeId: v.id(),
          versionId: v.optional(v.id()),
          includeResolved: v.optional(v.boolean()),
        }),
        target: (input) => ({ nodeId: input.nodeId }),
        async handler(context, input) {
          const groups = await roomGroups(context);
          const rows = await context.db.findMany<Annotation>('annotations', {
            where: {
              tenantId: context.tenantId,
              nodeId: context.node!.id,
              ...(input.versionId ? { versionId: input.versionId } : {}),
            },
            orderBy: [{ field: 'createdAt' }],
            limit: 2000,
          });
          const visible: Annotation[] = [];
          for (const row of rows) if (await readable(context, row, groups)) visible.push(row);
          const resolvedThreads = new Set(
            visible.filter((row) => row.resolvedAt && !row.parentId).map((row) => row.id),
          );
          return visible
            .filter(
              (row) =>
                input.includeResolved ||
                !(
                  resolvedThreads.has(row.id) ||
                  (row.parentId && resolvedThreads.has(row.parentId))
                ),
            )
            .map((row) => ({
              ...present(row, context.principal.id),
              ...(row.groupId ? { groupName: groups.get(row.groupId)?.name ?? null } : {}),
            }));
        },
      }),
      update: endpoint({
        operation: { ...view, mutates: true },
        input: v.object({
          annotationId: v.id(),
          body: v.optional(v.string({ min: 1, max: maxLength, trim: true })),
          resolved: v.optional(v.boolean()),
        }),
        target: annotationTarget,
        async handler(context, input) {
          const annotation = await loadAnnotation(context, input.annotationId);
          const groups = await roomGroups(context);
          if (!(await readable(context, annotation, groups))) throw notFound('Annotation');
          const own = annotation.authorId === context.principal.id;
          if (input.body !== undefined && !own)
            throw new BetterFilesError('FORBIDDEN', 'Only the author edits a note');
          // Resolving a shared thread is open to its readers; a private note, to its author (who is the only reader).
          const patch: Record<string, unknown> = {
            updatedAt: context.now,
            ...(input.body !== undefined ? { body: input.body } : {}),
            ...(input.resolved === true
              ? { resolvedAt: context.now, resolvedBy: context.principal.id }
              : {}),
            ...(input.resolved === false ? { resolvedAt: null, resolvedBy: null } : {}),
          };
          await context.db.update(
            'annotations',
            { id: annotation.id, tenantId: context.tenantId },
            patch,
          );
          return present(await loadAnnotation(context, annotation.id), context.principal.id);
        },
      }),
      delete: endpoint({
        operation: { ...view, mutates: true },
        input: v.object({ annotationId: v.id() }),
        target: annotationTarget,
        async handler(context, input) {
          const annotation = await loadAnnotation(context, input.annotationId);
          const own = annotation.authorId === context.principal.id;
          // Moderators (MANAGE) may remove shared notes; nobody but the author touches a private one.
          if (!own) {
            const groups = await roomGroups(context);
            const [mask] = [
              ...(await context.capabilitiesOf([context.node as DataRoomNode])).values(),
            ];
            if (
              annotation.visibility === 'private' ||
              !(await readable(context, annotation, groups))
            )
              throw notFound('Annotation');
            if (((mask ?? 0) & Capability.MANAGE) === 0)
              throw new BetterFilesError(
                'FORBIDDEN',
                'Only the author or a moderator removes a note',
              );
          }
          await context.db.delete('annotations', {
            tenantId: context.tenantId,
            parentId: annotation.id,
          });
          await context.db.delete('annotations', { id: annotation.id, tenantId: context.tenantId });
          return { deleted: true as const };
        },
      }),
    },
  });
}
