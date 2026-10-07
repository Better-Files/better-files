import {
  definePlugin,
  endpoint,
  notFound,
  v,
  type ActivityRecord,
  type DataRoomNode,
  type Member,
  type PermissionGroup,
  type PluginContext,
} from '@better-files/core';

const VIEWED = 'document.viewed';
const DOWNLOADED = 'document.downloaded';
const DAY = 86_400_000;

interface Tally {
  views: number;
  downloads: number;
  documents: Set<string>;
  lastActiveAt?: number;
}

const tally = (): Tally => ({ views: 0, downloads: 0, documents: new Set() });
const add = (entry: Tally, record: ActivityRecord) => {
  if (record.action === VIEWED) entry.views++;
  else entry.downloads++;
  if (record.nodeId) entry.documents.add(record.nodeId);
  entry.lastActiveAt = Math.max(entry.lastActiveAt ?? 0, record.createdAt);
};
const view = ({ documents, ...entry }: Tally) => ({ ...entry, documents: documents.size });

async function engagementRecords(
  context: PluginContext,
  roomId: string,
  since: number,
  nodeId?: string,
) {
  const records: ActivityRecord[] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await context.db.findMany<ActivityRecord>('activity', {
      where: {
        tenantId: context.tenantId,
        roomId,
        action: { in: [VIEWED, DOWNLOADED] },
        createdAt: { gte: since },
        ...(nodeId ? { nodeId } : {}),
      },
      orderBy: [{ field: 'sequence' }],
      limit: 1000,
      offset,
    });
    records.push(...page);
    if (page.length < 1000 || records.length >= 100_000) break;
  }
  return records;
}

/**
 * Engagement analytics from the activity log: who opened what and when, per person, per team and per document, with
 * a daily series, and who has not yet opened a document. For room administrators and auditors.
 */
export function analyticsPlugin() {
  return definePlugin({
    id: 'analytics',
    endpoints: {
      engagement: endpoint({
        operation: {
          action: 'better-files:activity:read',
          target: 'room',
          mutates: false,
          allowClosed: true,
        },
        input: v.object({
          roomId: v.id(),
          days: v.optional(v.number({ int: true, min: 1, max: 365 })),
        }),
        target: (input) => ({ roomId: input.roomId }),
        async handler(context, input) {
          const room = context.room!;
          const days = input.days ?? 30;
          const since = context.now - days * DAY;
          const [records, members, groups, nodes] = await Promise.all([
            engagementRecords(context, room.id, since),
            context.db.findMany<Member>('members', {
              where: { tenantId: context.tenantId, roomId: room.id },
            }),
            context.db.findMany<PermissionGroup>('permissionGroups', {
              where: { tenantId: context.tenantId, roomId: room.id },
            }),
            context.db.findMany<DataRoomNode>('nodes', {
              where: { tenantId: context.tenantId, roomId: room.id, kind: 'document' },
            }),
          ]);
          const byPerson = new Map<string, Tally>();
          const byGroup = new Map<string, Tally>();
          const byDocument = new Map<string, Tally & { people: Set<string> }>();
          const series = new Map<string, { views: number; downloads: number }>();
          const memberOf = new Map(
            members.flatMap((member) =>
              member.identityId ? [[member.identityId, member] as const] : [],
            ),
          );
          for (const record of records) {
            const person = byPerson.get(record.actorId) ?? tally();
            add(person, record);
            byPerson.set(record.actorId, person);
            for (const groupId of memberOf.get(record.actorId)?.groupIds ?? []) {
              const group = byGroup.get(groupId) ?? tally();
              add(group, record);
              byGroup.set(groupId, group);
            }
            if (record.nodeId) {
              const document = byDocument.get(record.nodeId) ?? {
                ...tally(),
                people: new Set<string>(),
              };
              add(document, record);
              document.people.add(record.actorId);
              byDocument.set(record.nodeId, document);
            }
            const day = new Date(record.createdAt).toISOString().slice(0, 10);
            const bucket = series.get(day) ?? { views: 0, downloads: 0 };
            if (record.action === VIEWED) bucket.views++;
            else bucket.downloads++;
            series.set(day, bucket);
          }
          const names = new Map(nodes.map((node) => [node.id, node.name]));
          const groupNames = new Map(groups.map((group) => [group.id, group.name]));
          return {
            days,
            totals: {
              views: records.filter((r) => r.action === VIEWED).length,
              downloads: records.filter((r) => r.action === DOWNLOADED).length,
            },
            people: [...byPerson]
              .map(([identityId, entry]) => ({
                identityId,
                email: memberOf.get(identityId)?.email ?? null,
                ...view(entry),
              }))
              .sort((a, b) => b.views + b.downloads - (a.views + a.downloads)),
            groups: [...byGroup].map(([groupId, entry]) => ({
              groupId,
              name: groupNames.get(groupId) ?? null,
              ...view(entry),
            })),
            documents: [...byDocument]
              .map(([nodeId, { people, ...entry }]) => ({
                nodeId,
                name: names.get(nodeId) ?? null,
                people: people.size,
                ...view(entry),
              }))
              .sort((a, b) => b.views + b.downloads - (a.views + a.downloads)),
            series: [...series]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([day, counts]) => ({ day, ...counts })),
          };
        },
      }),
      /** Room members who have not opened a document (in the window), for follow-ups. */
      unseen: endpoint({
        operation: {
          action: 'better-files:activity:read',
          target: 'room',
          mutates: false,
          allowClosed: true,
        },
        input: v.object({
          roomId: v.id(),
          nodeId: v.id(),
          days: v.optional(v.number({ int: true, min: 1, max: 3650 })),
        }),
        target: (input) => ({ roomId: input.roomId }),
        async handler(context, input) {
          const room = context.room!;
          const node = await context.db.findOne<DataRoomNode>('nodes', {
            id: input.nodeId,
            tenantId: context.tenantId,
            roomId: room.id,
          });
          if (!node || node.kind !== 'document') throw notFound('Document');
          const since = context.now - (input.days ?? 3650) * DAY;
          const records = await engagementRecords(context, room.id, since, node.id);
          const seen = new Set(records.map((record) => record.actorId));
          const members = await context.db.findMany<Member>('members', {
            where: { tenantId: context.tenantId, roomId: room.id, status: 'active' },
          });
          return members
            .filter((member) => member.identityId && !seen.has(member.identityId))
            .map((member) => ({
              memberId: member.id,
              identityId: member.identityId!,
              email: member.email ?? null,
              groupIds: member.groupIds,
            }));
        },
      }),
    },
  });
}
