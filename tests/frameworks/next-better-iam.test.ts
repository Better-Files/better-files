import { describe, expect, it } from 'vitest';
import { createIamNext } from 'better-iam/next';
import { createBetterFilesNext } from '@better-files/next';
import { betterIamTenant } from '../integration/better-iam-tenant.js';

/** Better IAM's Next helpers reading a request we control, instead of Next's `headers()`. */
async function setup() {
  const f = await betterIamTenant();
  const room = await f.dr.api.rooms.create(f.owner, { tenantId: f.tenantId, name: 'Falcon' });
  const folder = await f.dr.api.folders.create(f.owner, {
    tenantId: f.tenantId,
    parentId: room.rootNodeId,
    name: 'Finance',
  });
  const dana = await f.member('dana');
  const buyers = await f.dr.api.groups.create(f.owner, {
    tenantId: f.tenantId,
    roomId: room.id,
    name: 'Buyers',
    preset: 'view',
  });
  await f.dr.api.members.invite(f.owner, {
    tenantId: f.tenantId,
    roomId: room.id,
    email: 'dana@acme.test',
    groupIds: [buyers.id],
  });
  const request = { headers: new Headers() };
  const signIn = (token?: string) => {
    request.headers = new Headers(token ? { authorization: `Bearer ${token}` } : {});
  };
  const iamNext = createIamNext(f.iam, {
    headers: () => request.headers,
    cache: (fn) => fn,
  });
  return { f, room, folder, dana, signIn, drNext: createBetterFilesNext(f.dr, { iamNext }) };
}

describe('Next.js with better-iam/next', () => {
  it('binds the API to the Better IAM session and its tenant', async () => {
    const { f, room, dana, signIn, drNext } = await setup();
    signIn(dana.credential.token);
    const context = await drNext.request();
    expect(context).toMatchObject({ tenantId: f.tenantId, identityId: dana.id });
    expect((await context.tenant.rooms.list({})).map((r) => r.id)).toEqual([room.id]);
    // An explicit tenant still wins, and the plain bound API takes it as usual.
    await expect(context.tenant.rooms.list({ tenantId: f.rootTenantId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await context.api.rooms.list({ tenantId: f.tenantId })).toHaveLength(1);
  });

  it('guards pages on the matrix with the tenant from the session', async () => {
    const { room, folder, dana, signIn, drNext } = await setup();
    signIn(dana.credential.token);
    await expect(
      drNext.capabilities(undefined, {
        roomId: room.id,
        nodeId: folder.id,
        capabilities: ['VIEW'],
      }),
    ).resolves.toEqual(expect.arrayContaining(['LIST', 'VIEW']));
    await expect(
      drNext.capabilities(undefined, {
        roomId: room.id,
        nodeId: folder.id,
        capabilities: ['DOWNLOAD_ORIGINAL'],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      drNext.capabilities(undefined, {
        roomId: room.id,
        nodeId: 'nod_does_not_exist',
        capabilities: ['VIEW'],
      }),
    ).resolves.toBeNull();
  });

  it('reports signed-out requests and missing configuration', async () => {
    const { f, room, folder, signIn, drNext } = await setup();
    signIn();
    await expect(drNext.session()).resolves.toBeNull();
    await expect(drNext.request()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(
      drNext.capabilities(undefined, { roomId: room.id, nodeId: folder.id, capabilities: [] }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const plain = createBetterFilesNext(f.dr);
    await expect(plain.request()).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    // Without Better IAM's helpers, headers and the tenant are passed as before.
    const owner = new Headers({ authorization: `Bearer ${f.owner.token}` });
    expect(await plain.api(owner).rooms.list({ tenantId: f.tenantId })).toHaveLength(1);
    await expect(
      plain.capabilities(owner, {
        tenantId: f.tenantId,
        roomId: room.id,
        nodeId: folder.id,
        capabilities: ['VIEW'],
      }),
    ).resolves.toContain('VIEW');
  });
});
