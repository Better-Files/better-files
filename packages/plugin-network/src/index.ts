import {
  BetterFilesError,
  defineTable,
  definePlugin,
  endpoint,
  field,
  prefixedId,
  v,
  type Member,
  type PluginContext,
  type Room,
} from '@better-files/core';

export interface NetworkRule {
  id: string;
  tenantId: string;
  roomId: string;
  /** IPv4 or IPv6 addresses and CIDR ranges (`203.0.113.0/24`, `2001:db8::/32`). */
  allowedRanges: string[];
  /** `everyone`, or only guests from outside the organization (`external`). */
  appliesTo: 'everyone' | 'external';
  updatedBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface NetworkPluginOptions {
  /**
   * What to do when the request's address is unknown, for example a server-side `dr.api` call made without request
   * info. Default `deny`: a restricted participant gets nothing. Hosts that call the API on behalf of a user they
   * have already checked can pass `allow`.
   */
  unknownAddress?: 'deny' | 'allow';
}

/** An address as bytes: 4 for IPv4, 16 for IPv6. */
type Address = Uint8Array;

function parseIpv4(text: string): Address | undefined {
  const parts = text.split('.');
  if (parts.length !== 4) return undefined;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = parts[i]!;
    if (!/^\d{1,3}$/.test(part) || (part.length > 1 && part.startsWith('0'))) return undefined;
    const value = Number(part);
    if (value > 255) return undefined;
    out[i] = value;
  }
  return out;
}

function parseIpv6(text: string): Address | undefined {
  if (!/^[0-9a-fA-F:.]+$/.test(text) || text.split('::').length > 2) return undefined;
  const [head, tail] = text.includes('::') ? text.split('::') : [text, undefined];
  const groups = (value: string | undefined): number[] | undefined => {
    if (!value) return [];
    const out: number[] = [];
    const pieces = value.split(':');
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i]!;
      // An embedded IPv4 address may end the text (`::ffff:192.0.2.1`).
      if (i === pieces.length - 1 && piece.includes('.')) {
        const v4 = parseIpv4(piece);
        if (!v4) return undefined;
        out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      } else if (/^[0-9a-fA-F]{1,4}$/.test(piece)) out.push(parseInt(piece, 16));
      else return undefined;
    }
    return out;
  };
  const before = groups(head);
  const after = groups(tail);
  if (!before || !after) return undefined;
  if (tail === undefined ? before.length !== 8 : before.length + after.length > 7) return undefined;
  const all = [...before, ...new Array<number>(8 - before.length - after.length).fill(0), ...after];
  const out = new Uint8Array(16);
  all.forEach((group, i) => {
    out[i * 2] = group >> 8;
    out[i * 2 + 1] = group & 0xff;
  });
  return out;
}

const MAPPED_PREFIX = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff];

/**
 * Parses an IP address as servers report it: IPv4, IPv6 (brackets and zone ids allowed), and IPv4-mapped IPv6
 * (`::ffff:192.0.2.1`, which Node reports for IPv4 clients on a dual-stack socket) as the IPv4 address.
 */
export function parseIp(text: string): Address | undefined {
  let value = text.trim();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);
  if (value.includes(':')) {
    const v6 = parseIpv6(value);
    if (v6 && MAPPED_PREFIX.every((byte, i) => v6[i] === byte)) return v6.slice(12);
    return v6;
  }
  return parseIpv4(value);
}

export interface IpRange {
  address: Address;
  prefix: number;
}

