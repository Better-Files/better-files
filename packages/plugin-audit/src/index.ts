import { createHash } from 'node:crypto';
import {
  BetterFilesError,
  definePlugin,
  endpoint,
  resolvePathMasks,
  subjectKey,
  v,
  type AccessEntry,
  type ActivityRecord,
  type DataRoomNode,
  type NodeClosure,
  type PluginContext,
} from '@better-files/core';

export interface AuditReport {
  room: {
    id: string;
    name: string;
    status: string;
    createdAt: string;
    documents: number;
    folders: number;
  };
  generatedAt: string;
  generatedBy: string;
  /** The activity log's hash chain, recomputed now. */
  chain: { valid: boolean; [key: string]: unknown };
  groups: { name: string; kind: string; relation: string; members: number }[];
  participants: {
    identityId: string | null;
    email: string | null;
    status: string;
    relation: string | null;
    groups: string[];
    guest: boolean;
    lastSeenAt: string | null;
  }[];
  /** Capabilities each group holds on each folder (the permission matrix, before room settings and plugins). */
  access: { path: string; groups: Record<string, string[]> }[];
  engagement: {
    identityId: string;
    email: string | null;
    views: number;
    downloads: number;
    uploads: number;
    other: number;
    lastActivityAt: string;
  }[];
}

export interface AuditResult {
  filename: string;
  mimeType: string;
  sha256: string;
  size: number;
  /** Where the report was filed, with `saveTo`. */
  nodeId?: string;
  /** The report, for `format: 'json'`. */
  report?: AuditReport;
  /** The PDF, base64-encoded, for `format: 'pdf'`. */
  content?: string;
}

interface MemberRow {
  identityId?: string;
  email?: string;
  status: string;
  relation?: string;
  groupIds: string[];
  guest: boolean;
  lastSeenAt?: number;
}
interface GroupRow {
  id: string;
  name: string;
  kind: string;
  relation: string;
  iamGroupId: string;
}
interface AclRow {
  nodeId: string;
  subjectType: 'identity' | 'group' | 'link';
  subjectId: string;
  mask: number;
  locked: boolean;
  expiresAt?: number;
}

const iso = (time: number | undefined) => (time ? new Date(time).toISOString() : null);

