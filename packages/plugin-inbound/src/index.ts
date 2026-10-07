import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
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
  type DataRoomNode,
} from '@better-files/core';

export interface InboundOptions {
  /** The mail domain your provider receives for, such as `in.example.com`. */
  domain: string;
  /** Local-part prefix of drop addresses. Default `room`. */
  prefix?: string;
  /** Shared with your inbound webhook route; `deliver` refuses calls without it. 32+ characters. */
  deliverySecret: string;
  /** Accept only messages the provider says passed SPF/DKIM/DMARC. Default true. */
  requireAuthentication?: boolean;
  /** Largest attachment filed. Default 50 MiB. */
  maxAttachmentBytes?: number;
}

/** An email as your inbound provider delivered it, normalized. */
export interface InboundMessage {
  to: string[];
  from: string;
  subject?: string;
  /** The provider's authentication verdict (SPF/DKIM/DMARC pass). */
  authenticated: boolean;
  attachments: { filename: string; contentType?: string; content: Uint8Array }[];
}

interface AddressRecord {
  id: string;
  tenantId: string;
  roomId: string;
  nodeId: string;
  tokenHash: string;
  label?: string;
  allowedSenders: string[];
  expiresAt?: number;
  createdBy: string;
  revokedAt?: number;
  lastUsedAt?: number;
  createdAt: number;
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const localPart = /^([a-z0-9-]+)\+([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{20,64})@(.+)$/i;

/** Tenant and token from a drop address, or undefined when it is not one of ours. */
export function parseDropAddress(
  address: string,
  options: Pick<InboundOptions, 'domain' | 'prefix'>,
) {
  const bare = /<([^>]+)>/.exec(address)?.[1] ?? address.trim();
  const match = localPart.exec(bare);
  if (
    !match ||
    match[1]!.toLowerCase() !== (options.prefix ?? 'room') ||
    match[4]!.toLowerCase() !== options.domain.toLowerCase()
  )
    return undefined;
  return { tenantId: match[2]!, token: match[3]! };
}

/** Normalizes a Postmark inbound webhook payload. */
export function fromPostmark(payload: {
  ToFull?: { Email: string }[];
  To?: string;
  FromFull?: { Email: string };
  From?: string;
  Subject?: string;
  Headers?: { Name: string; Value: string }[];
  Attachments?: { Name: string; ContentType?: string; Content: string }[];
}): InboundMessage {
  const header = (name: string) =>
    payload.Headers?.find((h) => h.Name.toLowerCase() === name.toLowerCase())?.Value ?? '';
  const results = `${header('Authentication-Results')} ${header('Received-SPF')}`.toLowerCase();
  return {
    to: payload.ToFull?.map((entry) => entry.Email) ?? (payload.To ? payload.To.split(',') : []),
    from: payload.FromFull?.Email ?? payload.From ?? '',
    ...(payload.Subject ? { subject: payload.Subject } : {}),
    authenticated:
      /dkim=pass|dmarc=pass/.test(results) ||
      /^\s*pass\b/.test(header('Received-SPF').toLowerCase()),
    attachments: (payload.Attachments ?? []).map((attachment) => ({
      filename: attachment.Name,
      ...(attachment.ContentType ? { contentType: attachment.ContentType } : {}),
      content: new Uint8Array(Buffer.from(attachment.Content, 'base64')),
    })),
  };
}

const senderAllowed = (from: string, allowed: readonly string[]) => {
  if (allowed.length === 0) return true;
  const email = (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();
  return allowed.some((rule) =>
    rule.startsWith('@') ? email.endsWith(rule.toLowerCase()) : email === rule.toLowerCase(),
  );
};

/**
 * Email to a data room: a drop address per folder; attachments sent to it become documents there, filed as the
 * address's creator, versioned, scanned and logged like uploads. Your mail provider's inbound webhook calls
 * `deliverEmail(dr, options, message)` (Postmark: `fromPostmark(payload)`).
 */
export function inboundPlugin(options: InboundOptions) {
  if (options.deliverySecret.length < 32)
    throw new BetterFilesError('INVALID_CONFIG', 'deliverySecret needs 32+ characters');
  const prefix = options.prefix ?? 'room';
  const maxBytes = options.maxAttachmentBytes ?? 50 * 1024 * 1024;
  const requireAuth = options.requireAuthentication ?? true;

  return definePlugin({
    id: 'inbound',
    schema: {
      inboundAddresses: defineTable({
        fields: {
          roomId: field.string(),
          nodeId: field.string(),
          tokenHash: field.string(),
          label: field.string({ required: false }),
          allowedSenders: field.json<string[]>(),
          expiresAt: field.timestamp({ required: false }),
          createdBy: field.string(),
          revokedAt: field.timestamp({ required: false }),
          lastUsedAt: field.timestamp({ required: false }),
        },
        indexes: [
          { fields: ['tenantId', 'tokenHash'], unique: true },
          { fields: ['tenantId', 'roomId'] },
        ],
      }),
    },
    endpoints: {
      /** A drop address for a folder. Needs `UPLOAD` there; documents are filed as the creator. */
      createAddress: endpoint({
        operation: {
          action: 'better-files:documents:upload',
          target: 'node',
          capabilities: ['UPLOAD'],
          mutates: true,
        },
        input: v.object({
          nodeId: v.id(),
          label: v.optional(v.string({ max: 120 })),
          allowedSenders: v.optional(
            v.array(
              v.string({
                min: 3,
                max: 254,
                pattern: /^(@[^@\s]+\.[^@\s]+|[^@\s]+@[^@\s]+\.[^@\s]+)$/,
              }),
              { max: 100 },
            ),
          ),
          expiresInDays: v.optional(v.number({ int: true, min: 1, max: 3650 })),
        }),
        target: (input) => ({ nodeId: input.nodeId }),
        async handler(context, input) {
          const folder = context.node!;
          if (folder.kind !== 'folder')
            throw new BetterFilesError('INVALID_INPUT', 'Drop addresses file into folders');
          const token = randomBytes(18).toString('base64url');
          const record: AddressRecord = {
            id: prefixedId('inb', context.now),
            tenantId: context.tenantId,
            roomId: folder.roomId,
            nodeId: folder.id,
            tokenHash: hash(token),
            ...(input.label ? { label: input.label } : {}),
            allowedSenders: input.allowedSenders ?? [],
            ...(input.expiresInDays
              ? { expiresAt: context.now + input.expiresInDays * 86_400_000 }
              : {}),
            createdBy: context.principal.id,
            createdAt: context.now,
          };
          await context.db.insert('inboundAddresses', record);
          await context.activity({
            roomId: folder.roomId,
            action: 'inbound.address-created',
            nodeId: folder.id,
            metadata: { label: input.label ?? null },
          });
          const { tokenHash: _hash, tenantId: _tenant, ...view } = record;
          return { ...view, address: `${prefix}+${context.tenantId}.${token}@${options.domain}` };
        },
      }),
      list: endpoint({
        operation: {
          action: 'better-files:documents:list',
          target: 'room',
          mutates: false,
          allowClosed: true,
        },
        input: v.object({ roomId: v.id() }),
        target: (input) => ({ roomId: input.roomId }),
        async handler(context) {
          const rows = await context.db.findMany<AddressRecord>('inboundAddresses', {
            where: {
              tenantId: context.tenantId,
              roomId: context.room!.id,
              revokedAt: { isNull: true },
            },
          });
          // Only addresses on folders the caller can see.
          const nodes = rows.length
            ? await context.db.findMany<DataRoomNode>('nodes', {
                where: { tenantId: context.tenantId, id: { in: rows.map((row) => row.nodeId) } },
              })
            : [];
          const masks = await context.capabilitiesOf(nodes);
          return rows
            .filter((row) => ((masks.get(row.nodeId) ?? 0) & Capability.UPLOAD) !== 0)
            .map(({ tokenHash: _hash, tenantId: _tenant, ...row }) => row);
        },
      }),
      revoke: endpoint({
        operation: {
          action: 'better-files:documents:upload',
          target: 'node',
          capabilities: ['UPLOAD'],
          mutates: true,
        },
        input: v.object({ addressId: v.id() }),
        target: async (input, lookup) => {
          const row = await lookup.db.findOne<AddressRecord>('inboundAddresses', {
            id: input.addressId,
            tenantId: lookup.tenantId,
          });
          if (!row) throw notFound('Address');
          return { nodeId: row.nodeId };
        },
        async handler(context, input) {
          await context.db.update(
            'inboundAddresses',
            { id: input.addressId, tenantId: context.tenantId },
            { revokedAt: context.now },
          );
          return { revoked: true as const };
        },
      }),
      /** Called by your inbound webhook route (server side), never by browsers. */
      deliver: endpoint({
        operation: { action: 'better-files:inbound:deliver', target: 'public', mutates: true },
        input: v.object({
          secret: v.string({ min: 32, max: 256 }),
          token: v.string({ min: 20, max: 64 }),
          from: v.string({ min: 3, max: 512 }),
          subject: v.optional(v.string({ max: 998 })),
          authenticated: v.boolean(),
          attachments: v.array(
            v.object({
              filename: v.string({ min: 1, max: 255 }),
              contentType: v.optional(v.string({ max: 255 })),
              /** base64 */
              content: v.string({ max: Math.ceil((maxBytes * 4) / 3) + 4 }),
            }),
            { max: 50 },
          ),
        }),
        async handler(context, input) {
          const given = Buffer.from(input.secret);
          const expected = Buffer.from(options.deliverySecret);
          if (given.length !== expected.length || !timingSafeEqual(given, expected))
            throw new BetterFilesError('UNAUTHENTICATED', 'Bad delivery secret');
          const address = await context.db.findOne<AddressRecord>('inboundAddresses', {
            tenantId: context.tenantId,
            tokenHash: hash(input.token),
          });
          const refuse = (reason: string) => {
            context.emit(
              'inbound.refused',
              { reason, from: input.from.slice(0, 254) },
              { immediate: true },
            );
            throw new BetterFilesError('FORBIDDEN', reason);
          };
          if (
            !address ||
            address.revokedAt ||
            (address.expiresAt !== undefined && address.expiresAt <= context.now)
          )
            return refuse('Unknown or expired drop address');
          if (requireAuth && !input.authenticated)
            return refuse('The message failed sender authentication');
          if (!senderAllowed(input.from, address.allowedSenders))
            return refuse('The sender is not allowed for this address');
          const folder = await context.db.findOne<DataRoomNode>('nodes', {
            id: address.nodeId,
            tenantId: context.tenantId,
            deletedAt: { isNull: true },
          });
          if (!folder) return refuse('The folder no longer exists');
          const filed: { nodeId: string; filename: string }[] = [];
          const skipped: { filename: string; reason: string }[] = [];
          for (const attachment of input.attachments) {
            const content = new Uint8Array(Buffer.from(attachment.content, 'base64'));
            const filename =
              attachment.filename
                .replace(/[\u0000-\u001f\\/]/g, '_')
                .trim()
                .slice(0, 255) || 'attachment';
            if (content.byteLength > maxBytes) {
              skipped.push({ filename, reason: 'too large' });
              continue;
            }
            const stored = await context.addDocument({
              parentId: folder.id,
              filename,
              content,
              ...(attachment.contentType
                ? { mimeType: attachment.contentType.split(';')[0]!.trim().toLowerCase() }
                : {}),
              comment: `By email from ${input.from.slice(0, 200)}${input.subject ? `: ${input.subject.slice(0, 200)}` : ''}`,
              actorId: address.createdBy,
            });
            filed.push({ nodeId: stored.nodeId, filename });
          }
          await context.db.update(
            'inboundAddresses',
            { id: address.id, tenantId: context.tenantId },
            { lastUsedAt: context.now },
          );
          await context.activity({
            roomId: address.roomId,
            action: 'inbound.received',
            nodeId: folder.id,
            metadata: {
              from: input.from.slice(0, 254),
              files: filed.length,
              skipped: skipped.length,
            },
          });
          return { filed, skipped };
        },
      }),
    },
  });
}

interface DeliverTarget {
  api: object;
}

/**
 * Files an inbound message into every drop address it was sent to. Call it from your provider's webhook route after
 * verifying the webhook itself; addresses that are not ours are ignored.
 */
export async function deliverEmail(
  dr: DeliverTarget,
  options: Pick<InboundOptions, 'domain' | 'prefix' | 'deliverySecret'>,
  message: InboundMessage,
) {
  const deliver = (
    dr.api as {
      inbound?: {
        deliver(
          credential: object,
          input: object,
        ): Promise<{ filed: unknown[]; skipped: unknown[] }>;
      };
    }
  ).inbound?.deliver;
  if (!deliver)
    throw new BetterFilesError('INVALID_CONFIG', 'Register inboundPlugin() on the instance');
  const outcomes = [];
  for (const to of message.to) {
    const parsed = parseDropAddress(to, options);
    if (!parsed) continue;
    outcomes.push({
      to,
      ...(await deliver(
        {},
        {
          tenantId: parsed.tenantId,
          secret: options.deliverySecret,
          token: parsed.token,
          from: message.from,
          ...(message.subject ? { subject: message.subject } : {}),
          authenticated: message.authenticated,
          attachments: message.attachments.map((attachment) => ({
            filename: attachment.filename,
            ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
            content: Buffer.from(attachment.content).toString('base64'),
          })),
        },
      )),
    });
  }
  return outcomes;
}
