import {
  BetterFilesError,
  defineTable,
  definePlugin,
  endpoint,
  field,
  notFound,
  prefixedId,
  v,
  type Infer,
  type PluginContext,
  type RoomSettings,
} from '@better-files/core';

/** A group's access on one folder: a preset name or explicit capabilities. */
interface AccessSpec {
  group: string;
  preset?: string;
  capabilities?: string[];
  locked?: boolean;
}

interface FolderSpec {
  name: string;
  children?: FolderSpec[];
  /** Group access set on this folder (groups by name, from `groups`). */
  access?: AccessSpec[];
}

const accessSchema = v.array(
  v.object({
    group: v.string({ min: 1, max: 120 }),
    preset: v.optional(v.string({ max: 48 })),
    capabilities: v.optional(v.array(v.string({ max: 48 }), { max: 32 })),
    locked: v.optional(v.boolean()),
  }),
  { max: 50 },
);

const folderSchema = (depth: number): ReturnType<typeof v.object> =>
  v.object({
    name: v.string({ min: 1, max: 255 }),
    access: v.optional(accessSchema),
    ...(depth > 0 ? { children: v.optional(v.array(folderSchema(depth - 1), { max: 100 })) } : {}),
  }) as ReturnType<typeof v.object>;

export const templateSchema = v.object({
  name: v.string({ min: 1, max: 120 }),
  description: v.optional(v.string({ max: 1000 })),
  folders: v.array(folderSchema(5), { max: 200 }),
  groups: v.optional(
    v.array(
      v.object({
        name: v.string({ min: 1, max: 120 }),
        kind: v.optional(v.enum(['internal', 'external', 'auditor'] as const)),
        relation: v.optional(
          v.enum(['viewer', 'contributor', 'editor', 'publisher', 'auditor'] as const),
        ),
        preset: v.optional(v.string({ max: 48 })),
      }),
      { max: 50 },
    ),
  ),
  settings: v.optional(
    v.object({
      downloadsEnabled: v.optional(v.boolean()),
      printEnabled: v.optional(v.boolean()),
      requireMfaForDownload: v.optional(v.boolean()),
      classification: v.optional(v.string({ max: 64, pattern: /^[a-z0-9][a-z0-9_-]*$/ })),
    }),
  ),
  checklists: v.optional(
    v.array(
      v.object({
        name: v.string({ min: 1, max: 120 }),
        tasks: v.array(
          v.object({
            title: v.string({ min: 1, max: 300 }),
            description: v.optional(v.string({ max: 2000 })),
            /** Due this many days after the template is applied. */
            dueInDays: v.optional(v.number({ int: true, min: 0, max: 3650 })),
          }),
          { max: 200 },
        ),
      }),
      { max: 20 },
    ),
  ),
});

export interface RoomTemplateDefinition {
  name: string;
  description?: string;
  folders: FolderSpec[];
  groups?: {
    name: string;
    kind?: 'internal' | 'external' | 'auditor';
    relation?: 'viewer' | 'contributor' | 'editor' | 'publisher' | 'auditor';
    preset?: string;
  }[];
  settings?: Pick<
    RoomSettings,
    'downloadsEnabled' | 'printEnabled' | 'requireMfaForDownload' | 'classification'
  >;
  checklists?: {
    name: string;
    tasks: { title: string; description?: string; dueInDays?: number }[];
  }[];
}
/** Kept in step with `RoomTemplateDefinition`; the schema validates what tenants save. */
export type ValidatedTemplate = Infer<typeof templateSchema>;
export interface RoomTemplate extends RoomTemplateDefinition {
  id: string;
  builtIn: boolean;
}

const folders = (...names: (string | [string, string[]])[]): FolderSpec[] =>
  names.map((entry) =>
    typeof entry === 'string'
      ? { name: entry }
      : { name: entry[0], children: entry[1].map((name) => ({ name })) },
  );

