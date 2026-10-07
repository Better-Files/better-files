import {
  BetterFilesError,
  defineTable,
  definePlugin,
  endpoint,
  field,
  invalidInput,
  notFound,
  prefixedId,
  v,
  type ActivityRecord,
  type DatabaseAdapter,
  type Member,
  type PluginContext,
  type Room,
} from '@better-files/core';

export type ReviewStatus = 'open' | 'completed' | 'cancelled';
export type ReviewDecision = 'pending' | 'keep' | 'revoke';

/** An access review (certification campaign) of one room. */
export interface AccessReview {
  id: string;
  tenantId: string;
  roomId: string;
  name: string;
  status: ReviewStatus;
  /** Who is reviewed: everyone, only people from outside the organization, or only inactive people. */
  scope: 'all' | 'guests' | 'inactive';
  /** People with no activity in this many days are recommended for revocation. */
  inactiveDays: number;
  /** On completion, people nobody decided on lose their access too. */
  revokeUndecided: boolean;
  dueAt?: number;
  /** `manual` (started by a person) or `schedule` (started by `dr.maintain()`). */
  origin: 'manual' | 'schedule';
  startedBy: string;
  completedAt?: number;
  completedBy?: string;
  overdueNotifiedAt?: number;
  /** Outcome counts, set on completion. */
  summary?: { kept: number; revoked: number; gone: number; failed: number; flagged: number };
  updatedAt: number;
  createdAt: number;
}

/** One person under review: a snapshot of their access when the review started, and the decision. */
export interface AccessReviewItem {
  id: string;
  tenantId: string;
  reviewId: string;
  roomId: string;
  /** `roster`: a participant of the room. `iam`: someone Better IAM lets into the room who is not on its roster. */
  source: 'roster' | 'iam';
  /** The roster entry; absent for `iam` entries. */
  memberId?: string;
  identityId?: string;
  name?: string;
  email?: string;
  memberStatus: string;
  relation?: string;
  groupIds: string[];
  guest: boolean;
  expiresAt?: number;
  lastActivityAt?: number;
  /** Activity records by this person within the review's inactivity window. */
  recentActivity: number;
  recommendation: 'keep' | 'revoke';
  /** Why: `owner`, `active`, `inactive`, `invitation-pending`, `expired`, or `outside-roster` (with `access`). */
  reason: string;
  decision: ReviewDecision;
  note?: string;
  decidedBy?: string;
  decidedAt?: number;
  /** For `iam` entries: why Better IAM grants access (the policy decision's reason). */
  access?: string;
  /**
   * What completion did: `kept`, `revoked`, `gone` (already removed), `failed` (with `error`), or `flagged`: an
   * `iam` entry marked revoke, which only a change in Better IAM can remove (reported in `review.iam-access-flagged`).
   */
  outcome?: 'kept' | 'revoked' | 'gone' | 'failed' | 'flagged';
  error?: string;
  updatedAt: number;
  createdAt: number;
}

export interface ReviewProgress {
  total: number;
  pending: number;
  keep: number;
  revoke: number;
}

export interface ReviewsPluginOptions {
  /**
   * Start a review of every live room automatically when its last review is this many days old (or the room has
   * none), from `dr.maintain()`. Off by default.
   */
  schedule?: { everyDays: number; dueInDays?: number; scope?: AccessReview['scope'] };
  /** Default inactivity window for recommendations, in days. Default 90. */
  inactiveDays?: number;
  /**
   * Who the identity system lets into a room, so reviews also list access that does not come from the roster (tenant
   * administrators, broad policies, groups bound outside Better Files). `betterIamAccess(iam, …)` builds one.
   */
  iamAccess?: IamAccessLookup;
}

/** People the identity system lets into a room, with the reason for each. */
export type IamAccessLookup = (query: {
  tenantId: string;
  roomId: string;
}) => Promise<{ identityId: string; name?: string; email?: string; reason: string }[]>;

