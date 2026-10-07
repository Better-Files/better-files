import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { betterIam } from 'better-iam';
import { sqliteAdapter as iamSqlite } from 'better-iam/adapter-sqlite';
import type { IamStore } from 'better-iam/core';
import {
  betterIamThreats,
  guardPlugin,
  threatsPolicy,
  type BetterIamThreatsInstance,
  type DownloadAnomaly,
  type RiskLevel,
} from '@better-files/plugin-guard';
import { as, fixture, TENANT } from '../fixtures.js';

async function roomWithDownload(f: Awaited<ReturnType<typeof fixture>>) {
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
  const { document } = await f.upload('alice', {
    parentId: room.rootNodeId,
    filename: 'a.bin',
    content: f.bytes(10),
  });
  return { room, document };
}

/** Records calls like Better IAM's threat API, with a settable risk per identity. */
function fakeThreats() {
  const calls: { method: string; input: Record<string, unknown> }[] = [];
  const risk = new Map<string, RiskLevel>();
  const iam: BetterIamThreatsInstance = {
    api: {
      threats: {
        async setRisk(_credential, input) {
          calls.push({ method: 'setRisk', input });
          risk.set(input.identityId, input.level);
          return {};
        },
        async respond(_credential, input) {
          calls.push({ method: 'respond', input });
          return [];
        },
        async getRisk(_credential, input) {
          calls.push({ method: 'getRisk', input });
          return { level: risk.get(input.identityId) ?? 'none' };
        },
      },
    },
  };
  return { iam, calls, risk };
}