/** Templates every installation offers; hosts add their own per tenant. */
export const builtInTemplates: RoomTemplate[] = [
  {
    id: 'm-and-a-sell-side',
    builtIn: true,
    name: 'M&A sell-side',
    description:
      'A sell-side diligence room with the usual index, one group per bidder and a closing checklist.',
    folders: folders(
      [
        'Corporate',
        ['Constitutional documents', 'Board and shareholder minutes', 'Group structure'],
      ],
      ['Financial', ['Audited accounts', 'Management accounts', 'Budgets and forecasts']],
      ['Legal', ['Material contracts', 'Litigation', 'Regulatory']],
      'Commercial',
      ['Human resources', ['Employment contracts', 'Benefits and pensions']],
      'Intellectual property',
      'Information technology',
      'Real estate',
      'Tax',
    ),
    groups: [
      { name: 'Sell side', kind: 'internal', relation: 'editor', preset: 'editor' },
      { name: 'Advisors', kind: 'internal', relation: 'viewer', preset: 'downloadOriginal' },
      { name: 'Bidder A', kind: 'external', relation: 'viewer', preset: 'view' },
      { name: 'Bidder B', kind: 'external', relation: 'viewer', preset: 'view' },
    ],
    settings: { requireMfaForDownload: true, classification: 'confidential' },
    checklists: [
      {
        name: 'Closing',
        tasks: [
          { title: 'Upload audited accounts for the last three years', dueInDays: 7 },
          { title: 'Upload the material contracts register', dueInDays: 14 },
          { title: 'Answer all open Q&A', dueInDays: 30 },
          { title: 'Sign the share purchase agreement', dueInDays: 45 },
        ],
      },
    ],
  },
  {
    id: 'fundraising',
    builtIn: true,
    name: 'Fundraising',
    description:
      'An investor data room: pitch materials open to investors, detail behind a second tier.',
    folders: folders(
      'Pitch deck',
      'Financial model',
      'Cap table',
      ['Legal', ['Incorporation', 'Previous rounds']],
      'Product',
      'Team',
    ),
    groups: [
      { name: 'Company', kind: 'internal', relation: 'editor', preset: 'editor' },
      { name: 'Investors', kind: 'external', relation: 'viewer', preset: 'view' },
    ],
    settings: { downloadsEnabled: false },
  },
  {
    id: 'board-portal',
    builtIn: true,
    name: 'Board portal',
    folders: folders('Board packs', 'Minutes', 'Committee papers', 'Policies', 'Resolutions'),
    groups: [
      { name: 'Directors', kind: 'internal', relation: 'viewer', preset: 'downloadOriginal' },
      { name: 'Company secretary', kind: 'internal', relation: 'editor', preset: 'editor' },
    ],
    settings: { requireMfaForDownload: true },
  },
  {
    id: 'real-estate',
    builtIn: true,
    name: 'Real-estate transaction',
    folders: folders(
      'Title',
      'Surveys and inspections',
      'Leases',
      'Financing',
      'Closing documents',
    ),
    groups: [
      { name: 'Seller', kind: 'external', relation: 'contributor', preset: 'contributor' },
      { name: 'Buyer', kind: 'external', relation: 'viewer', preset: 'download' },
      { name: 'Agents', kind: 'internal', relation: 'editor', preset: 'editor' },
    ],
    checklists: [
      {
        name: 'Transaction',
        tasks: [
          { title: 'Title search received', dueInDays: 10 },
          { title: 'Inspection report uploaded', dueInDays: 14 },
          { title: 'Financing commitment uploaded', dueInDays: 30 },
          { title: 'Closing statement signed', dueInDays: 45 },
        ],
      },
    ],
  },
  {
    id: 'audit-evidence',
    builtIn: true,
    name: 'Audit evidence',
    folders: folders(
      'Requests',
      'Policies and procedures',
      'Access reviews',
      'Change management',
      'Incident response',
      'Vendor management',
    ),
    groups: [
      { name: 'Control owners', kind: 'internal', relation: 'contributor', preset: 'contributor' },
      { name: 'Auditors', kind: 'auditor', relation: 'auditor', preset: 'downloadOriginal' },
    ],
  },
  {
    id: 'litigation',
    builtIn: true,
    name: 'Litigation',
    folders: folders(
      'Pleadings',
      'Correspondence',
      'Discovery',
      'Expert reports',
      'Evidence',
      'Court orders',
    ),
    groups: [
      { name: 'Legal team', kind: 'internal', relation: 'editor', preset: 'editor' },
      { name: 'Counsel', kind: 'external', relation: 'viewer', preset: 'downloadOriginal' },
    ],
    settings: { classification: 'privileged', requireMfaForDownload: true },
  },
];

interface StoredTemplate {
  id: string;
  tenantId: string;
  definition: RoomTemplateDefinition;
  createdBy: string;
  updatedAt: number;
  createdAt: number;
}