async function build(context: PluginContext, depth: number): Promise<AuditReport> {
  const room = context.room!;
  const { tenantId } = context;
  const [nodes, members, groups, entries, closure] = await Promise.all([
    context.db.findMany<DataRoomNode>('nodes', {
      where: { tenantId, roomId: room.id, deletedAt: { isNull: true } },
    }),
    context.db.findMany<MemberRow>('members', { where: { tenantId, roomId: room.id } }),
    context.db.findMany<GroupRow>('permissionGroups', { where: { tenantId, roomId: room.id } }),
    context.db.findMany<AclRow>('aclEntries', { where: { tenantId, roomId: room.id } }),
    context.db.findMany<NodeClosure>('nodeClosure', { where: { tenantId, roomId: room.id } }),
  ]);
  const chain = await context.call<{ valid: boolean }>('activity.verify', { roomId: room.id });

  // Ancestor paths from the closure table: root first.
  const ancestors = new Map<string, NodeClosure[]>();
  for (const pair of closure)
    ancestors.set(pair.descendantId, [...(ancestors.get(pair.descendantId) ?? []), pair]);
  const pathOf = (id: string) =>
    (ancestors.get(id) ?? []).sort((a, b) => b.depth - a.depth).map((pair) => pair.ancestorId);
  const names = new Map(nodes.map((node) => [node.id, node.name]));
  const accessEntries: AccessEntry[] = entries.map((entry) => ({
    nodeId: entry.nodeId,
    subject: subjectKey(entry.subjectType, entry.subjectId),
    mask: entry.mask,
    locked: entry.locked,
    ...(entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt }),
  }));
  const folders = nodes
    .filter((node) => node.kind === 'folder' && pathOf(node.id).length - 1 <= depth)
    .map((node) => ({ node, path: pathOf(node.id) }))
    .sort((a, b) =>
      a.path
        .map((id) => names.get(id))
        .join('/')
        .localeCompare(b.path.map((id) => names.get(id)).join('/')),
    );
  const access = folders.map(({ node, path }) => ({
    path:
      node.id === room.rootNodeId
        ? '/'
        : `/${path
            .slice(1)
            .map((id) => names.get(id))
            .join('/')}`,
    groups: Object.fromEntries(
      groups.map((group) => {
        const masks = resolvePathMasks({
          path,
          entries: accessEntries,
          subjects: [subjectKey('group', group.iamGroupId)],
          now: context.now,
        });
        return [group.name, context.capabilities.namesOf(masks.at(-1) ?? 0)];
      }),
    ),
  }));

  // Engagement from the whole activity log, paged.
  const people = new Map<string, AuditReport['engagement'][number]>();
  const emailOf = new Map(
    members.flatMap((member) =>
      member.identityId ? [[member.identityId, member.email ?? null] as const] : [],
    ),
  );
  for (let after = 0; ; ) {
    const page = await context.db.findMany<ActivityRecord>('activity', {
      where: { tenantId, roomId: room.id, sequence: { gt: after } },
      orderBy: [{ field: 'sequence' }],
      limit: 1000,
    });
    for (const record of page) {
      const entry = people.get(record.actorId) ?? {
        identityId: record.actorId,
        email: emailOf.get(record.actorId) ?? null,
        views: 0,
        downloads: 0,
        uploads: 0,
        other: 0,
        lastActivityAt: '',
      };
      if (record.action === 'document.viewed') entry.views++;
      else if (record.action === 'document.downloaded' || record.action === 'folder.downloaded')
        entry.downloads++;
      else if (record.action === 'document.uploaded' || record.action === 'version.created')
        entry.uploads++;
      else entry.other++;
      entry.lastActivityAt = new Date(record.createdAt).toISOString();
      people.set(record.actorId, entry);
    }
    if (page.length < 1000) break;
    after = page.at(-1)!.sequence;
  }
  const groupNames = new Map(groups.map((group) => [group.id, group.name]));
  const memberCount = (groupId: string) =>
    members.filter((member) => member.status !== 'removed' && member.groupIds.includes(groupId))
      .length;
  return {
    room: {
      id: room.id,
      name: room.name,
      status: room.status,
      createdAt: new Date(room.createdAt).toISOString(),
      documents: nodes.filter((node) => node.kind === 'document').length,
      folders: nodes.filter((node) => node.kind === 'folder' && node.id !== room.rootNodeId).length,
    },
    generatedAt: new Date(context.now).toISOString(),
    generatedBy: context.principal.email ?? context.principal.id,
    chain,
    groups: groups.map((group) => ({
      name: group.name,
      kind: group.kind,
      relation: group.relation,
      members: memberCount(group.id),
    })),
    participants: members
      .filter((member) => member.status !== 'removed')
      .map((member) => ({
        identityId: member.identityId ?? null,
        email: member.email ?? null,
        status: member.status,
        relation: member.relation ?? null,
        groups: member.groupIds.map((id) => groupNames.get(id) ?? id),
        guest: member.guest,
        lastSeenAt: iso(member.lastSeenAt),
      })),
    access,
    engagement: [...people.values()].sort(
      (a, b) => b.views + b.downloads - (a.views + a.downloads),
    ),
  };
}

