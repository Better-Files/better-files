import {
  defineTable,
  definePlugin,
  endpoint,
  field,
  prefixedId,
  v,
  type DatabaseAdapter,
  type BetterFilesEvent,
  type Member,
  type Room,
} from '@better-files/core';

export interface Email {
  to: string;
  subject: string;
  text: string;
  /** Deduplicate retries with this. */
  id: string;
}

/** Delivers mail: an SMTP client, a provider API, or Better IAM's delivery callback. */
export interface Mailer {
  send(email: Email): Promise<void>;
}

export interface Recipient {
  identityId: string;
  email: string;
  name?: string;
}

export interface NotificationsOptions {
  mailer: Mailer;
  /** Looks up an identity's email when the room roster does not have it. */
  resolveRecipient?: (input: {
    tenantId: string;
    identityId: string;
  }) => Promise<Recipient | undefined>;
  /** Link included in messages, for example `https://app.example.com/rooms/{roomId}`. */
  roomUrl?: (input: { tenantId: string; roomId: string }) => string;
  /** Product name in subjects. Default "Data room". */
  productName?: string;
}

type Mode = 'instant' | 'daily' | 'off';

interface Preference {
  id: string;
  tenantId: string;
  roomId: string;
  identityId: string;
  mode: Mode;
  createdAt: number;
}

interface Pending {
  id: string;
  tenantId: string;
  roomId: string;
  identityId: string;
  email: string;
  summary: string;
  sentAt?: number;
  createdAt: number;
}

/**
 * Email notifications for room members, instant or as a daily digest per person, with per-room preferences.
 * Messages never contain document names or contents, only what happened and a link back: the room enforces who may
 * see what.
 */
