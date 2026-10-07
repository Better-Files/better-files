import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import {
  Capability,
  createAccessIndex,
  BetterFilesError,
  defineTable,
  definePlugin,
  endpoint,
  field,
  forbidden,
  hasAll,
  loadNodePaths,
  notFound,
  prefixedId,
  subjectKey,
  v,
  type AclEntry,
  type DataRoomDocument,
  type DataRoomNode,
  type Member,
  type NodeClosure,
  type PermissionGroup,
  type PluginContext,
  type Room,
} from '@better-files/core';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  length: number,
) => Promise<Buffer>;

export interface ShareLink {
  id: string;
  tenantId: string;
  roomId: string;
  nodeId: string;
  tokenHash: string;
  mask: number;
  passwordHash?: string;
  requireEmail: boolean;
  expiresAt?: number;
  maxUses?: number;
  uses: number;
  disabledAt?: number;
  createdBy: string;
  lastUsedAt?: number;
  createdAt: number;
}

interface LinkSession {
  id: string;
  tenantId: string;
  linkId: string;
  email?: string;
  expiresAt: number;
  createdAt: number;
}

/** What a link can carry: never more than viewing and downloading. */
const linkCapabilities = ['VIEW', 'DOWNLOAD_WATERMARKED', 'DOWNLOAD_ORIGINAL'] as const;

/** Room relations that hold every capability everywhere (the `better-files:admin` floor). */
const ADMIN_RELATIONS = new Set(['owner', 'admin']);
const ENDED_STATUSES = new Set<Member['status']>(['removed', 'suspended', 'expired']);

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(24).toString('base64url');

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 32);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}
async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [, salt, key] = stored.split('$');
  if (!salt || !key) return false;
  const expected = Buffer.from(key, 'base64url');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64url'), expected.byteLength);
  return timingSafeEqual(actual, expected);
}

export interface LinksOptions {
  /** How long a visitor session lasts after opening a link. Default 2 hours. */
  sessionTtlMs?: number;
  /** Longest link lifetime a creator may choose, in days. Default 90. */
  maxDays?: number;
  /** Capability a creator must hold on the item to share it. Default MANAGE (room managers); `DOWNLOAD_ORIGINAL` lets downloaders share. */
  requiredCapability?: 'MANAGE' | 'DOWNLOAD_ORIGINAL' | 'DOWNLOAD_WATERMARKED' | 'VIEW';
}

/**
 * Share links, Dropbox-style: a secret URL for one document or folder, optionally with a password, an email the
 * visitor must give, an expiry and a use cap. Links are off until a room administrator enables them for the room,
 * carry at most view and download rights (never more than their creator holds), follow the room's state (closed
 * rooms stop serving), and every open and download lands in the room's activity log with the visitor's email.
 */
