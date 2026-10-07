import { createHmac } from 'node:crypto';
import { afterEach } from 'vitest';
import { betterIam } from 'better-iam';
import { sqliteAdapter as iamSqlite } from 'better-iam/adapter-sqlite';
import type { IamStore } from 'better-iam/core';
import type { BetterFilesPlugin } from '@better-files/core';
import { betterFiles } from '@better-files/server';
import { betterIamIntegration, betterFilesIamPlugin, betterFilesResolver } from '@better-files/iam';
import { sqliteAdapter } from '@better-files/adapter-sqlite';
import { memoryStorage } from '@better-files/testing';

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) for the root administrator's MFA, without a dependency. */
export function totp(secret: string, now = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret.replace(/=+$/, '').toUpperCase())
    bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

const stores: IamStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

/**
 * Better IAM (the release installed from npm) with a root administrator, an `acme` tenant with an owner, and
 * Better Files on it. The owner's token stands in for the service account `systemCredential` would use in production.
 */
export async function betterIamTenant(options: { plugins?: readonly BetterFilesPlugin[] } = {}) {
  const store = iamSqlite({ filename: ':memory:' });
  stores.push(store);
  const inbox: { tenantId: string; template: string; payload: Record<string, string> }[] = [];
  const iamPlugin = betterFilesIamPlugin({ plugins: options.plugins ?? [] });
  let systemToken = '';
  // eslint-disable-next-line prefer-const
  let dr: ReturnType<typeof betterFiles>;
  const iam = betterIam({
    database: store,
    secret: 'test-secret-with-at-least-32-characters',
    baseURL: 'http://localhost:3000',
    authentication: { sendEmail: async (message) => void inbox.push(message) },
    onboarding: { mode: 'linked' },
    plugins: [iamPlugin],
    resolveResource: betterFilesResolver(() => dr),
  });
  dr = betterFiles({
    iam: betterIamIntegration(iam, { iamPlugin, systemCredential: () => ({ token: systemToken }) }),
    database: sqliteAdapter({ filename: ':memory:' }),
    storage: memoryStorage(),
    secret: 'a-better-files-secret-with-more-than-32-characters',
    plugins: [...(options.plugins ?? [])],
    logger: { warn() {}, error() {} },
  });
  await iam.initialize();
  await dr.initialize();

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
    { parentId: root.tenant.id, name: 'acme', type: 'organization', ownerEmail: 'owner@acme.test' },
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
  systemToken = owner.token;
  const tenantId = created.tenant.id;
  /** A member of the tenant; `credential` is a signed-in session. */
  const member = async (name: string) => {
    const identity = await iam.api.identities.create(
      { token: owner.token },
      { tenantId, email: `${name}@acme.test`, name, password: `a strong ${name} password` },
    );
    const login = await iam.api.auth.signIn({
      tenantId,
      email: `${name}@acme.test`,
      password: `a strong ${name} password`,
    });
    if (!('token' in login)) throw new Error('Unexpected MFA');
    return { id: identity.id, credential: { token: login.token } };
  };
  return {
    iam,
    dr,
    store,
    inbox,
    tenantId,
    rootTenantId: root.tenant.id,
    owner: { token: owner.token },
    member,
  };
}