/** Parses `address` or `address/prefix`. Host bits beyond the prefix are ignored. */
export function parseIpRange(text: string): IpRange | undefined {
  const [addressText, prefixText, extra] = text.trim().split('/');
  if (extra !== undefined || !addressText) return undefined;
  const address = parseIp(addressText);
  if (!address) return undefined;
  const bits = address.length * 8;
  if (prefixText === undefined) return { address, prefix: bits };
  if (!/^\d{1,3}$/.test(prefixText)) return undefined;
  const prefix = Number(prefixText);
  // An IPv4-mapped range (`::ffff:10.0.0.0/104`) is the IPv4 range with 96 fewer bits.
  const mapped = addressText.includes(':') && address.length === 4;
  const effective = mapped ? prefix - 96 : prefix;
  if (effective < 0 || effective > bits) return undefined;
  return { address, prefix: effective };
}

/** Whether `ip` falls in any of `ranges`. Unparseable addresses or ranges never match. */
export function ipInRanges(ip: string, ranges: readonly string[]): boolean {
  const address = parseIp(ip);
  if (!address) return false;
  return ranges.some((text) => {
    const range = parseIpRange(text);
    if (!range || range.address.length !== address.length) return false;
    const whole = Math.floor(range.prefix / 8);
    for (let i = 0; i < whole; i++) if (address[i] !== range.address[i]) return false;
    const rest = range.prefix % 8;
    if (rest === 0) return true;
    const mask = (0xff << (8 - rest)) & 0xff;
    return (address[whole]! & mask) === (range.address[whole]! & mask);
  });
}

const EXEMPT_RELATIONS = new Set(['owner', 'admin']);
/** Outside the allowed networks a restricted participant gets nothing, not even names. */
const EVERYTHING = ~0;

async function ruleFor(context: Pick<PluginContext, 'db' | 'tenantId'>, roomId: string) {
  return context.db.findOne<NetworkRule>('networkRules', { tenantId: context.tenantId, roomId });
}

interface Verdict {
  restricted: boolean;
  allowed: boolean;
  reason?: string;
}

// One lookup per request context: the clamp hook runs once per node of a listing.
const verdictCache = new WeakMap<object, Map<string, Promise<Verdict>>>();

function verdictFor(
  context: PluginContext,
  room: Room,
  options: NetworkPluginOptions,
): Promise<Verdict> {
  let byRoom = verdictCache.get(context);
  if (!byRoom) verdictCache.set(context, (byRoom = new Map()));
  let verdict = byRoom.get(room.id);
  if (!verdict) {
    verdict = decide(context, room, options);
    byRoom.set(room.id, verdict);
  }
  return verdict;
}

async function decide(
  context: PluginContext,
  room: Room,
  options: NetworkPluginOptions,
): Promise<Verdict> {
  const rule = await ruleFor(context, room.id);
  if (!rule || rule.allowedRanges.length === 0) return { restricted: false, allowed: true };
  if (rule.appliesTo === 'external' && !context.principal.guest)
    return { restricted: false, allowed: true };
  const member = await context.db.findOne<Member>('members', {
    tenantId: context.tenantId,
    roomId: room.id,
    identityId: context.principal.id,
  });
  if (member?.relation && EXEMPT_RELATIONS.has(member.relation))
    return { restricted: false, allowed: true };
  const ip = context.request?.ip;
  if (!ip)
    return options.unknownAddress === 'allow'
      ? { restricted: true, allowed: true }
      : { restricted: true, allowed: false, reason: 'the connection address is unknown' };
  return ipInRanges(ip, rule.allowedRanges)
    ? { restricted: true, allowed: true }
    : {
        restricted: true,
        allowed: false,
        reason: `connections from ${ip} are not allowed in this room`,
      };
}

const roomTarget = (input: { roomId: string }) => ({ roomId: input.roomId });

/**
 * Per-room network rules (PLAN §10.4 `allowedIpRanges`). When a room has allowed ranges, a participant connecting
 * from anywhere else gets no capabilities in it: no names, no viewing, no downloads. Rules apply to everyone or only
 * to guests. Room owners and administrators are exempt, so they cannot lock themselves out. Download tickets carry
 * the address they were issued to. Behind a proxy, set `betterFiles({ trustProxy: true })` so the client address is
 * read from `x-forwarded-for`.
 */