/** The part of a Better IAM instance `betterIamAccess` uses (`policies.whoCan`, in every 0.2.x release). */
export interface WhoCanApi {
  api: {
    policies: {
      whoCan(
        credential: { headers?: HeadersInit; token?: string },
        input: {
          tenantId: string;
          action: string;
          resource: { type: string; id: string };
          limit?: number;
        },
      ): Promise<{
        identities: { identityId: string; name: string; email?: string; reason: string }[];
        total: number;
      }>;
    };
  };
}

/**
 * Asks Better IAM's access review API (`policies.whoCan`) who may perform `actions` (default: open the room) on each
 * room. The credential needs `iam:policies:simulate` in the tenant: typically the Better Files service account.
 */
export function betterIamAccess(
  iam: WhoCanApi,
  options: {
    credential: (
      tenantId: string,
    ) =>
      | { headers?: HeadersInit; token?: string }
      | Promise<{ headers?: HeadersInit; token?: string }>;
    actions?: readonly string[];
  },
): IamAccessLookup {
  const actions = options.actions ?? ['better-files:rooms:read'];
  return async ({ tenantId, roomId }) => {
    const credential = await options.credential(tenantId);
    const found = new Map<
      string,
      { identityId: string; name?: string; email?: string; reason: string }
    >();
    for (const action of actions) {
      const { identities } = await iam.api.policies.whoCan(credential, {
        tenantId,
        action,
        resource: { type: 'better-files-room', id: roomId },
        limit: 1000,
      });
      for (const identity of identities) {
        const seen = found.get(identity.identityId);
        found.set(identity.identityId, {
          identityId: identity.identityId,
          name: identity.name,
          ...(identity.email ? { email: identity.email } : {}),
          reason: seen
            ? `${seen.reason}; ${action}: ${identity.reason}`
            : `${action}: ${identity.reason}`,
        });
      }
    }
    return [...found.values()];
  };
}

const READ = 'better-files:reviews:read';
const MANAGE = 'better-files:reviews:manage';
const DAY = 86_400_000;

async function loadReview(context: PluginContext, reviewId: string): Promise<AccessReview> {
  const review = await context.db.findOne<AccessReview>('accessReviews', {
    id: reviewId,
    tenantId: context.tenantId,
    roomId: context.room!.id,
  });
  if (!review) throw notFound('Review');
  return review;
}

const reviewTarget = async (
  input: { reviewId: string },
  lookup: { db: DatabaseAdapter; tenantId: string },
) => {
  const review = await lookup.db.findOne<AccessReview>('accessReviews', {
    id: input.reviewId,
    tenantId: lookup.tenantId,
  });
  if (!review) throw notFound('Review');
  return { roomId: review.roomId };
};

const requireOpen = (review: AccessReview) => {
  if (review.status !== 'open')
    throw new BetterFilesError('CONFLICT', `The review is ${review.status}`);
};

const progressOf = (items: readonly AccessReviewItem[]): ReviewProgress => ({
  total: items.length,
  pending: items.filter((item) => item.decision === 'pending').length,
  keep: items.filter((item) => item.decision === 'keep').length,
  revoke: items.filter((item) => item.decision === 'revoke').length,
});

/** The last activity time and the number of records per actor since `since`, newest records first. */
async function recentActivity(
  db: DatabaseAdapter,
  tenantId: string,
  roomId: string,
  since: number,
): Promise<Map<string, { count: number; last: number }>> {
  const byActor = new Map<string, { count: number; last: number }>();
  for (let before = Number.MAX_SAFE_INTEGER; ; ) {
    const page = await db.findMany<ActivityRecord>('activity', {
      where: { tenantId, roomId, sequence: { lt: before } },
      orderBy: [{ field: 'sequence', direction: 'desc' }],
      limit: 1000,
    });
    for (const record of page) {
      if (record.createdAt < since) return byActor;
      const entry = byActor.get(record.actorId) ?? { count: 0, last: record.createdAt };
      entry.count++;
      byActor.set(record.actorId, entry);
    }
    if (page.length < 1000) return byActor;
    before = page.at(-1)!.sequence;
  }
}