async function findTemplate(context: PluginContext, id: string): Promise<RoomTemplate> {
  const builtIn = builtInTemplates.find((template) => template.id === id);
  if (builtIn) return builtIn;
  const stored = await context.db.findOne<StoredTemplate>('roomTemplates', {
    id,
    tenantId: context.tenantId,
  });
  if (!stored) throw notFound('Template');
  return { ...stored.definition, id: stored.id, builtIn: false };
}

interface NodeView {
  id: string;
  name: string;
  kind: string;
}

/** Applies a template to a room through the regular operations, so each step is authorized as the caller. */
async function apply(context: PluginContext, roomId: string, template: RoomTemplateDefinition) {
  const created = { folders: 0, groups: 0, tasks: 0, access: 0 };
  const room = await context.call<{ rootNodeId: string }>('rooms.get', { roomId });
  // Groups first: folder access names them.
  if (template.groups?.length) {
    const existing = await context.call<{ name: string }[]>('groups.list', { roomId });
    for (const group of template.groups) {
      if (existing.some((candidate) => candidate.name.toLowerCase() === group.name.toLowerCase()))
        continue;
      await context.call('groups.create', { roomId, ...group });
      created.groups++;
    }
  }
  const groupIds = new Map(
    (await context.call<{ id: string; name: string }[]>('groups.list', { roomId })).map((group) => [
      group.name.toLowerCase(),
      group.id,
    ]),
  );
  const addFolders = async (parentId: string, specs: readonly FolderSpec[]) => {
    const { items } = await context.call<{ items: NodeView[] }>('folders.list', {
      nodeId: parentId,
    });
    for (const spec of specs) {
      let folder = items.find(
        (item) => item.kind === 'folder' && item.name.toLowerCase() === spec.name.toLowerCase(),
      );
      if (!folder) {
        folder = await context.call<NodeView>('folders.create', { parentId, name: spec.name });
        created.folders++;
      }
      const entries = (spec.access ?? []).flatMap((entry) => {
        const id = groupIds.get(entry.group.toLowerCase());
        if (!id) return [];
        return [
          {
            subject: { type: 'group', id },
            ...(entry.capabilities
              ? { capabilities: entry.capabilities }
              : { preset: entry.preset ?? 'view' }),
            ...(entry.locked ? { locked: true } : {}),
          },
        ];
      });
      if (entries.length) {
        await context.call('permissions.setEntries', { nodeId: folder.id, entries });
        created.access += entries.length;
      }
      if (spec.children?.length) await addFolders(folder.id, spec.children);
    }
  };
  await addFolders(room.rootNodeId, template.folders);
  if (template.settings && Object.keys(template.settings).length)
    await context.call('rooms.update', { roomId, settings: template.settings });
  for (const checklist of template.checklists ?? [])
    for (const task of checklist.tasks) {
      try {
        await context.call('tasks.create', {
          roomId,
          checklist: checklist.name,
          title: task.title,
          ...(task.description ? { description: task.description } : {}),
          ...(task.dueInDays !== undefined
            ? { dueAt: context.now + task.dueInDays * 86_400_000 }
            : {}),
        });
        created.tasks++;
      } catch (error) {
        // Checklists need the tasks plugin; without it they are skipped.
        if ((error as { code?: string }).code === 'NOT_FOUND') break;
        throw error;
      }
    }
  return created;
}

/**
 * A template of an existing room: its folder tree, group access on each folder, groups, security settings and
 * checklists. Documents, people and person-specific access stay behind: a template is about roles, not individuals.
 */
