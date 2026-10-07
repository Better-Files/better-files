import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { betterIam } from 'better-iam';
import { sqliteAdapter as iamSqlite } from 'better-iam/adapter-sqlite';
import type { IamStore } from 'better-iam/core';
import {
  betterIamMetering,
  meteringMeters,
  type BetterIamMeteringInstance,
} from '@better-files/plugin-quotas';
import { as, fixture, TENANT } from '../fixtures.js';

type Usage = Parameters<BetterIamMeteringInstance['billing']['recordMany']>[0][number];

function fakeIam(
  overrides: {
    budget?: () => Promise<boolean>;
    quota?: (meter: string) => Promise<boolean>;
    unknownIdentities?: Set<string>;
  } = {},
) {
  const usage: Usage[] = [];
  const consumed: string[] = [];
  const keys = new Set<string>();
  const iam: BetterIamMeteringInstance = {
    billing: {
      async recordMany(events) {
        if (events.some((e) => e.identityId && overrides.unknownIdentities?.has(e.identityId)))
          throw Object.assign(new Error('Unknown identity'), { code: 'NOT_FOUND' });
        for (const event of events) {
          if (event.idempotencyKey && keys.has(event.idempotencyKey)) continue;
          if (event.idempotencyKey) keys.add(event.idempotencyKey);
          usage.push(event);
        }
        return [];
      },
      async check() {
        return overrides.budget && !(await overrides.budget())
          ? { allowed: false, blockedBy: { name: 'Data room spend' } }
          : { allowed: true };
      },
    },
    quotas: {
      async consumeFor(input) {
        consumed.push(`${input.identityId}:${input.meter}`);
        const allowed = overrides.quota ? await overrides.quota(input.meter) : true;
        return allowed
          ? { allowed: true, plan: null }
          : { allowed: false, plan: 'guests', reason: 'day', retryAfterMs: 3_600_000 };
      },
    },
  };
  return { iam, usage, consumed };
}

const total = (usage: Usage[], meter: string) =>
  usage.filter((u) => u.meter === meter).reduce((sum, u) => sum + (u.quantity ?? 1), 0);

async function sharedRoom(f: Awaited<ReturnType<typeof fixture>>) {
  const room = await f.room();
  const buyers = await f.dr.api.groups.create(as('alice'), {
    tenantId: TENANT,
    roomId: room.id,
    name: 'Buyers',
    preset: 'downloadOriginal',
  });
  await f.dr.api.members.invite(as('alice'), {
    tenantId: TENANT,
    roomId: room.id,
    email: 'bob@acme.test',
    groupIds: [buyers.id],
  });
  return room;
}

