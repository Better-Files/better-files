import {
  Capability,
  BetterFilesError,
  defineTable,
  definePlugin,
  endpoint,
  field,
  forbidden,
  notFound,
  prefixedId,
  v,
  type DataRoomNode,
  type PermissionGroup,
  type PluginContext,
} from '@better-files/core';

export const questionStatuses = ['open', 'assigned', 'answered', 'published', 'closed'] as const;
export type QuestionStatus = (typeof questionStatuses)[number];

export interface Question {
  id: string;
  tenantId: string;
  roomId: string;
  subject: string;
  text: string;
  category?: string;
  priority: 'low' | 'normal' | 'high';
  /** The document the question is about, if any. */
  nodeId?: string;
  askedBy: string;
  askerName?: string;
  /** The asker's permission groups (by id) when asking: their team sees the question and its answer. */
  groupIds: string[];
  status: QuestionStatus;
  assignedTo?: string;
  dueAt?: number;
  answer?: string;
  answeredBy?: string;
  approvedBy?: string;
  /** Who sees the published answer: the asking team only, or everyone in the room (anonymized). */
  visibility: 'group' | 'room';
  publishedAt?: number;
  closedAt?: number;
  updatedAt: number;
  createdAt: number;
}

export interface QaOptions {
  /** Open questions one team may have at once. Default unlimited. */
  maxOpenPerGroup?: number;
  categories?: readonly string[];
}

const MANAGE = 'better-files:qa:manage';
const ANSWER = 'better-files:qa:answer';

type Role = 'manager' | 'expert' | 'participant';

/** Managers run the Q&A; experts answer what they are assigned; participants see their team's questions. */
async function roleOf(context: PluginContext): Promise<Role> {
  if (await context.authorize(MANAGE)) return 'manager';
  if (await context.authorize(ANSWER)) return 'expert';
  return 'participant';
}

async function teamOf(context: PluginContext, roomId: string): Promise<string[]> {
  const groups = await context.db.findMany<PermissionGroup>('permissionGroups', {
    where: {
      tenantId: context.tenantId,
      roomId,
      iamGroupId: { in: [...context.principal.groups] },
    },
  });
  return groups.map((group) => group.id);
}

function visibleTo(
  question: Question,
  role: Role,
  principalId: string,
  team: readonly string[],
): boolean {
  if (role === 'manager') return true;
  if (role === 'expert' && question.assignedTo === principalId) return true;
  if (question.askedBy === principalId) return true;
  if (question.groupIds.some((id) => team.includes(id))) return true;
  return question.status === 'published' && question.visibility === 'room';
}

/** Participants see answers only once published, and room-wide questions without who asked them. */
function viewFor(question: Question, role: Role, principalId: string, team: readonly string[]) {
  const own = question.askedBy === principalId || question.groupIds.some((id) => team.includes(id));
  if (role === 'manager' || (role === 'expert' && question.assignedTo === principalId))
    return question;
  const {
    answer,
    answeredBy: _by,
    approvedBy: _approved,
    assignedTo: _assignee,
    ...rest
  } = question;
  const shown = question.status === 'published' ? { ...rest, answer } : rest;
  if (!own) {
    const { askedBy: _asker, askerName: _name, groupIds: _groups, ...anonymous } = shown;
    return anonymous;
  }
  return shown;
}

const roomTarget = (input: { roomId: string }) => ({ roomId: input.roomId });
const questionTarget = async (
  input: { questionId: string },
  lookup: { db: PluginContext['db']; tenantId: string },
) => {
  const question = await lookup.db.findOne<Question>('questions', {
    id: input.questionId,
    tenantId: lookup.tenantId,
  });
  if (!question) throw notFound('Question');
  return { roomId: question.roomId };
};

async function load(context: PluginContext, questionId: string): Promise<Question> {
  const question = await context.db.findOne<Question>('questions', {
    id: questionId,
    tenantId: context.tenantId,
    roomId: context.room!.id,
  });
  if (!question) throw notFound('Question');
  return question;
}

/**
 * Due-diligence Q&A: participants ask questions (optionally about a document), managers assign them to experts,
 * experts draft answers, managers approve and publish them to the asking team or the whole room, then close them.
 * Teams (permission groups) see their own questions; other teams never learn who asked what.
 */