async function capture(
  context: PluginContext,
  roomId: string,
  name?: string,
): Promise<RoomTemplateDefinition> {
  // Reading the room through the API checks the caller may see it.
  const room = await context.call<{
    id: string;
    name: string;
    rootNodeId: string;
    settings: Record<string, unknown>;
  }>('rooms.get', { roomId });
  // A template carries every folder, group and access entry, including those hidden from readers, so only people
  // who may read the room's permission matrix (MANAGE on the whole room) may take one.
  await context.call('permissions.getMatrix', { nodeId: room.rootNodeId });
  const { tenantId } = context;
  const [nodes, groups, entries] = await Promise.all([
    context.db.findMany<{
      id: string;
      parentId?: string;
      kind: string;
      name: string;
      sortKey: number;
    }>('nodes', {
      where: { tenantId, roomId, kind: 'folder', deletedAt: { isNull: true } },
    }),
    context.db.findMany<{
      name: string;
      kind: 'internal' | 'external' | 'auditor';
      relation: string;
      iamGroupId: string;
    }>('permissionGroups', { where: { tenantId, roomId } }),
    context.db.findMany<{
      nodeId: string;
      subjectType: string;
      subjectId: string;
      mask: number;
      locked: boolean;
    }>('aclEntries', { where: { tenantId, roomId, subjectType: 'group' } }),
  ]);
  const groupName = new Map(groups.map((group) => [group.iamGroupId, group.name]));
  const presetFor = (mask: number) =>
    Object.entries(context.capabilities.presets).find(([, value]) => value === mask)?.[0];
  const accessOn = (nodeId: string): AccessSpec[] =>
    entries
      .filter((entry) => entry.nodeId === nodeId && groupName.has(entry.subjectId))
      .map((entry) => {
        const preset = presetFor(entry.mask);
        return {
          group: groupName.get(entry.subjectId)!,
          ...(preset ? { preset } : { capabilities: context.capabilities.namesOf(entry.mask) }),
          ...(entry.locked ? { locked: true } : {}),
        };
      });
  const tree = (parentId: string): FolderSpec[] =>
    nodes
      .filter((node) => node.parentId === parentId)
      .sort((a, b) => a.sortKey - b.sortKey)
      .map((node) => {
        const children = tree(node.id);
        const access = accessOn(node.id);
        return {
          name: node.name,
          ...(children.length ? { children } : {}),
          ...(access.length ? { access } : {}),
        };
      });
  const relations = ['viewer', 'contributor', 'editor', 'publisher', 'auditor'] as const;
  const settings = room.settings as RoomSettings;
  let checklists: RoomTemplateDefinition['checklists'];
  try {
    const tasks = await context.db.findMany<{
      checklist?: string;
      title: string;
      description?: string;
      position: number;
    }>('tasks', { where: { tenantId, roomId }, orderBy: [{ field: 'position' }] });
    const byList = new Map<string, { title: string; description?: string }[]>();
    for (const task of tasks)
      byList.set(task.checklist ?? 'Checklist', [
        ...(byList.get(task.checklist ?? 'Checklist') ?? []),
        { title: task.title, ...(task.description ? { description: task.description } : {}) },
      ]);
    if (byList.size)
      checklists = [...byList].map(([list, items]) => ({ name: list, tasks: items }));
  } catch {
    // No tasks plugin: no checklists.
  }
  return {
    name: name ?? `${room.name} (template)`,
    folders: tree(room.rootNodeId),
    groups: groups.map((group) => {
      const root = entries.find(
        (entry) => entry.nodeId === room.rootNodeId && entry.subjectId === group.iamGroupId,
      );
      const preset = root ? presetFor(root.mask) : undefined;
      return {
        name: group.name,
        kind: group.kind,
        ...(relations.includes(group.relation as (typeof relations)[number])
          ? { relation: group.relation as (typeof relations)[number] }
          : {}),
        ...(preset ? { preset } : {}),
      };
    }),
    settings: {
      ...(settings.downloadsEnabled !== undefined
        ? { downloadsEnabled: settings.downloadsEnabled }
        : {}),
      ...(settings.printEnabled !== undefined ? { printEnabled: settings.printEnabled } : {}),
      ...(settings.requireMfaForDownload !== undefined
        ? { requireMfaForDownload: settings.requireMfaForDownload }
        : {}),
      ...(settings.classification ? { classification: settings.classification } : {}),
    },
    ...(checklists ? { checklists } : {}),
  };
}

/**
 * Room templates: folder skeletons, permission groups with presets, security settings and checklists. Ships
 * templates for M&A, fundraising, board portals, real estate, audit evidence and litigation; tenants save their own.
 */