describe('Better IAM metering', () => {
  it('records rooms, stored and served bytes, downloads and participants after each change', async () => {
    const fake = fakeIam();
    const f = await fixture({
      plugins: [betterIamMetering(fake.iam, { tags: () => ({ product: 'vdr' }) })],
    });
    const room = await sharedRoom(f);
    const { document } = await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'model.xlsx',
      content: f.bytes(1234),
    });
    await f.dr.api.documents.requestOriginal(as('bob'), { tenantId: TENANT, nodeId: document.id });
    await f.dr.api.folders.requestDownload(as('bob'), {
      tenantId: TENANT,
      nodeId: room.rootNodeId,
      variant: 'original',
    });

    await vi.waitFor(() => expect(total(fake.usage, 'better-files.downloads')).toBe(2));
    expect(total(fake.usage, 'better-files.rooms')).toBe(1);
    expect(total(fake.usage, 'better-files.upload-bytes')).toBe(1234);
    expect(total(fake.usage, 'better-files.download-bytes')).toBe(1234);
    expect(fake.usage.filter((u) => u.meter === 'better-files.participants')).toEqual([
      expect.objectContaining({ identityId: 'bob' }),
      expect.objectContaining({ identityId: 'bob' }),
    ]);
    const upload = fake.usage.find((u) => u.meter === 'better-files.upload-bytes')!;
    expect(upload).toMatchObject({
      tenantId: TENANT,
      identityId: 'alice',
      tags: { product: 'vdr', roomId: room.id },
      idempotencyKey: expect.stringMatching(/^better-files:.+:uploadBytes$/),
    });
  });

  it('retries recording with a durable job while Better IAM is unreachable', async () => {
    const fake = fakeIam();
    let outage = true;
    const recordMany = fake.iam.billing.recordMany;
    fake.iam.billing.recordMany = async (events) => {
      if (outage) throw new Error('Better IAM is down');
      return recordMany(events);
    };
    const f = await fixture({ plugins: [betterIamMetering(fake.iam)] });
    const room = await f.room();
    await f.upload('alice', { parentId: room.rootNodeId, filename: 'a.txt', content: f.bytes(10) });
    await vi.waitFor(async () =>
      expect(
        (await f.database.findMany<{ name: string; attempts: number }>('jobs', {})).filter(
          (job) => job.name === 'metering.record' && job.attempts > 0,
        ),
      ).toHaveLength(2),
    );
    expect(fake.usage).toEqual([]);
    outage = false;
    f.clock.current += 60 * 60_000;
    await f.dr.jobs.work();
    expect(total(fake.usage, 'better-files.rooms')).toBe(1);
    expect(total(fake.usage, 'better-files.upload-bytes')).toBe(10);
  });

  it('turns meters off, and bills the tenant when Better IAM does not know the actor', async () => {
    const fake = fakeIam({ unknownIdentities: new Set(['alice']) });
    const f = await fixture({
      plugins: [betterIamMetering(fake.iam, { meters: { rooms: false } })],
    });
    const room = await f.room();
    await f.upload('alice', { parentId: room.rootNodeId, filename: 'a.txt', content: f.bytes(10) });
    await vi.waitFor(() => expect(total(fake.usage, 'better-files.upload-bytes')).toBe(10));
    expect(total(fake.usage, 'better-files.rooms')).toBe(0);
    expect(fake.usage[0]).not.toHaveProperty('identityId');
    expect(fake.usage[0]!.idempotencyKey).toMatch(/:anonymous$/);
  });

  it('enforces Better IAM budgets and per-person quotas before uploads and downloads', async () => {
    let budgetLeft = true;
    let downloadsLeft = 2;
    const fake = fakeIam({
      budget: async () => budgetLeft,
      quota: async (meter) => meter !== 'dl' || downloadsLeft-- > 0,
    });
    const f = await fixture({
      plugins: [betterIamMetering(fake.iam, { enforceBudgets: true, quotas: { download: 'dl' } })],
    });
    const room = await sharedRoom(f);
    const { document } = await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'a.bin',
      content: f.bytes(10),
    });
    const download = () =>
      f.dr.api.documents.requestOriginal(as('bob'), { tenantId: TENANT, nodeId: document.id });
    await download();
    await download();
    await expect(download()).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      details: { scope: 'quota', meter: 'dl', plan: 'guests', retryAfterMs: 3_600_000 },
    });
    expect(fake.consumed.filter((c) => c === 'bob:dl')).toHaveLength(3);

    budgetLeft = false;
    await expect(
      f.upload('alice', { parentId: room.rootNodeId, filename: 'b.bin', content: f.bytes(10) }),
    ).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      details: { scope: 'budget', budget: 'Data room spend' },
    });
  });

  it('fails open or closed when Better IAM cannot answer', async () => {
    const down = async (): Promise<boolean> => {
      throw new Error('Better IAM is down');
    };
    for (const onCheckError of ['open', 'closed'] as const) {
      const fake = fakeIam({ budget: down });
      const f = await fixture({
        plugins: [betterIamMetering(fake.iam, { enforceBudgets: true, onCheckError })],
      });
      const room = await f.room();
      const upload = f.upload('alice', {
        parentId: room.rootNodeId,
        filename: 'a.txt',
        content: f.bytes(10),
      });
      if (onCheckError === 'open') await expect(upload).resolves.toBeDefined();
      else
        await expect(upload).rejects.toMatchObject({
          code: 'RATE_LIMITED',
          details: { reason: 'unavailable' },
        });
    }
  });

  it('describes its meters for billing.createMeter', () => {
    expect(meteringMeters({ views: false, rooms: 'acme.rooms' })).toEqual([
      {
        key: 'better-files.upload-bytes',
        name: 'Data room storage uploaded',
        unit: 'byte',
        aggregation: 'sum',
      },
      {
        key: 'better-files.download-bytes',
        name: 'Data room download egress',
        unit: 'byte',
        aggregation: 'sum',
      },
      {
        key: 'better-files.downloads',
        name: 'Data room files downloaded',
        unit: 'file',
        aggregation: 'sum',
      },
      { key: 'acme.rooms', name: 'Data rooms created', unit: 'room', aggregation: 'sum' },
      {
        key: 'better-files.participants',
        name: 'Active data room participants',
        unit: 'participant',
        aggregation: 'unique',
      },
    ]);
  });
});