export function qaPlugin(options: QaOptions = {}) {
  return definePlugin({
    id: 'qa',
    actions: ['better-files:qa:ask', ANSWER, MANAGE],
    accessModel: [
      {
        relations: ['owner', 'admin', 'publisher'],
        actions: ['better-files:qa:ask', ANSWER, MANAGE],
      },
      { relations: ['editor'], actions: ['better-files:qa:ask', ANSWER] },
      { relations: ['contributor', 'viewer'], actions: ['better-files:qa:ask'] },
    ],
    schema: {
      questions: defineTable({
        fields: {
          roomId: field.string(),
          subject: field.string(),
          text: field.string(),
          category: field.string({ required: false }),
          priority: field.enum(['low', 'normal', 'high'] as const),
          nodeId: field.string({ required: false }),
          askedBy: field.string(),
          askerName: field.string({ required: false }),
          groupIds: field.json<string[]>(),
          status: field.enum(questionStatuses),
          assignedTo: field.string({ required: false }),
          dueAt: field.timestamp({ required: false }),
          answer: field.string({ required: false }),
          answeredBy: field.string({ required: false }),
          approvedBy: field.string({ required: false }),
          visibility: field.enum(['group', 'room'] as const),
          publishedAt: field.timestamp({ required: false }),
          closedAt: field.timestamp({ required: false }),
          updatedAt: field.timestamp(),
        },
        indexes: [{ fields: ['tenantId', 'roomId', 'status'] }],
      }),
    },
    endpoints: {
      ask: endpoint({
        operation: { action: 'better-files:qa:ask', target: 'room', mutates: true },
        input: v.object({
          roomId: v.id(),
          subject: v.string({ min: 1, max: 200, trim: true }),
          text: v.string({ min: 1, max: 10_000 }),
          nodeId: v.optional(v.id()),
          category: v.optional(v.string({ max: 64 })),
          priority: v.optional(v.enum(['low', 'normal', 'high'] as const)),
        }),
        target: roomTarget,
        async handler(context, input) {
          const room = context.room!;
          if (options.categories && input.category && !options.categories.includes(input.category))
            throw new BetterFilesError(
              'INVALID_INPUT',
              `Category must be one of ${options.categories.join(', ')}`,
            );
          if (input.nodeId) {
            // A question can only point at something the asker can see.
            const node = await context.db.findOne<DataRoomNode>('nodes', {
              id: input.nodeId,
              tenantId: context.tenantId,
              roomId: room.id,
            });
            const mask =
              node && node.deletedAt === undefined
                ? ((await context.capabilitiesOf([node])).get(node.id) ?? 0)
                : 0;
            if ((mask & Capability.LIST) === 0) throw notFound('Document');
          }
          const team = await teamOf(context, room.id);
          if (options.maxOpenPerGroup && team.length) {
            const open = await context.db.findMany<Question>('questions', {
              where: {
                tenantId: context.tenantId,
                roomId: room.id,
                status: { in: ['open', 'assigned', 'answered'] },
              },
            });
            const mine = open.filter((q) => q.groupIds.some((id) => team.includes(id))).length;
            if (mine >= options.maxOpenPerGroup)
              throw new BetterFilesError(
                'QUOTA_EXCEEDED',
                `Your team may have ${options.maxOpenPerGroup} open questions at a time`,
              );
          }
          const question: Question = {
            id: prefixedId('qst', context.now),
            tenantId: context.tenantId,
            roomId: room.id,
            subject: input.subject,
            text: input.text,
            ...(input.category ? { category: input.category } : {}),
            priority: input.priority ?? 'normal',
            ...(input.nodeId ? { nodeId: input.nodeId } : {}),
            askedBy: context.principal.id,
            ...(context.principal.name ? { askerName: context.principal.name } : {}),
            groupIds: team,
            status: 'open',
            visibility: 'group',
            updatedAt: context.now,
            createdAt: context.now,
          };
          await context.db.insert('questions', question);
          await context.activity({
            roomId: room.id,
            action: 'qa.asked',
            ...(input.nodeId ? { nodeId: input.nodeId } : {}),
            metadata: { questionId: question.id, subject: question.subject },
          });
          context.emit('qa.asked', {
            questionId: question.id,
            subject: question.subject,
            priority: question.priority,
          });
          return question;
        },
      }),
      list: endpoint({
        operation: {
          action: 'better-files:qa:ask',
          target: 'room',
          mutates: false,
          allowClosed: true,
        },
        input: v.object({
          roomId: v.id(),
          status: v.optional(v.enum(questionStatuses)),
          assignedToMe: v.optional(v.boolean()),
        }),
        target: roomTarget,
        async handler(context, input) {
          const room = context.room!;
          const [role, team] = await Promise.all([roleOf(context), teamOf(context, room.id)]);
          const questions = await context.db.findMany<Question>('questions', {
            where: {
              tenantId: context.tenantId,
              roomId: room.id,
              ...(input.status ? { status: input.status } : {}),
              ...(input.assignedToMe ? { assignedTo: context.principal.id } : {}),
            },
            orderBy: [{ field: 'createdAt', direction: 'desc' }],
            limit: 1000,
          });
          return questions
            .filter((q) => visibleTo(q, role, context.principal.id, team))
            .map((q) => viewFor(q, role, context.principal.id, team));
        },
      }),
      assign: endpoint({
        operation: { action: MANAGE, target: 'room', mutates: true },
        input: v.object({
          questionId: v.id(),
          assigneeId: v.id(),
          dueAt: v.optional(v.number({ int: true, min: 0 })),
        }),
        target: questionTarget,
        async handler(context, input) {
          const question = await load(context, input.questionId);
          if (question.status === 'closed' || question.status === 'published')
            throw new BetterFilesError('CONFLICT', `The question is ${question.status}`);
          const patch = {
            status: 'assigned' as const,
            assignedTo: input.assigneeId,
            ...(input.dueAt ? { dueAt: input.dueAt } : {}),
            updatedAt: context.now,
          };
          await context.db.update(
            'questions',
            { id: question.id, tenantId: context.tenantId },
            patch,
          );
          await context.activity({
            roomId: question.roomId,
            action: 'qa.assigned',
            metadata: { questionId: question.id, assigneeId: input.assigneeId },
          });
          context.emit('qa.assigned', {
            questionId: question.id,
            assigneeId: input.assigneeId,
            dueAt: input.dueAt ?? null,
          });
          return { ...question, ...patch };
        },
      }),
      /** Drafts or revises the answer; experts may answer only what they are assigned. */
      answer: endpoint({
        operation: { action: ANSWER, target: 'room', mutates: true },
        input: v.object({ questionId: v.id(), answer: v.string({ min: 1, max: 20_000 }) }),
        target: questionTarget,
        async handler(context, input) {
          const question = await load(context, input.questionId);
          const manager = await context.authorize(MANAGE);
          if (!manager && question.assignedTo !== context.principal.id)
            throw forbidden('This question is assigned to someone else');
          if (question.status === 'closed' || question.status === 'published')
            throw new BetterFilesError('CONFLICT', `The question is ${question.status}`);
          const patch = {
            answer: input.answer,
            answeredBy: context.principal.id,
            status: 'answered' as const,
            updatedAt: context.now,
          };
          await context.db.update(
            'questions',
            { id: question.id, tenantId: context.tenantId },
            { ...patch, approvedBy: null },
          );
          await context.activity({
            roomId: question.roomId,
            action: 'qa.answered',
            metadata: { questionId: question.id },
          });
          context.emit('qa.answered', { questionId: question.id });
          const { approvedBy: _approved, ...rest } = question;
          return { ...rest, ...patch };
        },
      }),
      /** Approves the answer and publishes it to the asking team, or to the whole room without the asker's identity. */
      publish: endpoint({
        operation: { action: MANAGE, target: 'room', mutates: true },
        input: v.object({
          questionId: v.id(),
          visibility: v.optional(v.enum(['group', 'room'] as const)),
        }),
        target: questionTarget,
        async handler(context, input) {
          const question = await load(context, input.questionId);
          if (question.status !== 'answered')
            throw new BetterFilesError('CONFLICT', 'Only answered questions can be published');
          const patch = {
            status: 'published' as const,
            visibility: input.visibility ?? question.visibility,
            approvedBy: context.principal.id,
            publishedAt: context.now,
            updatedAt: context.now,
          };
          await context.db.update(
            'questions',
            { id: question.id, tenantId: context.tenantId },
            patch,
          );
          await context.activity({
            roomId: question.roomId,
            action: 'qa.published',
            metadata: { questionId: question.id, visibility: patch.visibility },
          });
          context.emit('qa.published', {
            questionId: question.id,
            visibility: patch.visibility,
            groupIds: question.groupIds,
          });
          return { ...question, ...patch };
        },
      }),
      close: endpoint({
        operation: { action: MANAGE, target: 'room', mutates: true, allowClosed: true },
        input: v.object({ questionId: v.id(), reason: v.optional(v.string({ max: 500 })) }),
        target: questionTarget,
        async handler(context, input) {
          const question = await load(context, input.questionId);
          await context.db.update(
            'questions',
            { id: question.id, tenantId: context.tenantId },
            { status: 'closed', closedAt: context.now, updatedAt: context.now },
          );
          await context.activity({
            roomId: question.roomId,
            action: 'qa.closed',
            metadata: { questionId: question.id, reason: input.reason ?? null },
          });
          context.emit('qa.closed', { questionId: question.id });
          return { closed: true as const };
        },
      }),
    },
  });
}