export function networkPlugin(options: NetworkPluginOptions = {}) {
  return definePlugin({
    id: 'network',
    actions: ['better-files:network:manage', 'better-files:network:read'],
    accessModel: [
      { relations: ['owner', 'admin'], actions: ['better-files:network:manage'] },
      {
        relations: ['owner', 'admin', 'publisher', 'editor', 'contributor', 'viewer', 'auditor'],
        actions: ['better-files:network:read'],
      },
    ],
    schema: {
      networkRules: defineTable({
        fields: {
          roomId: field.string(),
          allowedRanges: field.json<string[]>(),
          appliesTo: field.enum(['everyone', 'external'] as const),
          updatedBy: field.string(),
          updatedAt: field.timestamp(),
        },
        indexes: [{ fields: ['tenantId', 'roomId'], unique: true }],
      }),
    },
    hooks: {
      async clampCapabilities({ context, room }) {
        const verdict = await verdictFor(context, room, options);
        return verdict.allowed ? [] : [{ remove: EVERYTHING, reason: verdict.reason! }];
      },
    },
    endpoints: {
      /** Sets the room's allowed ranges; an empty list removes the restriction. */
      set: endpoint({
        operation: { action: 'better-files:network:manage', target: 'room', mutates: true },
        input: v.object({
          roomId: v.id(),
          allowedRanges: v.array(v.string({ min: 1, max: 64 }), { max: 100 }),
          appliesTo: v.optional(v.enum(['everyone', 'external'] as const)),
        }),
        target: roomTarget,
        async handler(context, input) {
          const room = context.room!;
          const ranges = [...new Set(input.allowedRanges.map((range) => range.trim()))];
          const invalid = ranges.filter((range) => !parseIpRange(range));
          if (invalid.length)
            throw new BetterFilesError('INVALID_INPUT', `Invalid IP ranges: ${invalid.join(', ')}`);
          const existing = await ruleFor(context, room.id);
          const values = {
            allowedRanges: ranges,
            appliesTo: input.appliesTo ?? existing?.appliesTo ?? 'everyone',
            updatedBy: context.principal.id,
            updatedAt: context.now,
          };
          const rule: NetworkRule = existing
            ? { ...existing, ...values }
            : {
                id: prefixedId('netrule', context.now),
                tenantId: context.tenantId,
                roomId: room.id,
                createdAt: context.now,
                ...values,
              };
          if (existing)
            await context.db.update(
              'networkRules',
              { id: existing.id, tenantId: context.tenantId },
              values,
            );
          else await context.db.insert('networkRules', rule);
          await context.activity({
            roomId: room.id,
            action: 'network.changed',
            metadata: { allowedRanges: ranges, appliesTo: rule.appliesTo },
          });
          context.emit('network.changed', {
            roomId: room.id,
            allowedRanges: ranges,
            appliesTo: rule.appliesTo,
          });
          return rule;
        },
      }),
      get: endpoint({
        operation: {
          action: 'better-files:network:manage',
          target: 'room',
          mutates: false,
          allowClosed: true,
        },
        input: v.object({ roomId: v.id() }),
        target: roomTarget,
        async handler(context) {
          return (await ruleFor(context, context.room!.id)) ?? null;
        },
      }),
      /** Whether the caller's connection may use the room, so a client can explain an empty room. */
      status: endpoint({
        operation: {
          action: 'better-files:network:read',
          target: 'room',
          mutates: false,
          allowClosed: true,
          // Whether the caller's network is allowed: about their access, not room content.
          ungated: true,
        },
        input: v.object({ roomId: v.id() }),
        target: roomTarget,
        async handler(context) {
          const verdict = await verdictFor(context, context.room!, options);
          return {
            restricted: verdict.restricted,
            allowed: verdict.allowed,
            ip: context.request?.ip ?? null,
          };
        },
      }),
    },
  });
}