export function templatesPlugin() {
  return definePlugin({
    id: 'templates',
    actions: ['better-files:templates:manage'],
    schema: {
      roomTemplates: defineTable({
        fields: {
          definition: field.json<RoomTemplateDefinition>(),
          createdBy: field.string(),
          updatedAt: field.timestamp(),
        },
      }),
    },
    endpoints: {
      list: endpoint({
        operation: { action: 'better-files:rooms:create', target: 'tenant', mutates: false },
        input: v.object({}),
        async handler(context) {
          const stored = await context.db.findMany<StoredTemplate>('roomTemplates', {
            where: { tenantId: context.tenantId },
          });
          return [
            ...builtInTemplates,
            ...stored.map((row) => ({ ...row.definition, id: row.id, builtIn: false })),
          ];
        },
      }),
      save: endpoint({
        operation: { action: 'better-files:templates:manage', target: 'tenant', mutates: true },
        input: v.object({ templateId: v.optional(v.id()), definition: templateSchema }),
        async handler(context, input) {
          const definition = input.definition as unknown as RoomTemplateDefinition;
          if (input.templateId) {
            const existing = await context.db.findOne<StoredTemplate>('roomTemplates', {
              id: input.templateId,
              tenantId: context.tenantId,
            });
            if (!existing) throw notFound('Template');
            await context.db.update(
              'roomTemplates',
              { id: existing.id, tenantId: context.tenantId },
              { definition, updatedAt: context.now },
            );
            return { ...definition, id: existing.id, builtIn: false };
          }
          const row: StoredTemplate = {
            id: prefixedId('tpl', context.now),
            tenantId: context.tenantId,
            definition,
            createdBy: context.principal.id,
            updatedAt: context.now,
            createdAt: context.now,
          };
          await context.db.insert('roomTemplates', row);
          return { ...definition, id: row.id, builtIn: false };
        },
      }),
      delete: endpoint({
        operation: { action: 'better-files:templates:manage', target: 'tenant', mutates: true },
        input: v.object({ templateId: v.id() }),
        async handler(context, input) {
          if (builtInTemplates.some((template) => template.id === input.templateId))
            throw new BetterFilesError('CONFLICT', 'Built-in templates cannot be deleted');
          const removed = await context.db.delete('roomTemplates', {
            id: input.templateId,
            tenantId: context.tenantId,
          });
          if (!removed) throw notFound('Template');
          return { deleted: true as const };
        },
      }),
      /** Applies a template to an existing room (idempotent: existing folders and groups are kept). */
      apply: endpoint({
        operation: { action: 'better-files:admin', target: 'room', mutates: true },
        transaction: 'manual',
        input: v.object({ roomId: v.id(), templateId: v.string({ min: 1, max: 128 }) }),
        target: (input) => ({ roomId: input.roomId }),
        async handler(context, input) {
          const template = await findTemplate(context, input.templateId);
          const created = await apply(context, input.roomId, template);
          await context.activity({
            roomId: input.roomId,
            action: 'template.applied',
            metadata: { templateId: template.id, ...created },
          });
          return created;
        },
      }),
      /** Creates a room and applies a template to it in one step. */
      createRoom: endpoint({
        operation: { action: 'better-files:rooms:create', target: 'tenant', mutates: true },
        transaction: 'manual',
        input: v.object({
          templateId: v.string({ min: 1, max: 128 }),
          name: v.string({ min: 1, max: 200, trim: true }),
          description: v.optional(v.string({ max: 2000 })),
        }),
        async handler(context, input) {
          const template = await findTemplate(context, input.templateId);
          const room = await context.call<{ id: string; name: string; rootNodeId: string }>(
            'rooms.create',
            {
              name: input.name,
              ...(input.description ? { description: input.description } : {}),
            },
          );
          const created = await apply(context, room.id, template);
          return { room, ...created };
        },
      }),
      /** A template from an existing room; `save` stores it for the tenant. */
      capture: endpoint({
        operation: { action: 'better-files:templates:manage', target: 'tenant', mutates: true },
        input: v.object({
          roomId: v.id(),
          name: v.optional(v.string({ min: 1, max: 120 })),
          save: v.optional(v.boolean()),
        }),
        async handler(context, input) {
          const definition = await capture(context, input.roomId, input.name);
          if (!input.save) return { ...definition, id: null, builtIn: false };
          const row: StoredTemplate = {
            id: prefixedId('tpl', context.now),
            tenantId: context.tenantId,
            definition,
            createdBy: context.principal.id,
            updatedAt: context.now,
            createdAt: context.now,
          };
          await context.db.insert('roomTemplates', row);
          return { ...definition, id: row.id, builtIn: false };
        },
      }),
      /** A new room with another room's structure: folders, groups, folder access, settings, checklists. */
      duplicateRoom: endpoint({
        operation: { action: 'better-files:rooms:create', target: 'tenant', mutates: true },
        transaction: 'manual',
        input: v.object({
          roomId: v.id(),
          name: v.string({ min: 1, max: 200, trim: true }),
          description: v.optional(v.string({ max: 2000 })),
        }),
        async handler(context, input) {
          const template = await capture(context, input.roomId, input.name);
          const room = await context.call<{ id: string; name: string; rootNodeId: string }>(
            'rooms.create',
            {
              name: input.name,
              ...(input.description ? { description: input.description } : {}),
            },
          );
          const created = await apply(context, room.id, template);
          return { room, ...created };
        },
      }),
    },
  });
}
