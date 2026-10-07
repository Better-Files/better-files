import {
  BetterFilesError,
  defineTable,
  definePlugin,
  endpoint,
  field,
  forbidden,
  notFound,
  prefixedId,
  v,
  type PluginContext,
} from '@better-files/core';

export interface Task {
  id: string;
  tenantId: string;
  roomId: string;
  /** The checklist the task belongs to (`Closing`, `Due diligence`); tasks without one are loose. */
  checklist?: string;
  title: string;
  description?: string;
  assigneeId?: string;
  dueAt?: number;
  status: 'open' | 'done';
  /** Documents that satisfy or support the task. */
  nodeIds: string[];
  position: number;
  completedAt?: number;
  completedBy?: string;
  overdueNotifiedAt?: number;
  createdBy: string;
  updatedAt: number;
  createdAt: number;
}

const MANAGE = 'better-files:tasks:manage';
const READ = 'better-files:tasks:read';

async function loadTask(context: PluginContext, taskId: string): Promise<Task> {
  const task = await context.db.findOne<Task>('tasks', {
    id: taskId,
    tenantId: context.tenantId,
    roomId: context.room!.id,
  });
  if (!task) throw notFound('Task');
  return task;
}

const taskTarget = async (
  input: { taskId: string },
  lookup: { db: PluginContext['db']; tenantId: string },
) => {
  const task = await lookup.db.findOne<Task>('tasks', {
    id: input.taskId,
    tenantId: lookup.tenantId,
  });
  if (!task) throw notFound('Task');
  return { roomId: task.roomId };
};

/**
 * Checklists and tasks for a room (closing checklists, diligence request lists, real-estate transaction steps):
 * assignees, due dates, linked documents, completion, and `task.overdue` events from `dr.maintain()`.
 */