/** Snapshots the room's roster into a new open review. Shared by `start` and the schedule. */
async function snapshot(
  db: DatabaseAdapter,
  input: {
    tenantId: string;
    room: Room;
    now: number;
    name: string;
    scope: AccessReview['scope'];
    inactiveDays: number;
    revokeUndecided: boolean;
    dueAt?: number;
    origin: AccessReview['origin'];
    startedBy: string;
    iamAccess?: IamAccessLookup;
  },
): Promise<{ review: AccessReview; items: AccessReviewItem[] }> {
  const { tenantId, room, now } = input;
  const open = await db.findOne<AccessReview>('accessReviews', {
    tenantId,
    roomId: room.id,
    status: 'open',
  });
  if (open) throw new BetterFilesError('CONFLICT', 'This room already has an open review');
  const since = now - input.inactiveDays * DAY;
  const [members, activity] = await Promise.all([
    db.findMany<Member>('members', {
      where: { tenantId, roomId: room.id, status: { in: ['active', 'invited', 'suspended'] } },
      orderBy: [{ field: 'createdAt' }],
    }),
    recentActivity(db, tenantId, room.id, since),
  ]);
  const review: AccessReview = {
    id: prefixedId('review', now),
    tenantId,
    roomId: room.id,
    name: input.name,
    status: 'open',
    scope: input.scope,
    inactiveDays: input.inactiveDays,
    revokeUndecided: input.revokeUndecided,
    ...(input.dueAt ? { dueAt: input.dueAt } : {}),
    origin: input.origin,
    startedBy: input.startedBy,
    updatedAt: now,
    createdAt: now,
  };
  const items: AccessReviewItem[] = [];
  for (const member of members) {
    const seen = member.identityId ? activity.get(member.identityId) : undefined;
    const lastActivityAt = Math.max(seen?.last ?? 0, member.lastSeenAt ?? 0) || undefined;
    const inactive = (lastActivityAt ?? member.createdAt) < since;
    // The recommendation never suggests removing an owner: a room keeps at least one, and owners answer for it.
    const [recommendation, reason]: [AccessReviewItem['recommendation'], string] =
      member.relation === 'owner'
        ? ['keep', 'owner']
        : member.status === 'invited' && member.createdAt < since
          ? ['revoke', 'invitation-pending']
          : member.expiresAt !== undefined && member.expiresAt <= now
            ? ['revoke', 'expired']
            : member.status !== 'invited' && inactive
              ? ['revoke', 'inactive']
              : ['keep', 'active'];
    if (input.scope === 'guests' && !member.guest) continue;
    if (input.scope === 'inactive' && recommendation === 'keep') continue;
    items.push({
      id: prefixedId('rvitem', now),
      tenantId,
      reviewId: review.id,
      roomId: room.id,
      source: 'roster',
      memberId: member.id,
      ...(member.identityId ? { identityId: member.identityId } : {}),
      ...(member.email ? { email: member.email } : {}),
      memberStatus: member.status,
      ...(member.relation ? { relation: member.relation } : {}),
      groupIds: member.groupIds,
      guest: member.guest,
      ...(member.expiresAt === undefined ? {} : { expiresAt: member.expiresAt }),
      ...(lastActivityAt ? { lastActivityAt } : {}),
      recentActivity: seen?.count ?? 0,
      recommendation,
      reason,
      decision: 'pending',
      updatedAt: now,
      createdAt: now,
    });
  }
  // Access the identity system grants to people who are not on the roster: they cannot be removed from the room
  // here, so a revoke decision is reported for a change in the identity system.
  if (input.iamAccess && input.scope !== 'guests') {
    const rostered = new Set(
      members.flatMap((member) => (member.identityId ? [member.identityId] : [])),
    );
    for (const person of await input.iamAccess({ tenantId, roomId: room.id })) {
      if (rostered.has(person.identityId)) continue;
      const seen = activity.get(person.identityId);
      const recommendation = seen ? 'keep' : 'revoke';
      if (input.scope === 'inactive' && recommendation === 'keep') continue;
      items.push({
        id: prefixedId('rvitem', now),
        tenantId,
        reviewId: review.id,
        roomId: room.id,
        source: 'iam',
        identityId: person.identityId,
        ...(person.name ? { name: person.name } : {}),
        ...(person.email ? { email: person.email } : {}),
        memberStatus: 'not-a-member',
        groupIds: [],
        guest: false,
        ...(seen ? { lastActivityAt: seen.last } : {}),
        recentActivity: seen?.count ?? 0,
        recommendation,
        reason: 'outside-roster',
        access: person.reason.slice(0, 1000),
        decision: 'pending',
        updatedAt: now,
        createdAt: now,
      });
    }
  }
  await db.transaction(async (tx) => {
    await tx.insert('accessReviews', review);
    for (const item of items) await tx.insert('accessReviewItems', item);
  });
  return { review, items };
}

