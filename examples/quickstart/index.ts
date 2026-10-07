/**
 * Better Files in one file, with no services: the in-memory database, storage and identity fakes from
 * `better-files/testing`. Swap them for Better IAM, SQL and object storage (see ../express-better-iam).
 *
 *   node examples/quickstart/index.ts        (Node 22.18+, after `pnpm build`)
 */
import { coreAccessModel } from 'better-files/core';
import { localKeyProvider } from 'better-files/crypto';
import { betterFiles } from 'better-files/server';
import { fakeIam, memoryDatabase, memoryStorage, relationDecider } from 'better-files/testing';

const TENANT = 'acme';
const secret = 'replace-me-with-a-32-plus-character-secret';

// Two people. The fake identity system treats the bearer token as the user id.
const iam = fakeIam({
  principals: {
    olivia: { id: 'olivia', tenantId: TENANT, name: 'Olivia Owner', email: 'olivia@seller.test' },
    ben: { id: 'ben', tenantId: TENANT, name: 'Ben Buyer', email: 'ben@buyer.test' },
  },
  decide: relationDecider(coreAccessModel, {
    tenantActions: (principal) => (principal.id === 'olivia' ? ['*'] : ['better-files:rooms:read']),
    roomOf: async (type, id) =>
      (await dr.resolveForIam({ tenantId: TENANT, type, id }))?.attributes.roomId as
        | string
        | undefined,
  }),
});

const dr = betterFiles({
  iam,
  database: memoryDatabase(),
  storage: memoryStorage(),
  secret,
  encryption: { keys: localKeyProvider({ secret }) },
});
await dr.initialize();

const olivia = { token: 'olivia' };
const ben = { token: 'ben' };

// A room with a folder and a document.
const room = await dr.api.rooms.create(olivia, { tenantId: TENANT, name: 'Project Falcon' });
const financials = await dr.api.folders.create(olivia, {
  tenantId: TENANT,
  parentId: room.rootNodeId,
  name: 'Financials',
});
const content = new TextEncoder().encode('Revenue 2025: 12.4m');
const session = await dr.api.uploads.create(olivia, {
  tenantId: TENANT,
  parentId: financials.id,
  filename: 'revenue.txt',
  size: content.byteLength,
});
await dr.files.upload(olivia, { tenantId: TENANT, uploadId: session.uploadId, body: content });
const { document } = await dr.api.uploads.complete(olivia, {
  tenantId: TENANT,
  uploadId: session.uploadId,
});

// Ben joins a "Buyers" group that may view and download watermarked copies, but not originals.
const buyers = await dr.api.groups.create(olivia, {
  tenantId: TENANT,
  roomId: room.id,
  name: 'Buyers',
  preset: 'download',
});
await dr.api.members.invite(olivia, {
  tenantId: TENANT,
  roomId: room.id,
  email: 'ben@buyer.test',
  groupIds: [buyers.id],
});

console.log(
  'Ben sees:',
  (await dr.api.rooms.index(ben, { tenantId: TENANT, roomId: room.id })).map(
    (n) => `${n.index} ${n.name}`,
  ),
);
const benMay = await dr.capabilitiesFor(ben, {
  tenantId: TENANT,
  roomId: room.id,
  nodeIds: [document.id],
});
console.log('Ben may:', benMay[document.id]);
await dr.api.documents
  .requestOriginal(ben, { tenantId: TENANT, nodeId: document.id })
  .catch((error: Error) => console.log('Original download:', error.message));

// Olivia downloads the original through a short-lived ticket; the bytes stream back decrypted.
const ticket = await dr.api.documents.requestOriginal(olivia, {
  tenantId: TENANT,
  nodeId: document.id,
});
const response = await dr.files.serve(ticket.token);
console.log('Olivia reads:', await response.text());

// Everything above is in the room's hash-chained activity log.
const activity = await dr.api.activity.list(olivia, { tenantId: TENANT, roomId: room.id });
console.log('Activity:', activity.map((record) => `${record.actorId} ${record.action}`).reverse());
console.log('Chain:', await dr.verifyActivity({ tenantId: TENANT, roomId: room.id }));
await dr.close();