export function tasksPlugin() {
  return definePlugin({
    id: 'tasks',
    actions: [READ, MANAGE],
    accessModel: [
      { relations: ['owner', 'admin', 'publisher', 'editor'], actions: [READ, MANAGE] },
      { relations: ['contributor', 'viewer', 'auditor'], actions: [READ] },
    ],
    schema: {
      tasks: defineTable({
        fields: {
          roomId: field.string(),
          checklist: field.string({ required: false }),
          title: field.string(),
          description: field.string({ required: false }),
          assigneeId: field.string({ required: false }),
          dueAt: field.timestamp({ required: false }),
          status: field.enum(['open', 'done'] as const),
          nodeIds: field.json<string[]>(),
          position: field.number(),
          completedAt: field.timestamp({ required: false }),
          completedBy: field.string({ required: false }),
          overdueNotifiedAt: field.timestamp({ required: false }),
          createdBy: field.string(),
          updatedAt: field.timestamp(),
        },
        indexes: [{ fields: ['tenantId', 'roomId', 'status'] }],
      }),
    },
    async maintain(context) {
      const overdue = await context.db.findMany<Task>('tasks', {
        where: { status: 'open', dueAt: { lt: context.now }, overdueNotifiedAt: { isNull: true } },
        limit: 500,
      });
      for (const task of overdue) {
        await context.db.transaction((tx) =>
          tx.update(
            'tasks',
            { id: task.id, tenantId: task.tenantId },
            { overdueNotifiedAt: context.now },
          ),
        );
        await context.emit({
          type: 'task.overdue',
          tenantId: task.tenantId,
          roomId: task.roomId,
          data: {
            taskId: task.id,
            title: task.title,
            assigneeId: task.assigneeId ?? null,
            dueAt: task.dueAt ?? null,
          },
        });
      }
    },
    endpoints: {
      create: endpoint({
        operation: { action: MANAGE, target: 'room', mutates: true },
        input: v.object({
          roomId: v.id(),
          title: v.string({ min: 1, max: 300, trim: true }),
          description: v.optional(v.string({ max: 5000 })),
          checklist: v.optional(v.string({ min: 1, max: 120 })),
          assigneeId: v.optional(v.id()),
          dueAt: v.optional(v.number({ int: true, min: 0 })),
          nodeIds: v.optional(v.array(v.id(), { max: 50 })),
        }),
        target: (input) => ({ roomId: input.roomId }),
        async handler(context, input) {
          const room = context.room!;
          const last = await context.db.findMany<Task>('tasks', {
            where: { tenantId: context.tenantId, roomId: room.id },
            orderBy: [{ field: 'position', direction: 'desc' }],
            limit: 1,
          });
          const task: Task = {
            id: prefixedId('task', context.now),
            tenantId: context.tenantId,
            roomId: room.id,
            ...(input.checklist ? { checklist: input.checklist } : {}),
            title: input.title,
            ...(input.description ? { description: input.description } : {}),
            ...(input.assigneeId ? { assigneeId: input.assigneeId } : {}),
            ...(input.dueAt ? { dueAt: input.dueAt } : {}),
            status: 'open',
            nodeIds: input.nodeIds ?? [],
            position: (last[0]?.position ?? 0) + 1,
            createdBy: context.principal.id,
            updatedAt: context.now,
            createdAt: context.now,
          };
          await context.db.insert('tasks', task);
          await context.activity({
            roomId: room.id,
            action: 'task.created',
            metadata: { taskId: task.id, title: task.title },
          });
          context.emit('task.created', {
            taskId: task.id,
            title: task.title,
            assigneeId: task.assigneeId ?? null,
          });
          return task;
        },
      }),
      list: endpoint({
        operation: { action: READ, target: 'room', mutates: false, allowClosed: true },
        input: v.object({
          roomId: v.id(),
          checklist: v.optional(v.string({ max: 120 })),
          mine: v.optional(v.boolean()),
        }),
        target: (input) => ({ roomId: input.roomId }),
        async handler(context, input) {
          const tasks = await context.db.findMany<Task>('tasks', {
            where: {
              tenantId: context.tenantId,
              roomId: context.room!.id,
              ...(input.checklist ? { checklist: input.checklist } : {}),
              ...(input.mine ? { assigneeId: context.principal.id } : {}),
            },
            orderBy: [{ field: 'position' }],
          });
          const checklists = new Map<string, { total: number; done: number }>();
          for (const task of tasks) {
            const key = task.checklist ?? '';
            const entry = checklists.get(key) ?? { total: 0, done: 0 };
            entry.total++;
            if (task.status === 'done') entry.done++;
            checklists.set(key, entry);
          }
          return {
            tasks,
            progress: [...checklists].map(([checklist, counts]) => ({
              checklist: checklist || null,
              ...counts,
            })),
          };
        },
      }),
      update: endpoint({
        operation: { action: MANAGE, target: 'room', mutates: true },
        input: v.object({
          taskId: v.id(),
          title: v.optional(v.string({ min: 1, max: 300, trim: true })),
          description: v.optional(v.nullable(v.string({ max: 5000 }))),
          assigneeId: v.optional(v.nullable(v.id())),
          dueAt: v.optional(v.nullable(v.number({ int: true, min: 0 }))),
          nodeIds: v.optional(v.array(v.id(), { max: 50 })),
        }),
        target: taskTarget,
        async handler(context, input) {
          const task = await loadTask(context, input.taskId);
          const { taskId: _id, ...patch } = input;
          const next = {
            ...patch,
            updatedAt: context.now,
            ...(input.dueAt !== undefined ? { overdueNotifiedAt: null } : {}),
          };
          await context.db.update('tasks', { id: task.id, tenantId: context.tenantId }, next);
          const updated = { ...task, ...next } as Record<string, unknown>;
          for (const key of Object.keys(updated)) if (updated[key] === null) delete updated[key];
          context.emit('task.updated', { taskId: task.id });
          return updated as unknown as Task;
        },
      }),
      /** Marks a task done (or open again). Assignees may complete their own tasks; managers any. */
      complete: endpoint({
        operation: { action: READ, target: 'room', mutates: true },
        input: v.object({ taskId: v.id(), done: v.optional(v.boolean()) }),
        target: taskTarget,
        async handler(context, input) {
          const task = await loadTask(context, input.taskId);
          if (task.assigneeId !== context.principal.id && !(await context.authorize(MANAGE)))
            throw forbidden('Only the assignee or a task manager can complete this task');
          const done = input.done ?? true;
          if ((task.status === 'done') === done)
            throw new BetterFilesError('CONFLICT', `The task is already ${task.status}`);
          const patch = done
            ? {
                status: 'done' as const,
                completedAt: context.now,
                completedBy: context.principal.id,
                updatedAt: context.now,
              }
            : {
                status: 'open' as const,
                completedAt: null,
                completedBy: null,
                updatedAt: context.now,
              };
          await context.db.update('tasks', { id: task.id, tenantId: context.tenantId }, patch);
          await context.activity({
            roomId: task.roomId,
            action: done ? 'task.completed' : 'task.reopened',
            metadata: { taskId: task.id, title: task.title },
          });
          context.emit(done ? 'task.completed' : 'task.reopened', {
            taskId: task.id,
            title: task.title,
          });
          return { ...task, status: patch.status };
        },
      }),
      delete: endpoint({
        operation: { action: MANAGE, target: 'room', mutates: true },
        input: v.object({ taskId: v.id() }),
        target: taskTarget,
        async handler(context, input) {
          const task = await loadTask(context, input.taskId);
          await context.db.delete('tasks', { id: task.id, tenantId: context.tenantId });
          return { deleted: true as const };
        },
      }),
    },
  });
}