/**
 * Access reviews: periodic "who should still be in this room" certifications. A review snapshots the room's
 * participants with their groups, room role, last activity and a recommendation; reviewers keep or revoke each person
 * (never themselves), and completing the review removes the revoked people from the room and from Better IAM's
 * groups and relationships, recording everything in the room's activity log. With `schedule`, `dr.maintain()` starts
 * reviews for live rooms on a cadence and reports overdue ones as `review.overdue` events.
 */
export function reviewsPlugin(options: ReviewsPluginOptions = {}) {
  const defaultInactiveDays = options.inactiveDays ?? 90;
  if (options.schedule && !(options.schedule.everyDays >= 1))
    throw new BetterFilesError('INVALID_CONFIG', 'schedule.everyDays must be at least 1');
  return definePlugin({
    id: 'reviews',
    actions: [READ, MANAGE],
    accessModel: [
      { relations: ['owner', 'admin'], actions: [READ, MANAGE] },
      { relations: ['auditor'], actions: [READ] },
    ],
    schema: {
      accessReviews: defineTable({
        fields: {
          roomId: field.string(),
          name: field.string(),
          status: field.enum(['open', 'completed', 'cancelled'] as const),
          scope: field.enum(['all', 'guests', 'inactive'] as const),
          inactiveDays: field.number(),
          revokeUndecided: field.boolean(),
          dueAt: field.timestamp({ required: false }),
          origin: field.enum(['manual', 'schedule'] as const),
          startedBy: field.string(),
          completedAt: field.timestamp({ required: false }),
          completedBy: field.string({ required: false }),
          overdueNotifiedAt: field.timestamp({ required: false }),
          summary: field.json<AccessReview['summary']>({ required: false }),
          updatedAt: field.timestamp(),
        },
        indexes: [{ fields: ['tenantId', 'roomId', 'status'] }],
      }),
      accessReviewItems: defineTable({
        fields: {
          reviewId: field.string(),
          roomId: field.string(),
          source: field.enum(['roster', 'iam'] as const),
          memberId: field.string({ required: false }),
          identityId: field.string({ required: false }),
          name: field.string({ required: false }),
          email: field.string({ required: false }),
          access: field.string({ required: false }),
          memberStatus: field.string(),
          relation: field.string({ required: false }),
          groupIds: field.json<string[]>(),
          guest: field.boolean(),
          expiresAt: field.timestamp({ required: false }),
          lastActivityAt: field.timestamp({ required: false }),
          recentActivity: field.number(),
          recommendation: field.enum(['keep', 'revoke'] as const),
          reason: field.string(),
          decision: field.enum(['pending', 'keep', 'revoke'] as const),
          note: field.string({ required: false }),
          decidedBy: field.string({ required: false }),
          decidedAt: field.timestamp({ required: false }),
          outcome: field.enum(['kept', 'revoked', 'gone', 'failed', 'flagged'] as const, {
            required: false,
          }),
          error: field.string({ required: false }),
          updatedAt: field.timestamp(),
        },
        indexes: [{ fields: ['tenantId', 'reviewId'] }],
      }),
    },
    async maintain(context) {
      // Overdue reviews: reported once.
      const overdue = await context.db.findMany<AccessReview>('accessReviews', {
        where: { status: 'open', dueAt: { lt: context.now }, overdueNotifiedAt: { isNull: true } },
        limit: 500,
      });
      for (const review of overdue) {
        await context.db.transaction((tx) =>
          tx.update(
            'accessReviews',
            { id: review.id, tenantId: review.tenantId },
            { overdueNotifiedAt: context.now, updatedAt: context.now },
          ),
        );
        const pending = await context.db.count('accessReviewItems', {
          tenantId: review.tenantId,
          reviewId: review.id,
          decision: 'pending',
        });
        await context.emit({
          type: 'review.overdue',
          tenantId: review.tenantId,
          roomId: review.roomId,
          data: { reviewId: review.id, name: review.name, dueAt: review.dueAt ?? null, pending },
        });
      }
      // Scheduled reviews for live rooms whose last review is older than the cadence.
      const schedule = options.schedule;
      if (!schedule) return;
      const rooms = await context.db.findMany<Room>('rooms', {
        where: { status: 'live' },
        limit: 1000,
      });
      for (const room of rooms) {
        const [last] = await context.db.findMany<AccessReview>('accessReviews', {
          where: { tenantId: room.tenantId, roomId: room.id },
          orderBy: [{ field: 'createdAt', direction: 'desc' }],
          limit: 1,
        });
        if (
          last &&
          (last.status === 'open' || last.createdAt > context.now - schedule.everyDays * DAY)
        )
          continue;
        try {
          const { review, items } = await snapshot(context.db, {
            tenantId: room.tenantId,
            room,
            now: context.now,
            name: `Scheduled review ${new Date(context.now).toISOString().slice(0, 10)}`,
            scope: schedule.scope ?? 'all',
            inactiveDays: defaultInactiveDays,
            revokeUndecided: false,
            ...(schedule.dueInDays ? { dueAt: context.now + schedule.dueInDays * DAY } : {}),
            origin: 'schedule',
            startedBy: 'system',
            ...(options.iamAccess ? { iamAccess: options.iamAccess } : {}),
          });
          await context.emit({
            type: 'review.started',
            tenantId: room.tenantId,
            roomId: room.id,
            data: {
              reviewId: review.id,
              name: review.name,
              people: items.length,
              origin: 'schedule',
            },
          });
        } catch (error) {
          context.logger.error('Scheduled access review failed', {
            roomId: room.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },
    endpoints: {
      /** Starts a review of the room: snapshots its participants with recommendations. One open review per room. */
      start: endpoint({
        operation: { action: MANAGE, target: 'room', mutates: true },
        transaction: 'manual',
        input: v.object({
          roomId: v.id(),
          name: v.optional(v.string({ min: 1, max: 200, trim: true })),
          scope: v.optional(v.enum(['all', 'guests', 'inactive'] as const)),
          inactiveDays: v.optional(v.number({ int: true, min: 1, max: 3650 })),
          dueAt: v.optional(v.number({ int: true, min: 0 })),
          revokeUndecided: v.optional(v.boolean()),
        }),
        target: (input) => ({ roomId: input.roomId }),
        async handler(context, input) {
          const room = context.room!;
          if (input.dueAt !== undefined && input.dueAt <= context.now)
            throw invalidInput('dueAt must be in the future');
          const { review, items } = await snapshot(context.db, {
            tenantId: context.tenantId,
            room,
            now: context.now,
            name: input.name ?? `Access review ${new Date(context.now).toISOString().slice(0, 10)}`,
            scope: input.scope ?? 'all',
            inactiveDays: input.inactiveDays ?? defaultInactiveDays,
            revokeUndecided: input.revokeUndecided ?? false,
            ...(input.dueAt ? { dueAt: input.dueAt } : {}),
            origin: 'manual',
            startedBy: context.principal.id,
            ...(options.iamAccess ? { iamAccess: options.iamAccess } : {}),
          });
          await context.activity({
            roomId: room.id,
            action: 'review.started',
            metadata: { reviewId: review.id, name: review.name, people: items.length },
          });
          context.emit('review.started', {
            reviewId: review.id,
            name: review.name,
            people: items.length,
            origin: 'manual',
          });
          return { review, items, progress: progressOf(items) };
        },
      }),

      list: endpoint({
        operation: { action: READ, target: 'room', mutates: false, allowClosed: true },
        input: v.object({
          roomId: v.id(),
          status: v.optional(v.enum(['open', 'completed', 'cancelled'] as const)),
        }),
        target: (input) => ({ roomId: input.roomId }),
        async handler(context, input) {
          return context.db.findMany<AccessReview>('accessReviews', {
            where: {
              tenantId: context.tenantId,
              roomId: context.room!.id,
              ...(input.status ? { status: input.status } : {}),
            },
            orderBy: [{ field: 'createdAt', direction: 'desc' }],
          });
        },
      }),

      get: endpoint({
        operation: { action: READ, target: 'room', mutates: false, allowClosed: true },
        input: v.object({ reviewId: v.id() }),
        target: reviewTarget,
        async handler(context, input) {
          const review = await loadReview(context, input.reviewId);
          const items = await context.db.findMany<AccessReviewItem>('accessReviewItems', {
            where: { tenantId: context.tenantId, reviewId: review.id },
            orderBy: [{ field: 'createdAt' }],
          });
          return { review, items, progress: progressOf(items) };
        },
      }),

      /**
       * Records decisions (up to 500 at once). Nobody decides on their own access: someone else must review it. A
       * decision can change until the review completes.
       */
      decide: endpoint({
        operation: { action: MANAGE, target: 'room', mutates: true },
        input: v.object({
          reviewId: v.id(),
          decisions: v.array(
            v.object({
              itemId: v.id(),
              decision: v.enum(['keep', 'revoke', 'pending'] as const),
              note: v.optional(v.string({ max: 1000 })),
            }),
            { min: 1, max: 500 },
          ),
        }),
        target: reviewTarget,
        async handler(context, input) {
          const review = await loadReview(context, input.reviewId);
          requireOpen(review);
          const items = await context.db.findMany<AccessReviewItem>('accessReviewItems', {
            where: { tenantId: context.tenantId, reviewId: review.id },
          });
          const byId = new Map(items.map((item) => [item.id, item]));
          for (const entry of input.decisions) {
            const item = byId.get(entry.itemId);
            if (!item) throw notFound('Review item');
            if (item.identityId === context.principal.id)
              throw new BetterFilesError('FORBIDDEN', 'Someone else must review your own access');
          }
          for (const entry of input.decisions) {
            const patch = {
              decision: entry.decision,
              ...(entry.decision === 'pending'
                ? { decidedBy: null, decidedAt: null, note: null }
                : {
                    decidedBy: context.principal.id,
                    decidedAt: context.now,
                    note: entry.note ?? null,
                  }),
              updatedAt: context.now,
            };
            await context.db.update(
              'accessReviewItems',
              { id: entry.itemId, tenantId: context.tenantId },
              patch,
            );
            Object.assign(byId.get(entry.itemId)!, patch);
          }
          await context.db.update(
            'accessReviews',
            { id: review.id, tenantId: context.tenantId },
            { updatedAt: context.now },
          );
          return { progress: progressOf([...byId.values()]) };
        },
      }),

      /** Takes the recommendation for every undecided person, except the caller's own entry. */
      acceptRecommendations: endpoint({
        operation: { action: MANAGE, target: 'room', mutates: true },
        input: v.object({ reviewId: v.id() }),
        target: reviewTarget,
        async handler(context, input) {
          const review = await loadReview(context, input.reviewId);
          requireOpen(review);
          const items = await context.db.findMany<AccessReviewItem>('accessReviewItems', {
            where: { tenantId: context.tenantId, reviewId: review.id },
          });
          let decided = 0;
          for (const item of items) {
            if (item.decision !== 'pending' || item.identityId === context.principal.id) continue;
            const patch = {
              decision: item.recommendation,
              decidedBy: context.principal.id,
              decidedAt: context.now,
              note: `Recommended: ${item.reason}`,
              updatedAt: context.now,
            };
            await context.db.update(
              'accessReviewItems',
              { id: item.id, tenantId: context.tenantId },
              patch,
            );
            Object.assign(item, patch);
            decided++;
          }
          return { decided, progress: progressOf(items) };
        },
      }),

      /**
       * Completes the review: people marked `revoke` (and, with `revokeUndecided`, everyone still undecided) are removed
       * from the room through `members.remove`, which takes them out of Better IAM's groups and relationships. Without
       * `revokeUndecided`, every person must be decided first. Each removal is checked as the caller.
       */
      complete: endpoint({
        operation: { action: MANAGE, target: 'room', mutates: true },
        transaction: 'manual',
        input: v.object({ reviewId: v.id() }),
        target: reviewTarget,
        async handler(context, input) {
          const room = context.room!;
          const review = await loadReview(context, input.reviewId);
          requireOpen(review);
          const items = await context.db.findMany<AccessReviewItem>('accessReviewItems', {
            where: { tenantId: context.tenantId, reviewId: review.id },
            orderBy: [{ field: 'createdAt' }],
          });
          const pending = items.filter((item) => item.decision === 'pending');
          if (pending.length && !review.revokeUndecided)
            throw new BetterFilesError(
              'CONFLICT',
              `${pending.length} ${pending.length === 1 ? 'person is' : 'people are'} still undecided`,
            );
          const summary = { kept: 0, revoked: 0, gone: 0, failed: 0, flagged: 0 };
          const flagged: { identityId: string; email: string | null; access: string | null }[] = [];
          for (const item of items) {
            const revoke = item.decision === 'revoke' || item.decision === 'pending';
            let outcome: NonNullable<AccessReviewItem['outcome']> = 'kept';
            let error: string | undefined;
            if (revoke && (item.source === 'iam' || !item.memberId)) {
              // Not on the roster: only the identity system can take this access away.
              outcome = 'flagged';
              if (item.identityId)
                flagged.push({
                  identityId: item.identityId,
                  email: item.email ?? null,
                  access: item.access ?? null,
                });
            } else if (revoke) {
              const member = await context.db.findOne<Member>('members', {
                id: item.memberId!,
                tenantId: context.tenantId,
                roomId: room.id,
              });
              if (!member || member.status === 'removed') outcome = 'gone';
              else
                try {
                  await context.call('members.remove', { roomId: room.id, memberId: member.id });
                  outcome = 'revoked';
                } catch (failure) {
                  outcome = 'failed';
                  error = failure instanceof Error ? failure.message : String(failure);
                }
            }
            summary[outcome]++;
            await context.db.transaction((tx) =>
              tx.update(
                'accessReviewItems',
                { id: item.id, tenantId: context.tenantId },
                {
                  outcome,
                  ...(error ? { error } : {}),
                  ...(item.decision === 'pending'
                    ? {
                        decision: 'revoke',
                        note: 'Undecided at completion',
                        decidedAt: context.now,
                      }
                    : {}),
                  updatedAt: context.now,
                },
              ),
            );
          }
          await context.db.transaction((tx) =>
            tx.update(
              'accessReviews',
              { id: review.id, tenantId: context.tenantId },
              {
                status: 'completed',
                completedAt: context.now,
                completedBy: context.principal.id,
                summary,
                updatedAt: context.now,
              },
            ),
          );
          await context.activity({
            roomId: room.id,
            action: 'review.completed',
            metadata: { reviewId: review.id, ...summary },
          });
          context.emit('review.completed', { reviewId: review.id, ...summary });
          if (flagged.length)
            context.emit('review.iam-access-flagged', { reviewId: review.id, identities: flagged });
          return { reviewId: review.id, summary, flagged };
        },
      }),

      cancel: endpoint({
        operation: { action: MANAGE, target: 'room', mutates: true },
        input: v.object({ reviewId: v.id(), reason: v.optional(v.string({ max: 1000 })) }),
        target: reviewTarget,
        async handler(context, input) {
          const review = await loadReview(context, input.reviewId);
          requireOpen(review);
          await context.db.update(
            'accessReviews',
            { id: review.id, tenantId: context.tenantId },
            {
              status: 'cancelled',
              completedAt: context.now,
              completedBy: context.principal.id,
              updatedAt: context.now,
            },
          );
          await context.activity({
            roomId: review.roomId,
            action: 'review.cancelled',
            metadata: { reviewId: review.id, reason: input.reason ?? null },
          });
          return { reviewId: review.id, status: 'cancelled' as const };
        },
      }),
    },
  });
}
