import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { matchesEvent } from './match.js';
import {
  blockedAddressReason,
  BlockedAddressError,
  postGuarded,
  type Resolver,
} from './network.js';
import {
  defineTable,
  definePlugin,
  endpoint,
  field,
  invalidInput,
  notFound,
  prefixedId,
  v,
  type DatabaseAdapter,
  type BetterFilesEvent,
  type Logger,
} from '@better-files/core';

export interface Webhook {
  id: string;
  tenantId: string;
  url: string;
  events: string[];
  /** Only events of this room, when set. */
  roomId?: string;
  secret: string;
  /** The secret before the last rotation; deliveries are signed with both until it expires. */
  previousSecret?: string;
  previousSecretExpiresAt?: number;
  active: boolean;
  description?: string;
  createdBy: string;
  failures: number;
  lastDeliveryAt?: number;
  createdAt: number;
}

export interface WebhookDelivery {
  id: string;
  tenantId: string;
  webhookId: string;
  eventId: string;
  type: string;
  payload: BetterFilesEvent;
  attempts: number;
  nextAttemptAt: number;
  deliveredAt?: number;
  lastStatus?: number;
  lastError?: string;
  createdAt: number;
}

export interface WebhooksOptions {
  /** Deliveries are retried with exponential backoff up to this many attempts. Default 8. */
  maxAttempts?: number;
  /** Per-request timeout. Default 10 seconds. */
  timeoutMs?: number;
  /** Allow http:// and private or loopback addresses (development only). Default false. */
  allowPrivateNetworks?: boolean;
  /** Deliver in the background right after the event (default), or only from `dr.maintain()`. */
  deliverImmediately?: boolean;
  /**
   * How long the old secret keeps signing deliveries after `rotateSecret`, so receivers can switch without dropping
   * any. Default 24 hours; 0 retires it at once.
   */
  secretRotationGraceMs?: number;
  /**
   * Send through this fetch instead of Node's HTTP client. The URL's addresses are checked before sending, but a
   * custom fetch resolves the host again itself, so only the built-in client is safe against DNS rebinding.
   */
  fetch?: typeof fetch;
  /** Resolves webhook hosts (custom DNS, tests). Default: the system resolver. */
  resolver?: Resolver;
}

const signature = (secret: string, timestamp: number, body: string) =>
  createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

/**
 * Verifies a delivery in the receiving application: `X-Better-Files-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256
 * of "t.body">`. Rejects signatures older than `toleranceSeconds` (default 300) to stop replays. While a rotated
 * secret is in its grace period the header carries one `v1` per secret; any of them may match.
 */
export function verifyWebhookSignature(input: {
  secret: string;
  body: string;
  header: string | null | undefined;
  toleranceSeconds?: number;
  now?: number;
}): boolean {
  let timestamp = Number.NaN;
  const candidates: string[] = [];
  for (const part of (input.header ?? '').split(',')) {
    const at = part.indexOf('=');
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (name === 't' && /^\d+$/.test(value)) timestamp = Number(value);
    else if (name === 'v1' && value) candidates.push(value);
  }
  if (!Number.isFinite(timestamp) || candidates.length === 0) return false;
  const now = Math.floor((input.now ?? Date.now()) / 1000);
  if (Math.abs(now - timestamp) > (input.toleranceSeconds ?? 300)) return false;
  const expected = Buffer.from(signature(input.secret, timestamp, input.body));
  let matched = false;
  for (const candidate of candidates) {
    const given = Buffer.from(candidate);
    if (given.byteLength === expected.byteLength && timingSafeEqual(expected, given))
      matched = true;
  }
  return matched;
}

/** Refuses URLs that would let a tenant reach the server's own network (SSRF). */
async function assertDeliverable(
  url: string,
  allowPrivate: boolean,
  resolver: Resolver = systemResolver,
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw invalidInput('Invalid webhook URL');
  }
  if (parsed.username || parsed.password)
    throw invalidInput('Webhook URLs cannot carry credentials');
  if (allowPrivate) {
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
      throw invalidInput('Webhook URLs use http(s)');
    return parsed;
  }
  if (parsed.protocol !== 'https:') throw invalidInput('Webhook URLs must use https');
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await resolver(host);
  } catch {
    throw invalidInput(`Webhook host ${host} does not resolve`);
  }
  if (addresses.length === 0) throw invalidInput(`Webhook host ${host} does not resolve`);
  for (const address of addresses) {
    const reason = blockedAddressReason(address);
    if (reason) throw invalidInput(new BlockedAddressError(reason).message);
  }
  return parsed;
}

