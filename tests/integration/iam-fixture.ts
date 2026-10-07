import { createHmac } from 'node:crypto';
import { betterIam } from 'better-iam';
import { sqliteAdapter as iamSqlite } from 'better-iam/adapter-sqlite';
import type { IamStore } from 'better-iam/core';
import { definePlugin, endpoint, v } from '@better-files/core';
import { betterFiles } from '@better-files/server';
import {
  betterIamIntegration,
  betterFilesIamPlugin,
  betterFilesResolver,
  type BetterIamIntegrationOptions,
  type BetterFilesIamPluginOptions,
} from '@better-files/iam';
import { sqliteAdapter } from '@better-files/adapter-sqlite';
import { memoryStorage } from '@better-files/testing';

/** A real Better IAM instance (SQLite in memory) with Better Files on top, for the integration tests. */

/** RFC 6238 (SHA-1, 30 s, 6 digits) for the root administrator's MFA sign-in. */
export function totp(secret: string, now = Date.now()) {
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
/** Call from `afterEach`: closes the Better IAM stores the fixtures opened. */
export async function closeStores() {
  for (const store of stores.splice(0)) await store.close();
}

export const probePlugin = definePlugin({
  id: 'probe',
  actions: ['better-files:probe:read'],
  accessModel: [{ relations: ['owner', 'admin', 'viewer'], actions: ['better-files:probe:read'] }],
  endpoints: {
    whoami: endpoint({
      operation: { action: 'better-files:rooms:read', target: 'tenant', mutates: false },
      input: v.object({}),
      handler: async (context) => context.principal,
    }),
    read: endpoint({
      operation: {
        action: 'better-files:probe:read',
        target: 'node',
        capabilities: ['VIEW'],
        mutates: false,
      },
      input: v.object({ nodeId: v.id() }),
      target: (input) => ({ nodeId: input.nodeId }),
      handler: async (_context, input) => ({ read: input.nodeId }),
    }),
  },
});

export interface FixtureOptions {
  integration?: Pick<BetterIamIntegrationOptions, 'externalInvites'>;
  plugin?: Omit<BetterFilesIamPluginOptions, 'plugins'>;
}

export async function fixture(options: FixtureOptions = {}) {
  const store = iamSqlite({ filename: ':memory:' });
  stores.push(store);
  const inbox: {
    tenantId: string;
    template: string;
    to?: string;
    payload: Record<string, string>;
  }[] = [];
  const iamPlugin = betterFilesIamPlugin({ plugins: [probePlugin], ...options.plugin });
  let dr: ReturnType<typeof createBetterFiles>;
  let systemToken = '';
  const iam = betterIam({
    database: store,
    secret: 'test-secret-with-at-least-32-characters',
    baseURL: 'http://localhost:3000',
    authentication: { sendEmail: async (message) => void inbox.push(message) },
    onboarding: { mode: 'linked' },
    plugins: [iamPlugin],
    resolveResource: betterFilesResolver(() => dr),
  });
  const database = sqliteAdapter({ filename: ':memory:' });
  const createBetterFiles = () =>
    betterFiles({
      iam: betterIamIntegration(iam, {
        iamPlugin,
        systemCredential: () => ({ token: systemToken }),
        ...options.integration,
      }),
      database,
      storage: memoryStorage(),
      secret: 'a-better-files-secret-with-more-than-32-characters',
      plugins: [probePlugin],
      logger: { warn() {}, error: (message, data) => console.error(message, data) },
    });
  dr = createBetterFiles();
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
  // In production this is a service account's API key with systemPolicy(); the tenant owner stands in here.
  systemToken = owner.token;
  const tenantId = created.tenant.id;
  const member = async (name: string) => {
    const identity = await iam.api.identities.create(
      { token: owner.token },
      {
        tenantId,
        email: `${name}@acme.test`,
        name,
        password: `a strong ${name} password`,
      },
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
    iamPlugin,
    dr,
    store,
    inbox,
    tenantId,
    rootTenantId: root.tenant.id,
    owner: { token: owner.token },
    member,
  };
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;