export function linksPlugin(options: LinksOptions = {}) {
  const sessionTtlMs = options.sessionTtlMs ?? 2 * 60 * 60_000;
  const maxDays = options.maxDays ?? 90;
  const required = options.requiredCapability ?? 'MANAGE';

  async function openSession(context: PluginContext, sessionToken: string) {
    const session = await context.db.findOne<LinkSession>('linkSessions', {
      id: sha256(sessionToken),
      tenantId: context.tenantId,
    });
    if (!session || session.expiresAt <= context.now)
      throw new BetterFilesError('UNAUTHENTICATED', 'The link session has expired');
    const link = await usableLink(context, session.linkId);
    return { session, link };
  }

  async function usableLink(
    context: PluginContext,
    linkId: string,
  ): Promise<ShareLink & { room: Room }> {
    const link = await context.db.findOne<ShareLink>('shareLinks', {
      id: linkId,
      tenantId: context.tenantId,
    });
    if (
      !link ||
      link.disabledAt !== undefined ||
      (link.expiresAt !== undefined && link.expiresAt <= context.now)
    )
      throw notFound('Link');
    const room = await context.db.findOne<Room & { linksEnabled?: boolean }>('rooms', {
      id: link.roomId,
      tenantId: context.tenantId,
    });
    if (!room || room.status !== 'live' || !room.linksEnabled) throw notFound('Link');
    return { ...link, room };
  }

  /**
   * What the link carries on each node now: its own mask, cut down to what its creator holds today in the room's
   * permission matrix. Items hidden from the creator stay hidden from visitors, and narrowing or removing the
   * creator narrows or stops their links. Room administrators (directly or through a group) hold everything. A
   * creator who is not on the room's roster holds access through a tenant-wide role in the identity system, which a
   * visitor's request cannot check, so their links keep the mask checked when they were made.
   */
  async function reach(
    context: PluginContext,
    link: ShareLink & { room: Room },
    nodes: readonly DataRoomNode[],
  ): Promise<Map<string, number>> {
    const all = (mask: number) => new Map(nodes.map((node) => [node.id, mask]));
    const member = await context.db.findOne<Member>('members', {
      tenantId: context.tenantId,
      roomId: link.roomId,
      identityId: link.createdBy,
    });
    if (!member) return all(link.mask);
    if (
      ENDED_STATUSES.has(member.status) ||
      (member.expiresAt !== undefined && member.expiresAt <= context.now)
    )
      return all(0);
    const groups = (
      member.groupIds.length
        ? await context.db.findMany<PermissionGroup>('permissionGroups', {
            where: { tenantId: context.tenantId, roomId: link.roomId, id: { in: member.groupIds } },
          })
        : []
    ).filter((group) => group.expiresAt === undefined || group.expiresAt > context.now);
    const relations = [member.relation, ...groups.map((group) => group.relation)];
    if (relations.some((relation) => relation !== undefined && ADMIN_RELATIONS.has(relation)))
      return all(link.mask);
    const floor = relations.includes('auditor') ? Capability.LIST | Capability.VIEW : 0;
    const paths = await loadNodePaths(context.db, context.tenantId, nodes);
    const ancestorIds = [...new Set([...paths.values()].flat())];
    const entries = ancestorIds.length
      ? await context.db.findMany<AclEntry>('aclEntries', {
          where: { tenantId: context.tenantId, roomId: link.roomId, nodeId: { in: ancestorIds } },
        })
      : [];
    const index = createAccessIndex({
      entries: entries.map((entry) => ({
        nodeId: entry.nodeId,
        subject: subjectKey(entry.subjectType, entry.subjectId),
        mask: entry.mask,
        locked: entry.locked,
        ...(entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt }),
      })),
      subjects: [
        subjectKey('identity', link.createdBy),
        ...groups.map((group) => subjectKey('group', group.iamGroupId)),
      ],
      now: context.now,
    });
    const requireAncestorList = link.room.settings.requireAncestorList !== false;
    return new Map(
      nodes.map((node) => {
        const path = paths.get(node.id) ?? [];
        return [node.id, (index.resolve(path, { requireAncestorList }) | floor) & link.mask];
      }),
    );
  }

  /**
   * The item must still exist, sit inside the shared node's subtree, and be one the creator may still list.
   * Returns the node and what the link carries on it.
   */
  async function inside(
    context: PluginContext,
    link: ShareLink & { room: Room },
    nodeId: string,
  ): Promise<{ node: DataRoomNode; mask: number }> {
    const node = await context.db.findOne<DataRoomNode>('nodes', {
      id: nodeId,
      tenantId: context.tenantId,
    });
    if (!node || node.deletedAt !== undefined || node.roomId !== link.roomId)
      throw notFound('Item');
    if (node.id !== link.nodeId) {
      const within = await context.db.findOne<NodeClosure>('nodeClosure', {
        tenantId: context.tenantId,
        ancestorId: link.nodeId,
        descendantId: node.id,
      });
      if (!within) throw notFound('Item');
    }
    const mask = (await reach(context, link, [node])).get(node.id) ?? 0;
    if ((mask & Capability.LIST) === 0) throw notFound('Item');
    return { node, mask };
  }

  const view = (node: DataRoomNode, extra: Record<string, unknown> = {}) => ({
    id: node.id,
    kind: node.kind,
    name: node.name,
    updatedAt: node.updatedAt,
    ...extra,
  });

  return definePlugin({
    id: 'links',
    actions: ['better-files:links:create', 'better-files:links:manage', 'better-files:links:open'],
    accessModel: [
      {
        relations: ['owner', 'admin', 'publisher'],
        actions: ['better-files:links:create', 'better-files:links:manage'],
      },
      { relations: ['editor', 'contributor', 'viewer'], actions: ['better-files:links:create'] },
    ],
    extendSchema: {
      rooms: { additionalFields: { linksEnabled: field.boolean({ required: false }) } },
    },
    schema: {
      shareLinks: defineTable({
        fields: {
          roomId: field.string(),
          nodeId: field.string(),
          tokenHash: field.string({ unique: true }),
          mask: field.number(),
          passwordHash: field.string({ required: false }),
          requireEmail: field.boolean(),
          expiresAt: field.timestamp({ required: false }),
          maxUses: field.number({ required: false }),
          uses: field.number(),
          disabledAt: field.timestamp({ required: false }),
          createdBy: field.string(),
          lastUsedAt: field.timestamp({ required: false }),
        },
        indexes: [{ fields: ['tenantId', 'roomId'] }],
      }),
      linkSessions: defineTable({
        fields: {
          linkId: field.string(),
          email: field.string({ required: false }),
          expiresAt: field.timestamp(),
        },
      }),
    },
    endpoints: {
      /** Turns links on or off for a room. Turning them off stops every existing link at once. */
      configure: endpoint({
        operation: { action: 'better-files:links:manage', target: 'room', mutates: true },
        input: v.object({ roomId: v.id(), enabled: v.boolean() }),
        target: (input) => ({ roomId: input.roomId }),
        async handler(context, input) {
          const room = context.room!;
          const admin = await context.db.findOne<{ relation?: string }>('members', {
            tenantId: context.tenantId,
            roomId: room.id,
            identityId: context.principal.id,
          });
          const rootCaps = await context.capabilitiesOf([
            (await context.db.findOne<DataRoomNode>('nodes', {
              id: room.rootNodeId,
              tenantId: context.tenantId,
            }))!,
          ]);
          if (
            !hasAll(rootCaps.get(room.rootNodeId) ?? 0, Capability.MANAGE) &&
            admin?.relation !== 'owner'
          )
            throw forbidden('Only room administrators can turn share links on or off');
          await context.db.update(
            'rooms',
            { id: room.id, tenantId: context.tenantId },
            { linksEnabled: input.enabled },
          );
          await context.activity({
            roomId: room.id,
            action: input.enabled ? 'links.enabled' : 'links.disabled',
          });
          return { enabled: input.enabled };
        },
      }),
      create: endpoint({
        operation: {
          action: 'better-files:links:create',
          target: 'node',
          capabilities: [required],
          mutates: true,
        },
        input: v.object({
          nodeId: v.id(),
          capabilities: v.array(v.enum(linkCapabilities), { min: 1, max: 3 }),
          password: v.optional(v.string({ min: 8, max: 200 })),
          requireEmail: v.optional(v.boolean()),
          expiresInDays: v.optional(v.number({ int: true, min: 1, max: 3650 })),
          maxUses: v.optional(v.number({ int: true, min: 1, max: 100_000 })),
        }),
        target: (input) => ({ nodeId: input.nodeId }),
        async handler(context, input) {
          const node = context.node!;
          const room = context.room! as Room & { linksEnabled?: boolean };
          if (!room.linksEnabled)
            throw new BetterFilesError('FORBIDDEN', 'Share links are turned off for this room');
          const mask = context.capabilities.mask(['LIST', ...input.capabilities]);
          const held = (await context.capabilitiesOf([node])).get(node.id) ?? 0;
          if ((mask & ~held) !== 0) throw forbidden('A link cannot carry more than you hold');
          const days = Math.min(input.expiresInDays ?? maxDays, maxDays);
          const token = secret();
          const link: ShareLink = {
            id: prefixedId('lnk', context.now),
            tenantId: context.tenantId,
            roomId: room.id,
            nodeId: node.id,
            tokenHash: sha256(token),
            mask,
            ...(input.password ? { passwordHash: await hashPassword(input.password) } : {}),
            requireEmail: input.requireEmail ?? false,
            expiresAt: context.now + days * 86_400_000,
            ...(input.maxUses ? { maxUses: input.maxUses } : {}),
            uses: 0,
            createdBy: context.principal.id,
            createdAt: context.now,
          };
          await context.db.insert('shareLinks', link);
          await context.activity({
            roomId: room.id,
            action: 'link.created',
            nodeId: node.id,
            metadata: {
              linkId: link.id,
              capabilities: input.capabilities,
              password: !!input.password,
              expiresAt: link.expiresAt,
            },
          });
          context.emit('link.created', { linkId: link.id, nodeId: node.id });
          const { tokenHash: _hash, passwordHash: _password, ...shown } = link;
          // The token is shown once; only its hash is stored.
          return {
            ...shown,
            token,
            capabilities: context.capabilities.namesOf(mask),
            password: !!input.password,
          };
        },
      }),
      list: endpoint({
        operation: {
          action: 'better-files:links:manage',
          target: 'room',
          mutates: false,
          allowClosed: true,
        },
        input: v.object({ roomId: v.id() }),
        target: (input) => ({ roomId: input.roomId }),
        async handler(context) {
          const links = await context.db.findMany<ShareLink>('shareLinks', {
            where: { tenantId: context.tenantId, roomId: context.room!.id },
            orderBy: [{ field: 'createdAt', direction: 'desc' }],
          });
          return links.map(({ tokenHash: _hash, passwordHash, ...link }) => ({
            ...link,
            capabilities: context.capabilities.namesOf(link.mask),
            password: passwordHash !== undefined,
          }));
        },
      }),
      disable: endpoint({
        operation: {
          action: 'better-files:links:manage',
          target: 'room',
          mutates: true,
          allowClosed: true,
        },
        input: v.object({ linkId: v.id() }),
        async target(input, lookup) {
          const link = await lookup.db.findOne<ShareLink>('shareLinks', {
            id: input.linkId,
            tenantId: lookup.tenantId,
          });
          if (!link) throw notFound('Link');
          return { roomId: link.roomId };
        },
        async handler(context, input) {
          await context.db.update(
            'shareLinks',
            { id: input.linkId, tenantId: context.tenantId },
            { disabledAt: context.now },
          );
          await context.db.delete('linkSessions', {
            tenantId: context.tenantId,
            linkId: input.linkId,
          });
          await context.activity({
            roomId: context.room!.id,
            action: 'link.disabled',
            metadata: { linkId: input.linkId },
          });
          return { disabled: true as const };
        },
      }),

      /** Public: exchanges a link token (plus password or email when required) for a short visitor session. */
      open: endpoint({
        operation: { action: 'better-files:links:open', target: 'public', mutates: true },
        input: v.object({
          token: v.string({ min: 10, max: 200 }),
          password: v.optional(v.string({ max: 200 })),
          email: v.optional(v.string({ max: 320, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ })),
        }),
        async handler(context, input) {
          const found = await context.db.findOne<ShareLink>('shareLinks', {
            tokenHash: sha256(input.token),
            tenantId: context.tenantId,
          });
          if (!found) throw notFound('Link');
          const link = await usableLink(context, found.id);
          if (
            link.passwordHash &&
            !(input.password && (await verifyPassword(input.password, link.passwordHash)))
          )
            throw new BetterFilesError('UNAUTHENTICATED', 'This link needs its password', {
              details: { password: true },
            });
          if (link.requireEmail && !input.email)
            throw new BetterFilesError('UNAUTHENTICATED', 'This link needs your email address', {
              details: { email: true },
            });
          const { node } = await inside(context, link, link.nodeId).catch(() => {
            throw notFound('Link');
          });
          const uses = await context.db.increment(
            'shareLinks',
            { id: link.id, tenantId: context.tenantId },
            'uses',
          );
          if (link.maxUses !== undefined && (uses ?? 0) > link.maxUses) throw notFound('Link');
          await context.db.update(
            'shareLinks',
            { id: link.id, tenantId: context.tenantId },
            { lastUsedAt: context.now },
          );
          const token = secret();
          await context.db.insert('linkSessions', {
            id: sha256(token),
            tenantId: context.tenantId,
            linkId: link.id,
            ...(input.email ? { email: input.email.toLowerCase() } : {}),
            expiresAt: context.now + sessionTtlMs,
            createdAt: context.now,
          } satisfies LinkSession);
          await context.activity({
            roomId: link.roomId,
            action: 'link.opened',
            nodeId: node.id,
            metadata: {
              linkId: link.id,
              email: input.email?.toLowerCase() ?? null,
              ip: context.request?.ip ?? null,
            },
          });
          return {
            session: token,
            expiresAt: context.now + sessionTtlMs,
            room: { id: link.room.id, name: link.room.name },
            item: view(node),
            capabilities: context.capabilities.namesOf(link.mask),
          };
        },
      }),
      /** Public: the items of a shared folder (or the shared document itself). */
      browse: endpoint({
        operation: { action: 'better-files:links:open', target: 'public', mutates: false },
        input: v.object({ session: v.string({ min: 10, max: 200 }), nodeId: v.optional(v.id()) }),
        async handler(context, input) {
          const { link } = await openSession(context, input.session);
          const { node } = await inside(context, link, input.nodeId ?? link.nodeId);
          if (node.kind === 'document') return { item: view(node), items: [] };
          const all = await context.db.findMany<DataRoomNode>('nodes', {
            where: { tenantId: context.tenantId, parentId: node.id, deletedAt: { isNull: true } },
            orderBy: [{ field: 'sortKey' }],
          });
          const masks = await reach(context, link, all);
          const children = all.filter(
            (child) => ((masks.get(child.id) ?? 0) & Capability.LIST) !== 0,
          );
          const documents = await context.db.findMany<DataRoomDocument>('documents', {
            where: {
              tenantId: context.tenantId,
              id: { in: children.filter((c) => c.kind === 'document').map((c) => c.id) },
            },
          });
          const sizes = new Map(documents.map((d) => [d.id, d.size]));
          return {
            item: view(node),
            items: children.map((child) =>
              view(child, sizes.has(child.id) ? { size: sizes.get(child.id) } : {}),
            ),
          };
        },
      }),
      /** Public: a download or viewer ticket for a document the link covers, marked with the visitor's email. */
      download: endpoint({
        operation: { action: 'better-files:links:open', target: 'public', mutates: false },
        input: v.object({
          session: v.string({ min: 10, max: 200 }),
          nodeId: v.id(),
          variant: v.enum(['view', 'watermarked', 'original'] as const),
        }),
        async handler(context, input) {
          const { session, link } = await openSession(context, input.session);
          const { node, mask: reached } = await inside(context, link, input.nodeId);
          if (node.kind !== 'document') throw notFound('Document');
          const need =
            input.variant === 'original'
              ? Capability.DOWNLOAD_ORIGINAL
              : input.variant === 'watermarked'
                ? Capability.DOWNLOAD_WATERMARKED
                : Capability.VIEW;
          let mask = reached;
          if (link.room.settings.downloadsEnabled === false)
            mask &= ~(Capability.DOWNLOAD_ORIGINAL | Capability.DOWNLOAD_WATERMARKED);
          const document = await context.db.findOne<DataRoomDocument>('documents', {
            id: node.id,
            tenantId: context.tenantId,
          });
          if (document?.flags.viewOnly)
            mask &= ~(Capability.DOWNLOAD_ORIGINAL | Capability.DOWNLOAD_WATERMARKED);
          if (!hasAll(mask, need)) throw forbidden();
          const visitor = {
            id: `link:${link.id}`,
            ...(session.email
              ? { email: session.email, name: session.email }
              : { name: 'Link visitor' }),
          };
          const ticket = await context.issueTicket({
            documentId: node.id,
            variant: input.variant,
            recipient: visitor,
          });
          await context.activity({
            roomId: link.roomId,
            action: input.variant === 'view' ? 'document.viewed' : 'document.downloaded',
            nodeId: node.id,
            metadata: { linkId: link.id, variant: input.variant, email: session.email ?? null },
          });
          return ticket;
        },
      }),
    },
  });
}