const systemResolver: Resolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

const patternSchema = v.string({
  min: 1,
  max: 64,
  pattern: /^(\*|[a-z][a-z0-9-]*(\.[a-z*][a-z0-9-*]*)*)$/,
});

/**
 * Signed webhooks per tenant: subscribe an HTTPS endpoint to event patterns (`document.*`, `qa.published`), optionally
 * for one room. Deliveries go through an outbox (retried with backoff by `dr.maintain()`), carry an HMAC signature
 * with a timestamp, and never reach private networks.
 */
export function webhooksPlugin(options: WebhooksOptions = {}) {
  const maxAttempts = options.maxAttempts ?? 8;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const allowPrivate = options.allowPrivateNetworks === true;
  const graceMs = options.secretRotationGraceMs ?? 24 * 60 * 60_000;
  const newSecret = () => `whsec_${randomBytes(24).toString('base64url')}`;

  /** `t=…,v1=…`, with a second `v1` from the previous secret during its grace period. */
  function signatureHeader(webhook: Webhook, timestamp: number, body: string, now: number) {
    const secrets = [webhook.secret];
    if (webhook.previousSecret && (webhook.previousSecretExpiresAt ?? 0) > now)
      secrets.push(webhook.previousSecret);
    return [
      `t=${timestamp}`,
      ...secrets.map((secret) => `v1=${signature(secret, timestamp, body)}`),
    ].join(',');
  }

  /** One POST. The built-in client checks the address it connects to; a custom fetch gets a pre-check only. */
  async function send(url: string, headers: Record<string, string>, body: string) {
    const target = await assertDeliverable(url, allowPrivate, options.resolver);
    if (!options.fetch)
      return postGuarded(target, {
        headers,
        body,
        timeoutMs,
        allowPrivate,
        ...(options.resolver ? { resolver: options.resolver } : {}),
      });
    const response = await options.fetch(url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers,
      body,
    });
    await response.body?.cancel().catch(() => undefined);
    return { status: response.status };
  }

  async function deliver(
    db: DatabaseAdapter,
    logger: Logger,
    delivery: WebhookDelivery,
    now: number,
  ) {
    const webhook = await db.findOne<Webhook>('webhooks', {
      id: delivery.webhookId,
      tenantId: delivery.tenantId,
    });
    if (!webhook || !webhook.active) {
      await db.transaction((tx) =>
        tx.delete('webhookDeliveries', { id: delivery.id, tenantId: delivery.tenantId }),
      );
      return;
    }
    // Claim the delivery first: an immediate delivery, `maintain()` and other instances may all have picked it up.
    // The claim moves `nextAttemptAt` past the request's timeout, so a crash mid-request leaves it for a retry.
    const claimed = await db.transaction((tx) =>
      tx.update(
        'webhookDeliveries',
        {
          id: delivery.id,
          tenantId: delivery.tenantId,
          attempts: delivery.attempts,
          nextAttemptAt: delivery.nextAttemptAt,
          deliveredAt: { isNull: true },
        },
        { nextAttemptAt: now + timeoutMs + 60_000 },
      ),
    );
    if (claimed === 0) return;
    const body = JSON.stringify(delivery.payload);
    const timestamp = Math.floor(now / 1000);
    let status: number | undefined;
    let error: string | undefined;
    try {
      ({ status } = await send(
        webhook.url,
        {
          'content-type': 'application/json',
          'user-agent': 'Better-Files-Webhooks/1',
          'x-better-files-event': delivery.type,
          'x-better-files-delivery': delivery.id,
          'x-better-files-signature': signatureHeader(webhook, timestamp, body, now),
        },
        body,
      ));
      if (status < 200 || status >= 300) error = `HTTP ${status}`;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    const attempts = delivery.attempts + 1;
    await db.transaction(async (tx) => {
      if (!error) {
        await tx.update(
          'webhookDeliveries',
          { id: delivery.id, tenantId: delivery.tenantId },
          {
            attempts,
            deliveredAt: now,
            lastStatus: status ?? null,
            lastError: null,
          },
        );
        await tx.update(
          'webhooks',
          { id: webhook.id, tenantId: webhook.tenantId },
          { failures: 0, lastDeliveryAt: now },
        );
      } else {
        // 1 min, 2, 4 … capped at 6 hours.
        const delay = Math.min(60_000 * 2 ** (attempts - 1), 6 * 60 * 60_000);
        await tx.update(
          'webhookDeliveries',
          { id: delivery.id, tenantId: delivery.tenantId },
          {
            attempts,
            nextAttemptAt: now + delay,
            lastStatus: status ?? null,
            lastError: error.slice(0, 500),
          },
        );
        await tx.increment('webhooks', { id: webhook.id, tenantId: webhook.tenantId }, 'failures');
      }
    });
    if (error) logger.warn('Webhook delivery failed', { webhookId: webhook.id, attempts, error });
  }

  const view = ({
    secret: _secret,
    previousSecret: _previous,
    previousSecretExpiresAt: _expires,
    ...webhook
  }: Webhook) => webhook;
  const tenantAction = 'better-files:webhooks:manage';

  return definePlugin({
    id: 'webhooks',
    actions: [tenantAction],
    schema: {
      webhooks: defineTable({
        fields: {
          url: field.string(),
          events: field.json<string[]>(),
          roomId: field.string({ required: false }),
          secret: field.string(),
          previousSecret: field.string({ required: false }),
          previousSecretExpiresAt: field.timestamp({ required: false }),
          active: field.boolean(),
          description: field.string({ required: false }),
          createdBy: field.string(),
          failures: field.number(),
          lastDeliveryAt: field.timestamp({ required: false }),
        },
      }),
      webhookDeliveries: defineTable({
        fields: {
          webhookId: field.string(),
          eventId: field.string(),
          type: field.string(),
          payload: field.json<BetterFilesEvent>(),
          attempts: field.number(),
          nextAttemptAt: field.timestamp(),
          deliveredAt: field.timestamp({ required: false }),
          lastStatus: field.number({ required: false }),
          lastError: field.string({ required: false }),
        },
        indexes: [
          { fields: ['tenantId', 'webhookId', 'eventId'], unique: true },
          { fields: ['deliveredAt', 'nextAttemptAt'] },
        ],
      }),
    },
    async onEvent(event, context) {
      const webhooks = await context.db.findMany<Webhook>('webhooks', {
        where: { tenantId: event.tenantId, active: true },
      });
      const targets = webhooks.filter(
        (webhook) =>
          matchesEvent(webhook.events, event.type) &&
          (!webhook.roomId || webhook.roomId === event.roomId),
      );
      if (targets.length === 0) return;
      const deliveries: WebhookDelivery[] = targets.map((webhook) => ({
        id: prefixedId('whd', context.now),
        tenantId: event.tenantId,
        webhookId: webhook.id,
        eventId: event.id,
        type: event.type,
        payload: event,
        attempts: 0,
        nextAttemptAt: context.now,
        createdAt: context.now,
      }));
      await context.db.transaction(async (tx) => {
        for (const delivery of deliveries) await tx.insert('webhookDeliveries', delivery);
      });
      if (options.deliverImmediately !== false)
        for (const delivery of deliveries)
          void deliver(context.db, context.logger, delivery, Date.now()).catch(() => undefined);
    },
    async maintain(context) {
      const due = await context.db.findMany<WebhookDelivery>('webhookDeliveries', {
        where: {
          deliveredAt: { isNull: true },
          nextAttemptAt: { lte: context.now },
          attempts: { lt: maxAttempts },
        },
        orderBy: [{ field: 'nextAttemptAt' }],
        limit: 200,
      });
      for (const delivery of due) await deliver(context.db, context.logger, delivery, context.now);
      // Delivered records are kept for a week for troubleshooting.
      await context.db.transaction((tx) =>
        tx.delete('webhookDeliveries', { deliveredAt: { lt: context.now - 7 * 86_400_000 } }),
      );
    },
    endpoints: {
      create: endpoint({
        operation: { action: tenantAction, target: 'tenant', mutates: true },
        input: v.object({
          url: v.string({ min: 8, max: 2048 }),
          events: v.array(patternSchema, { min: 1, max: 50 }),
          roomId: v.optional(v.id()),
          description: v.optional(v.string({ max: 500 })),
        }),
        async handler(context, input) {
          await assertDeliverable(input.url, allowPrivate, options.resolver);
          if (
            input.roomId &&
            !(await context.db.findOne('rooms', { id: input.roomId, tenantId: context.tenantId }))
          )
            throw notFound('Room');
          const webhook: Webhook = {
            id: prefixedId('whk', context.now),
            tenantId: context.tenantId,
            url: input.url,
            events: input.events,
            ...(input.roomId ? { roomId: input.roomId } : {}),
            secret: newSecret(),
            active: true,
            ...(input.description ? { description: input.description } : {}),
            createdBy: context.principal.id,
            failures: 0,
            createdAt: context.now,
          };
          await context.db.insert('webhooks', webhook);
          // The signing secret is shown once.
          return { ...view(webhook), secret: webhook.secret };
        },
      }),
      list: endpoint({
        operation: { action: tenantAction, target: 'tenant', mutates: false },
        input: v.object({}),
        async handler(context) {
          const webhooks = await context.db.findMany<Webhook>('webhooks', {
            where: { tenantId: context.tenantId },
          });
          return webhooks.map(view);
        },
      }),
      update: endpoint({
        operation: { action: tenantAction, target: 'tenant', mutates: true },
        input: v.object({
          webhookId: v.id(),
          active: v.optional(v.boolean()),
          events: v.optional(v.array(patternSchema, { min: 1, max: 50 })),
          rotateSecret: v.optional(v.boolean()),
        }),
        async handler(context, input) {
          const webhook = await context.db.findOne<Webhook>('webhooks', {
            id: input.webhookId,
            tenantId: context.tenantId,
          });
          if (!webhook) throw notFound('Webhook');
          const patch: Partial<Webhook> = {
            ...(input.active !== undefined
              ? { active: input.active, ...(input.active ? { failures: 0 } : {}) }
              : {}),
            ...(input.events ? { events: input.events } : {}),
            // The old secret keeps signing alongside the new one for the grace period.
            ...(input.rotateSecret
              ? {
                  secret: newSecret(),
                  ...(graceMs > 0
                    ? {
                        previousSecret: webhook.secret,
                        previousSecretExpiresAt: context.now + graceMs,
                      }
                    : { previousSecret: null, previousSecretExpiresAt: null }),
                }
              : {}),
          } as Partial<Webhook>;
          await context.db.update(
            'webhooks',
            { id: webhook.id, tenantId: context.tenantId },
            patch,
          );
          const updated = { ...webhook, ...patch };
          return input.rotateSecret ? { ...view(updated), secret: updated.secret } : view(updated);
        },
      }),
      delete: endpoint({
        operation: { action: tenantAction, target: 'tenant', mutates: true },
        input: v.object({ webhookId: v.id() }),
        async handler(context, input) {
          const removed = await context.db.delete('webhooks', {
            id: input.webhookId,
            tenantId: context.tenantId,
          });
          if (!removed) throw notFound('Webhook');
          await context.db.delete('webhookDeliveries', {
            tenantId: context.tenantId,
            webhookId: input.webhookId,
          });
          return { deleted: true as const };
        },
      }),
      deliveries: endpoint({
        operation: { action: tenantAction, target: 'tenant', mutates: false },
        input: v.object({
          webhookId: v.id(),
          limit: v.optional(v.number({ int: true, min: 1, max: 200 })),
        }),
        async handler(context, input) {
          return context.db.findMany<WebhookDelivery>('webhookDeliveries', {
            where: { tenantId: context.tenantId, webhookId: input.webhookId },
            orderBy: [{ field: 'createdAt', direction: 'desc' }],
            limit: input.limit ?? 50,
          });
        },
      }),
    },
  });
}

export { matchesEvent, blockedAddressReason, type Resolver };