/** RFC 6238 (SHA-1, 30 s, 6 digits) for the root administrator's MFA sign-in. */
function totp(secret: string, now = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret.replace(/=+$/, '').toUpperCase())
    bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const mac = createHmac('sha1', key).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0xf;
  return ((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

const stores: IamStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

describe('betterIamMetering against Better IAM', () => {
  it('records usage on platform meters and checks budgets and quotas', async () => {
    const store = iamSqlite({ filename: ':memory:' });
    stores.push(store);
    const inbox: { tenantId: string; template: string; payload: Record<string, string> }[] = [];
    const iam = betterIam({
      database: store,
      secret: 'test-secret-with-at-least-32-characters',
      baseURL: 'http://localhost:3000',
      authentication: { sendEmail: async (message) => void inbox.push(message) },
    });
    await iam.initialize();
    const root = await iam.bootstrap({
      email: 'root@example.test',
      name: 'Root',
      password: 'a strong root test password',
    });
    const challenge = await iam.api.auth.signIn({
      tenantId: root.tenant.id,
      email: 'root@example.test',
      password: 'a strong root test password',
    });
    if (!('mfaRequired' in challenge)) throw new Error('Root must require MFA');
    const enrollment = await iam.api.auth.beginMfa({
      tenantId: root.tenant.id,
      challenge: challenge.challenge,
    });
    const rootSession = await iam.api.auth.confirmMfa({
      credential: { tenantId: root.tenant.id, challenge: challenge.challenge },
      code: totp(enrollment.secret),
    });
    const asRoot = { token: rootSession.token };
    // The platform defines the meters once, on the root tenant; every organization below is billed on them.
    for (const definition of meteringMeters())
      await iam.api.billing.createMeter(asRoot, { tenantId: root.tenant.id, ...definition });
    const created = await iam.api.tenants.create(asRoot, {
      parentId: root.tenant.id,
      name: 'acme',
      type: 'organization',
      ownerEmail: 'owner@acme.test',
    });
    await iam.auth.dispatchOutbox();
    const invitation = inbox.find(
      (m) => m.tenantId === created.tenant.id && m.template === 'owner-invitation',
    )!;
    const owner = await iam.api.tenants.acceptInvitation({
      tenantId: created.tenant.id,
      token: invitation.payload.token!,
      name: 'Acme owner',
      password: 'a strong tenant owner password',
    });
    if (!('token' in owner)) throw new Error('Unexpected owner MFA');
    const tenantId = created.tenant.id;
    const bob = await iam.api.identities.create(
      { token: owner.token },
      { tenantId, email: 'bob@acme.test', name: 'Bob', password: 'a strong bob password' },
    );

    // Closed, so a call Better IAM rejects fails the test instead of being let through.
    const plugin = betterIamMetering(iam, {
      enforceBudgets: true,
      quotas: { download: 'better-files.downloads' },
      onCheckError: 'closed',
      delivery: 'inline',
    });
    const event = (type: string, data: Record<string, unknown>, actorId = bob.id) => ({
      id: `evt_${type}_${Math.random()}`,
      type,
      tenantId,
      roomId: 'room_1',
      actorId,
      occurredAt: Date.now(),
      data,
    });
    const context = {
      db: { findOne: async () => ({ size: 2048 }) },
    } as never;
    const downloaded = event('document.downloaded', { versionId: 'ver_1', variant: 'original' });
    await plugin.onEvent!(downloaded, context);
    // A redelivered event records nothing twice.
    await plugin.onEvent!(downloaded, context);
    await plugin.onEvent!(event('folder.downloaded', { files: 3 }), context);
    await plugin.onEvent!(event('room.created', { roomId: 'room_1' }, 'system'), context);

    const usage = await iam.api.billing.listUsage(asRoot, { tenantId, limit: 100 });
    const sum = (meter: string) =>
      usage.events.filter((e) => e.meter === meter).reduce((s, e) => s + e.quantity, 0);
    expect(sum('better-files.downloads')).toBe(4);
    expect(sum('better-files.download-bytes')).toBe(2048);
    expect(sum('better-files.rooms')).toBe(1);
    expect(usage.events.find((e) => e.meter === 'better-files.participants')).toBeDefined();

    // No budgets or quota plans are set, so both checks allow.
    const hooks = plugin.hooks!;
    const pluginContext = {
      tenantId,
      principal: { id: bob.id },
      logger: { warn() {}, error() {} },
      emit() {},
    } as never;
    await expect(
      hooks.beforeDownload!({
        context: pluginContext,
        room: { id: 'room_1' } as never,
        variant: 'original',
      }),
    ).resolves.toBeUndefined();
  });
});
