// Runs in a clean app that installed the packed tarballs and better-iam from npm (see ../packed-smoke.mjs): Better Files
// on real Better IAM, as a user would set it up, end to end.
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { betterIam } from 'better-iam';
import { sqliteAdapter as iamSqlite } from 'better-iam/adapter-sqlite';
import { betterFiles } from 'better-files';
import {
  betterIamFeatures,
  betterIamIntegration,
  betterFilesIamPlugin,
  betterFilesResolver,
  systemPolicy,
} from 'better-files/iam';
import { sqliteAdapter } from 'better-files/adapter-sqlite';
import { fileStorage } from 'better-files/storage-fs';
import { ndaPlugin } from 'better-files/plugin-nda';
import { watermarkPlugin } from 'better-files/plugin-watermark';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`packed smoke: ${message}`);
}

/** RFC 6238 for the root administrator's MFA sign-in. */
function totp(secret: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret.replace(/=+$/, '').toUpperCase())
    bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const mac = createHmac('sha1', key).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0xf;
  return ((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

const files = await mkdtemp(join(tmpdir(), 'better-files-smoke-files-'));
const plugins = [ndaPlugin(), watermarkPlugin()] as const;
const iamPlugin = betterFilesIamPlugin({ plugins });
const inbox: { tenantId: string; template: string; payload: Record<string, string> }[] = [];
const store = iamSqlite({ filename: ':memory:' });
let systemToken = '';
const iam = betterIam({
  database: store,
  secret: 'packed-smoke-secret-with-at-least-32-characters',
  baseURL: 'http://localhost:3000',
  authentication: { sendEmail: async (message) => void inbox.push(message) },
  onboarding: { mode: 'linked' },
  plugins: [iamPlugin],
  resolveResource: betterFilesResolver(() => dr),
});
const dr = betterFiles({
  iam: betterIamIntegration(iam, { iamPlugin, systemCredential: () => ({ token: systemToken }) }),
  database: sqliteAdapter({ filename: ':memory:' }),
  storage: fileStorage({ root: files }),
  secret: 'a-packed-smoke-better-files-secret-of-32-characters',
  plugins,
});

try {
  await iam.initialize();
  await dr.initialize();
  console.log('better-iam features:', JSON.stringify(betterIamFeatures(iam)));

  // A tenant and its owner, the way an app onboards one.
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
  check('mfaRequired' in challenge, 'root must require MFA');
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
  );
  check(invitation, 'no owner invitation was sent');
  const accepted = await iam.api.tenants.acceptInvitation({
    tenantId: created.tenant.id,
    token: invitation.payload.token!,
    name: 'Acme owner',
    password: 'a strong tenant owner password',
  });
  check('token' in accepted, 'unexpected MFA for the owner');
  const owner = { token: accepted.token };
  const tenantId = created.tenant.id;
  systemToken = accepted.token;

  // The service-account policy this release accepts.
  await iam.api.roles.create(owner, {
    tenantId,
    name: 'Better Files system',
    document: systemPolicy(iam),
  });

  // A room, a folder, an encrypted upload and a download.
  const room = await dr.api.rooms.create(owner, { tenantId, name: 'Project Falcon' });
  const folder = await dr.api.folders.create(owner, {
    tenantId,
    parentId: room.rootNodeId,
    name: 'Finance',
  });
  const content = new TextEncoder().encode('packed and encrypted');
  const session = await dr.api.uploads.create(owner, {
    tenantId,
    parentId: folder.id,
    filename: 'model.txt',
    size: content.byteLength,
  });
  await dr.files.upload(owner, { tenantId, uploadId: session.uploadId, body: content });
  const { document } = await dr.api.uploads.complete(owner, {
    tenantId,
    uploadId: session.uploadId,
  });
  const ticket = await dr.api.documents.requestOriginal(owner, { tenantId, nodeId: document.id });
  const served = await dr.files.serve(ticket.url.split('/files/')[1]!);
  check((await served.text()) === 'packed and encrypted', 'the download does not match the upload');

  // The HTTP protocol with a Better IAM bearer token (X-Better-Files is the CSRF guard the typed client sends).
  const response = await dr.handler(
    new Request('http://localhost:3000/api/better-files/rooms/list', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-better-files': '1',
        authorization: `Bearer ${owner.token}`,
      },
      body: JSON.stringify({ tenantId }),
    }),
  );
  check(
    response.status === 200,
    `rooms/list answered ${response.status}: ${await response.clone().text()}`,
  );
  const listed = (await response.json()) as { data: { id: string }[] };
  check(
    listed.data.some((r) => r.id === room.id),
    'the room is missing from rooms/list',
  );

  const chain = await dr.api.activity.verify(owner, { tenantId, roomId: room.id });
  check(chain.valid, 'the activity chain does not verify');
  console.log('packed smoke: Better Files on better-iam from npm works end to end');
} finally {
  await dr.close();
  await store.close();
  await rm(files, { recursive: true, force: true });
}