export function notificationsPlugin(options: NotificationsOptions) {
  const product = options.productName ?? 'Data room';

  async function recipients(db: DatabaseAdapter, event: BetterFilesEvent): Promise<Recipient[]> {
    const data = event.data;
    const direct = (id: unknown) => (typeof id === 'string' ? [id] : []);
    let identityIds: string[] = [];
    if (
      event.type === 'task.created' ||
      event.type === 'task.overdue' ||
      event.type === 'qa.assigned'
    )
      identityIds = direct(data.assigneeId);
    else if (
      event.type === 'document.uploaded' ||
      event.type === 'version.created' ||
      event.type === 'room.published'
    ) {
      const members = await db.findMany<Member>('members', {
        where: { tenantId: event.tenantId, roomId: event.roomId!, status: 'active' },
      });
      identityIds = members.flatMap((member) => (member.identityId ? [member.identityId] : []));
    }
    identityIds = [...new Set(identityIds)].filter((id) => id !== event.actorId);
    const out: Recipient[] = [];
    for (const identityId of identityIds) {
      const member = await db.findOne<Member>('members', {
        tenantId: event.tenantId,
        roomId: event.roomId!,
        identityId,
      });
      if (member?.email) out.push({ identityId, email: member.email });
      else {
        const resolved = await options.resolveRecipient?.({ tenantId: event.tenantId, identityId });
        if (resolved) out.push(resolved);
      }
    }
    return out;
  }

  const summaries: Record<string, (event: BetterFilesEvent) => string> = {
    'document.uploaded': () => 'New documents were added',
    'version.created': () => 'Documents were updated',
    'room.published': () => 'The room is now open',
    'task.created': (event) => `A task was assigned to you: ${String(event.data.title ?? '')}`,
    'task.overdue': (event) => `A task is overdue: ${String(event.data.title ?? '')}`,
    'qa.assigned': () => 'A question was assigned to you',
  };

  async function send(
    db: DatabaseAdapter,
    tenantId: string,
    roomId: string,
    recipient: Recipient,
    lines: string[],
    key: string,
  ) {
    const room = await db.findOne<Room>('rooms', { id: roomId, tenantId });
    const link = options.roomUrl?.({ tenantId, roomId });
    await options.mailer.send({
      id: key,
      to: recipient.email,
      subject: `${product}: ${room?.name ?? 'activity'}`,
      text: [
        `Hello${recipient.name ? ` ${recipient.name}` : ''},`,
        '',
        ...lines.map((line) => `- ${line}`),
        '',
        ...(link ? [`Open the room: ${link}`] : []),
        'You can change how often you hear from this room in its notification settings.',
      ].join('\n'),
    });
  }

  return definePlugin({
    id: 'notifications',
    actions: ['better-files:notifications:manage'],
    accessModel: [
      {
        relations: ['owner', 'admin', 'publisher', 'editor', 'contributor', 'viewer', 'auditor'],
        actions: ['better-files:notifications:manage'],
      },
    ],
    schema: {
      notificationPreferences: defineTable({
        fields: {
          roomId: field.string(),
          identityId: field.string(),
          mode: field.enum(['instant', 'daily', 'off'] as const),
        },
        indexes: [{ fields: ['tenantId', 'roomId', 'identityId'], unique: true }],
      }),
      pendingNotifications: defineTable({
        fields: {
          roomId: field.string(),
          identityId: field.string(),
          email: field.string(),
          summary: field.string(),
          sentAt: field.timestamp({ required: false }),
        },
        indexes: [{ fields: ['sentAt'] }],
      }),
    },
    async onEvent(event, context) {
      const summary = summaries[event.type];
      if (!summary || !event.roomId) return;
      for (const recipient of await recipients(context.db, event)) {
        const preference = await context.db.findOne<Preference>('notificationPreferences', {
          tenantId: event.tenantId,
          roomId: event.roomId,
          identityId: recipient.identityId,
        });
        // Assignments go out at once by default; room activity is batched into a daily digest.
        const personal = event.type.startsWith('task.') || event.type === 'qa.assigned';
        const mode: Mode = preference?.mode ?? (personal ? 'instant' : 'daily');
        if (mode === 'off') continue;
        if (mode === 'instant')
          await send(
            context.db,
            event.tenantId,
            event.roomId,
            recipient,
            [summary(event)],
            `${event.id}:${recipient.identityId}`,
          );
        else
          await context.db.transaction((tx) =>
            tx.insert('pendingNotifications', {
              id: prefixedId('ntf', context.now),
              tenantId: event.tenantId,
              roomId: event.roomId!,
              identityId: recipient.identityId,
              email: recipient.email,
              summary: summary(event),
              createdAt: context.now,
            } satisfies Pending),
          );
      }
    },
    /** Sends each person one digest per room with everything queued since the last one (call daily, or more often). */
    async maintain(context) {
      const pending = await context.db.findMany<Pending>('pendingNotifications', {
        where: { sentAt: { isNull: true } },
        limit: 5000,
      });
      const batches = new Map<string, Pending[]>();
      for (const item of pending) {
        const key = `${item.tenantId}|${item.roomId}|${item.identityId}`;
        batches.set(key, [...(batches.get(key) ?? []), item]);
      }
      for (const [key, items] of batches) {
        const first = items[0]!;
        const lines = [...new Set(items.map((item) => item.summary))];
        await send(
          context.db,
          first.tenantId,
          first.roomId,
          { identityId: first.identityId, email: first.email },
          lines,
          `digest:${key}:${first.createdAt}`,
        );
        await context.db.transaction(async (tx) => {
          for (const item of items)
            await tx.update(
              'pendingNotifications',
              { id: item.id, tenantId: item.tenantId },
              { sentAt: context.now },
            );
        });
      }
      await context.db.transaction((tx) =>
        tx.delete('pendingNotifications', { sentAt: { lt: context.now - 30 * 86_400_000 } }),
      );
    },
    endpoints: {
      /** The caller's notification setting for a room. */
      setPreference: endpoint({
        operation: {
          action: 'better-files:notifications:manage',
          target: 'room',
          mutates: true,
          allowClosed: true,
        },
        input: v.object({ roomId: v.id(), mode: v.enum(['instant', 'daily', 'off'] as const) }),
        target: (input) => ({ roomId: input.roomId }),
        async handler(context, input) {
          const where = {
            tenantId: context.tenantId,
            roomId: context.room!.id,
            identityId: context.principal.id,
          };
          const existing = await context.db.findOne<Preference>('notificationPreferences', where);
          if (existing)
            await context.db.update(
              'notificationPreferences',
              { id: existing.id, tenantId: context.tenantId },
              { mode: input.mode },
            );
          else
            await context.db.insert('notificationPreferences', {
              ...where,
              id: prefixedId('npref', context.now),
              mode: input.mode,
              createdAt: context.now,
            });
          return { mode: input.mode };
        },
      }),
    },
  });
}