describe('guard plugin and folder downloads', () => {
  it('counts every file of a folder ZIP, within one request and across requests', async () => {
    const anomalies: DownloadAnomaly[] = [];
    const f = await fixture({
      plugins: [
        guardPlugin({
          maxDownloads: 5,
          windowMs: 60_000,
          onAnomaly: (a) => void anomalies.push(a),
        }),
      ],
    });
    const { room } = await roomWithDownload(f);
    const folder = await f.dr.api.folders.create(as('alice'), {
      tenantId: TENANT,
      parentId: room.rootNodeId,
      name: 'Data',
    });
    for (let i = 0; i < 3; i++)
      await f.upload('alice', { parentId: folder.id, filename: `${i}.bin`, content: f.bytes(4) });
    const zip = (nodeId: string) =>
      f.dr.api.folders.requestDownload(as('bob'), {
        tenantId: TENANT,
        nodeId,
        variant: 'original',
      });

    // The whole room is four files: under the limit of five.
    await expect(zip(room.rootNodeId)).resolves.toMatchObject({ files: 4 });
    // Four already taken in the window, and three more would make seven.
    await expect(zip(folder.id)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await expect(zip(folder.id)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    // Reported once per window, and the report is in the room's log for other servers to see.
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({ principalId: 'bob', count: 6, limit: 5 });

    // A single file still fits.
    const one = (await f.dr.api.rooms.index(as('bob'), { tenantId: TENANT, roomId: room.id })).find(
      (n) => n.name === 'a.bin',
    )!;
    await expect(
      f.dr.api.documents.requestOriginal(as('bob'), { tenantId: TENANT, nodeId: one.id }),
    ).resolves.toBeDefined();
    await expect(
      f.dr.api.documents.requestOriginal(as('bob'), { tenantId: TENANT, nodeId: one.id }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
});

describe('guard plugin with Better IAM threat response', () => {
  it('raises the bulk downloader’s risk, responds, and then refuses them in every room', async () => {
    const threats = fakeThreats();
    const anomalies: DownloadAnomaly[] = [];
    const wired = betterIamThreats(threats.iam, {
      credential: () => ({ token: 'security-key' }),
      actions: [{ kind: 'revoke-sessions' }, { kind: 'block-network', durationMs: 3_600_000 }],
      cacheMs: 0,
    });
    const f = await fixture({
      plugins: [
        guardPlugin({
          maxDownloads: 2,
          windowMs: 60_000,
          ...wired,
          onAnomaly: async (anomaly, context) => {
            anomalies.push(anomaly);
            await wired.onAnomaly!(anomaly, context);
          },
        }),
      ],
    });
    const { document } = await roomWithDownload(f);
    const other = await roomWithDownload(f);
    const download = (nodeId = document.id) =>
      f.dr.api.documents.requestOriginal(as('bob'), { tenantId: TENANT, nodeId });

    await download();
    await download();
    await expect(download()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(anomalies).toEqual([
      expect.objectContaining({ principalId: 'bob', principalKind: 'user', count: 3, limit: 2 }),
    ]);
    const writes = threats.calls.filter((call) => call.method !== 'getRisk');
    expect(writes).toEqual([
      {
        method: 'setRisk',
        input: expect.objectContaining({
          tenantId: TENANT,
          identityId: 'bob',
          level: 'high',
          expiresInMs: 86_400_000,
          reason: expect.stringContaining('3 downloads'),
        }),
      },
      {
        method: 'respond',
        input: expect.objectContaining({
          identityId: 'bob',
          actions: [{ kind: 'revoke-sessions' }],
        }),
      },
    ]);

    // Better IAM now rates them high risk: refused in the other room too, views included, before any rate count.
    await expect(download(other.document.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      details: { reason: 'risk', riskLevel: 'high' },
    });
    // The owner is unaffected.
    await expect(
      f.dr.api.documents.requestOriginal(as('alice'), { tenantId: TENANT, nodeId: document.id }),
    ).resolves.toBeDefined();
    // Once Better IAM clears the risk, the window decides again.
    threats.risk.set('bob', 'none');
    f.clock.current += 61_000;
    await expect(download(other.document.id)).resolves.toBeDefined();
  });

  it('refuses people Better IAM flags for its own reasons, and fails open when the lookup fails', async () => {
    let level: RiskLevel | Error = 'medium';
    let failures = 0;
    const f = await fixture({
      plugins: [
        guardPlugin({
          risk: {
            level: 'medium',
            lookup: async () => {
              if (level instanceof Error) {
                failures++;
                throw level;
              }
              return level;
            },
          },
        }),
      ],
    });
    const { document } = await roomWithDownload(f);
    const download = () =>
      f.dr.api.documents.requestOriginal(as('bob'), { tenantId: TENANT, nodeId: document.id });
    await expect(download()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    level = 'low';
    await expect(download()).resolves.toBeDefined();
    level = new Error('Better IAM is down');
    await expect(download()).resolves.toBeDefined();
    expect(failures).toBe(1);
  });

  it('leaves non-identity principals to the event, and skips the risk change when told to', async () => {
    const threats = fakeThreats();
    const { onAnomaly, risk } = betterIamThreats(threats.iam, {
      credential: () => ({ token: 'k' }),
      raiseRisk: false,
      blockAt: false,
      actions: [{ kind: 'notify' }],
    });
    expect(risk).toBeUndefined();
    const anomaly: DownloadAnomaly = {
      tenantId: TENANT,
      roomId: 'room_1',
      principalId: 'svc_1',
      principalKind: 'service',
      count: 5,
      windowMs: 60_000,
      limit: 4,
    };
    await onAnomaly!(anomaly, undefined as never);
    expect(threats.calls).toEqual([]);
    await onAnomaly!({ ...anomaly, principalId: 'bob', principalKind: 'user' }, undefined as never);
    expect(threats.calls).toEqual([
      { method: 'respond', input: expect.objectContaining({ actions: [{ kind: 'notify' }] }) },
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

describe('betterIamThreats against Better IAM', () => {
  it('raises risk, responds and reads risk back with a service account API key', async () => {
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
    const created = await iam.api.tenants.create(
      { token: rootSession.token },
      {
        parentId: root.tenant.id,
        name: 'acme',
        type: 'organization',
        ownerEmail: 'owner@acme.test',
      },
    );
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
    const asOwner = { token: owner.token };
    const bob = await iam.api.identities.create(asOwner, {
      tenantId,
      email: 'bob@acme.test',
      name: 'Bob',
      password: 'a strong bob password',
    });

    // The security service account: a role with threatsPolicy(), bound to it, and an API key.
    const account = await iam.api.serviceAccounts.create(asOwner, {
      tenantId,
      name: 'better-files-security',
    });
    const role = await iam.api.roles.create(asOwner, {
      tenantId,
      name: 'Better Files security',
      document: threatsPolicy(),
    });
    await iam.api.bindings.create(asOwner, {
      tenantId,
      roleId: role.id,
      subjectType: 'identity',
      subjectId: account.id,
    });
    const key = await iam.api.credentials.create(asOwner, { tenantId, identityId: account.id });

    const { onAnomaly, risk } = betterIamThreats(iam, {
      credential: () => ({ token: key.token }),
      actions: [{ kind: 'revoke-sessions' }],
    });
    expect(await risk!.lookup({ tenantId, principalId: bob.id })).toBe('none');
    await onAnomaly!(
      {
        tenantId,
        roomId: 'room_1',
        principalId: bob.id,
        principalKind: 'user',
        count: 101,
        windowMs: 600_000,
        limit: 100,
      },
      undefined as never,
    );
    const view = await iam.api.threats.getRisk(asOwner, { tenantId, identityId: bob.id });
    expect(view).toMatchObject({
      level: 'high',
      override: { level: 'high', active: true, reason: expect.stringContaining('101 downloads') },
    });
    // A fresh integration (no cached level) reads the raised risk from Better IAM.
    const fresh = betterIamThreats(iam, { credential: () => ({ token: key.token }) });
    expect(await fresh.risk!.lookup({ tenantId, principalId: bob.id })).toBe('high');
  });
});