/** A plain, paginated PDF of the report (pdf-lib, no fonts to install). */
async function renderPdf(report: AuditReport): Promise<Uint8Array> {
  let PDFDocument: typeof import('pdf-lib').PDFDocument;
  let StandardFonts: typeof import('pdf-lib').StandardFonts;
  try {
    ({ PDFDocument, StandardFonts } = await import('pdf-lib'));
  } catch {
    throw new BetterFilesError('UNSUPPORTED', 'PDF reports need the pdf-lib package');
  }
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Audit report: ${report.room.name}`);
  pdf.setProducer('Better Files');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const [width, height, margin] = [595, 842, 48];
  let page = pdf.addPage([width, height]);
  let y = height - margin;
  // Standard fonts cover WinAnsi only: anything else is replaced rather than failing the report.
  const ascii = (text: string) => text.replace(/[^\x20-\x7E -ÿ]/g, '?');
  const line = (text: string, options: { size?: number; bold?: boolean; indent?: number } = {}) => {
    const size = options.size ?? 9;
    if (y < margin + size) {
      page = pdf.addPage([width, height]);
      y = height - margin;
    }
    const face = options.bold ? bold : font;
    let content = ascii(text);
    const room = width - margin * 2 - (options.indent ?? 0);
    while (content.length > 1 && face.widthOfTextAtSize(content, size) > room)
      content = `${content.slice(0, -2)}…`.replace('…', '.');
    page.drawText(content, { x: margin + (options.indent ?? 0), y, size, font: face });
    y -= size + 4;
  };
  const gap = () => (y -= 8);

  line(`Audit report: ${report.room.name}`, { size: 16, bold: true });
  line(`Room ${report.room.id} · ${report.room.status} · created ${report.room.createdAt}`);
  line(`Generated ${report.generatedAt} by ${report.generatedBy}`);
  line(`${report.room.documents} documents in ${report.room.folders} folders`);
  line(`Activity chain: ${report.chain.valid ? 'intact' : 'BROKEN'}`, { bold: true });
  gap();
  line('Groups', { size: 12, bold: true });
  for (const group of report.groups)
    line(`${group.name} (${group.kind}, ${group.relation}): ${group.members} members`, {
      indent: 8,
    });
  gap();
  line('Participants', { size: 12, bold: true });
  for (const person of report.participants)
    line(
      `${person.email ?? person.identityId} · ${person.status}${person.guest ? ' · guest' : ''}${person.relation ? ` · ${person.relation}` : ''} · ${person.groups.join(', ') || 'no groups'} · last seen ${person.lastSeenAt ?? 'never'}`,
      { indent: 8 },
    );
  gap();
  line('Access by folder and group', { size: 12, bold: true });
  for (const folder of report.access) {
    line(folder.path, { bold: true, indent: 8 });
    for (const [group, capabilities] of Object.entries(folder.groups))
      line(`${group}: ${capabilities.length ? capabilities.join(', ') : 'no access'}`, {
        indent: 20,
      });
  }
  gap();
  line('Engagement', { size: 12, bold: true });
  for (const person of report.engagement)
    line(
      `${person.email ?? person.identityId}: ${person.views} views, ${person.downloads} downloads, ${person.uploads} uploads, last ${person.lastActivityAt}`,
      { indent: 8 },
    );
  return pdf.save();
}

/**
 * Audit reports: who is in a room, what each group may do on each folder, who looked at and took what, and whether
 * the activity log's hash chain is intact. Returned as JSON or a PDF (with its SHA-256), or filed into the room as
 * a document for a closing binder. Needs `better-files:activity:export` (auditors and administrators).
 */
export function auditPlugin() {
  return definePlugin({
    id: 'audit',
    endpoints: {
      report: endpoint({
        operation: {
          action: 'better-files:activity:export',
          target: 'room',
          mutates: false,
          allowClosed: true,
        },
        input: v.object({
          roomId: v.id(),
          format: v.optional(v.enum(['json', 'pdf'] as const)),
          /** Folder levels in the access matrix. Default 2. */
          depth: v.optional(v.number({ int: true, min: 0, max: 10 })),
          /** File the report into this folder of the room as well. */
          saveTo: v.optional(v.id()),
        }),
        target: (input) => ({ roomId: input.roomId }),
        async handler(context, input) {
          const report = await build(context, input.depth ?? 2);
          const format = input.format ?? 'json';
          const content =
            format === 'pdf'
              ? await renderPdf(report)
              : new TextEncoder().encode(JSON.stringify(report, null, 2));
          const filename = `Audit report ${report.room.name.replace(/[\\/:*?"<>|]/g, '_')} ${report.generatedAt.slice(0, 10)}.${format}`;
          const mimeType = format === 'pdf' ? 'application/pdf' : 'application/json';
          const sha256 = createHash('sha256').update(content).digest('hex');
          let saved: { nodeId: string } | undefined;
          if (input.saveTo) {
            const folder = await context.db.findOne<DataRoomNode>('nodes', {
              id: input.saveTo,
              tenantId: context.tenantId,
              roomId: context.room!.id,
            });
            if (!folder || folder.kind !== 'folder')
              throw new BetterFilesError('INVALID_INPUT', 'saveTo must be a folder of this room');
            const [mask] = [...(await context.capabilitiesOf([folder])).values()];
            if (((mask ?? 0) & context.capabilities.mask(['UPLOAD'])) === 0)
              throw new BetterFilesError(
                'FORBIDDEN',
                'Filing the report needs upload access to the folder',
              );
            saved = await context.addDocument({
              parentId: folder.id,
              filename,
              mimeType,
              content,
              comment: `sha256 ${sha256}`,
            });
          }
          await context.activity({
            roomId: context.room!.id,
            action: 'audit.reported',
            ...(saved ? { nodeId: saved.nodeId } : {}),
            metadata: { format, sha256, chainValid: report.chain.valid },
          });
          const result: AuditResult = {
            filename,
            mimeType,
            sha256,
            size: content.byteLength,
            ...(saved ? { nodeId: saved.nodeId } : {}),
            ...(format === 'json'
              ? { report }
              : { content: Buffer.from(content).toString('base64') }),
          };
          return result;
        },
      }),
    },
  });
}
