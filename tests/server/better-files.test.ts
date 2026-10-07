import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  Capability,
  BetterFilesError,
  definePlugin,
  endpoint,
  field,
  type Credential,
} from '@better-files/core';
import { betterFiles } from '@better-files/server';
import { fakeIam, memoryDatabase, memoryStorage, seedRoom } from '@better-files/testing';
import { jsonRequest, objectSchema } from '../helpers.js';

const TENANT = 't1';

const notesPlugin = definePlugin({
  id: 'notes',
  actions: ['better-files:notes:read'],
  extendSchema: {
    rooms: { additionalFields: { notesEnabled: field.boolean({ required: false }) } },
  },
  endpoints: {
    hello: endpoint({
      operation: { action: 'better-files:rooms:read', target: 'tenant', mutates: false },
      input: objectSchema({ name: 'string' }),
      handler: async (context, input) => ({
        greeting: `hello ${input.name}`,
        by: context.principal.id,
      }),
    }),
    peek: endpoint({
      operation: {
        action: 'better-files:notes:read',
        target: 'node',
        capabilities: ['VIEW'],
        mutates: false,
      },
      input: objectSchema({ nodeId: 'string' }),
      target: (input) => ({ nodeId: input.nodeId }),
      handler: async (_context, input) => ({ peeked: input.nodeId }),
    }),
    touch: endpoint({
      operation: { action: 'better-files:notes:read', target: 'room', mutates: true },
      input: objectSchema({ roomId: 'string' }),
      target: (input) => ({ roomId: input.roomId }),
      handler: async (context, input) => {
        await context.db.update(
          'rooms',
          { id: input.roomId, tenantId: context.tenantId },
          { notesEnabled: true },
        );
        return { touched: true };
      },
    }),
  },
});

async function fixture(options: { deny?: string[] } = {}) {
  const database = memoryDatabase();
  const iam = fakeIam({
    principals: {
      alice: { id: 'alice', tenantId: TENANT, groups: ['buyer-a'] },
      bob: { id: 'bob', tenantId: TENANT },
      admin: { id: 'admin', tenantId: TENANT },
      mallory: { id: 'mallory', tenantId: 'other' },
    },
    decide: (principal, check) => {
      if (check.action === 'better-files:admin' || check.action === 'better-files:activity:export')
        return principal.id === 'admin';
      return !(options.deny ?? []).includes(check.action);
    },
  });
  const dr = betterFiles({
    iam,
    database,
    storage: memoryStorage(),
    secret: 'a-test-secret-with-more-than-32-characters',
    encryption: false,
    plugins: [notesPlugin],
    schema: { rooms: { additionalFields: { dealCode: field.string({ required: false }) } } },
    logger: { warn() {}, error() {} },
  });
  await dr.initialize();
  const seeded = await seedRoom(database, {
    tenantId: TENANT,
    tree: [{ name: 'finance', children: [{ name: 'model.xlsx' }, { name: 'secret.pdf' }] }],
  });
  await seeded.grant('root', { type: 'group', id: 'buyer-a' }, dr.capabilities.preset('view'));
  await seeded.grant(
    'secret.pdf',
    { type: 'group', id: 'buyer-a' },
    dr.capabilities.preset('hidden'),
  );
  const as = (token: string): Credential => ({ token });
  return { dr, iam, database, seeded, as };
}

describe('betterFiles()', () => {
  it('validates its configuration', () => {
    const base = {
      iam: fakeIam({ principals: {} }),
      database: memoryDatabase(),
      storage: memoryStorage(),
      secret: 'a-test-secret-with-more-than-32-characters',
      encryption: false as const,
    };
    expect(() => betterFiles({ ...base, plugins: [notesPlugin, notesPlugin] })).toThrow(
      /more than once/,
    );
    expect(() => betterFiles({ ...base, plugins: [definePlugin({ id: 'rooms' })] })).toThrow(
      /reserved/,
    );
    expect(() =>
      betterFiles({
        ...base,
        plugins: [definePlugin({ id: 'x', actions: ['iam:identities:read'] })],
      }),
    ).toThrow(/better-files: namespace/);
    expect(() =>
      betterFiles({ ...base, plugins: [definePlugin({ id: 'x', dependsOn: ['qa'] })] }),
    ).toThrow(/needs plugin qa/);
    expect(() =>
      betterFiles({
        ...base,
        plugins: [
          definePlugin({ id: 'a', capabilities: { SHARE: { bit: 16 } } }),
          definePlugin({ id: 'b', capabilities: { SHARE: { bit: 17 } } }),
        ],
      }),
    ).toThrow(/declared more than once/);
  });

  it('types the API and records from options and plugins', async () => {
    const { dr } = await fixture();
    expectTypeOf(dr.api.notes.hello)
      .parameter(1)
      .toEqualTypeOf<{ name: string } & { tenantId: string }>();
    expectTypeOf(dr.api.notes.hello).returns.resolves.toEqualTypeOf<{
      greeting: string;
      by: string;
    }>();
    expectTypeOf<(typeof dr.$Infer.Room)['dealCode']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<(typeof dr.$Infer.Room)['notesEnabled']>().toEqualTypeOf<boolean | undefined>();
    expect(dr.schema.tables.rooms!.fields.notesEnabled).toBeDefined();
  });

  it('runs tenant endpoints after authentication and the IAM decision', async () => {
    const { dr, iam, as } = await fixture();
    await expect(
      dr.api.notes.hello(as('alice'), { tenantId: TENANT, name: 'Ann' }),
    ).resolves.toEqual({
      greeting: 'hello Ann',
      by: 'alice',
    });
    expect(iam.checks.at(-1)).toMatchObject({
      action: 'better-files:rooms:read',
      resource: { type: 'iam', id: TENANT },
    });
    await expect(
      dr.api.notes.hello(as('nobody'), { tenantId: TENANT, name: 'x' }),
    ).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    await expect(
      dr.api.notes.hello(as('mallory'), { tenantId: TENANT, name: 'x' }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      dr.api.notes.hello(as('alice'), { tenantId: TENANT, name: 3 } as never),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', details: { issues: [{ path: 'name' }] } });
  });

  it('checks the permission matrix before the IAM decision on nodes', async () => {
    const { dr, seeded, as } = await fixture();
    const { nodes } = seeded;
    await expect(
      dr.api.notes.peek(as('alice'), { tenantId: TENANT, nodeId: nodes['model.xlsx']! }),
    ).resolves.toEqual({
      peeked: nodes['model.xlsx'],
    });
    // Hidden for her group, and never granted to bob: both look like missing nodes, not forbidden ones.
    await expect(
      dr.api.notes.peek(as('alice'), { tenantId: TENANT, nodeId: nodes['secret.pdf']! }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      dr.api.notes.peek(as('bob'), { tenantId: TENANT, nodeId: nodes['model.xlsx']! }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    // Room administrators (an IAM decision) see everything.
    await expect(
      dr.api.notes.peek(as('admin'), { tenantId: TENANT, nodeId: nodes['secret.pdf']! }),
    ).resolves.toBeDefined();
  });

  it('refuses when IAM denies even though the matrix allows', async () => {
    const { dr, seeded, as } = await fixture({ deny: ['better-files:notes:read'] });
    await expect(
      dr.api.notes.peek(as('alice'), { tenantId: TENANT, nodeId: seeded.nodes['model.xlsx']! }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('reports forbidden when the node is visible but the capability is missing', async () => {
    const { dr, seeded, as } = await fixture();
    await seeded.grant('model.xlsx', { type: 'identity', id: 'bob' }, Capability.LIST);
    await seeded.grant('root', { type: 'identity', id: 'bob' }, Capability.LIST);
    await expect(
      dr.api.notes.peek(as('bob'), { tenantId: TENANT, nodeId: seeded.nodes['model.xlsx']! }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('runs mutating endpoints in a transaction and refuses closed rooms', async () => {
    const { dr, database, seeded, as } = await fixture();
    await expect(
      dr.api.notes.touch(as('alice'), { tenantId: TENANT, roomId: seeded.room.id }),
    ).resolves.toEqual({
      touched: true,
    });
    expect(
      (await database.findOne<{ notesEnabled?: boolean }>('rooms', { id: seeded.room.id }))
        ?.notesEnabled,
    ).toBe(true);
    await database.transaction((tx) =>
      tx.update('rooms', { id: seeded.room.id }, { status: 'closed' }),
    );
    await expect(
      dr.api.notes.touch(as('alice'), { tenantId: TENANT, roomId: seeded.room.id }),
    ).rejects.toMatchObject({
      code: 'ROOM_CLOSED',
    });
    await expect(
      dr.api.notes.touch(as('alice'), { tenantId: 'other', roomId: seeded.room.id }),
    ).rejects.toBeInstanceOf(BetterFilesError);
  });

  it('reports effective capabilities with room and document clamps', async () => {
    const { dr, database, seeded, as } = await fixture();
    await seeded.grant(
      'finance',
      { type: 'group', id: 'buyer-a' },
      dr.capabilities.preset('download'),
    );
    const ids = [seeded.nodes['model.xlsx']!, seeded.nodes['secret.pdf']!];
    expect(
      await dr.capabilitiesFor(as('alice'), {
        tenantId: TENANT,
        roomId: seeded.room.id,
        nodeIds: ids,
      }),
    ).toEqual({
      [ids[0]!]: ['LIST', 'VIEW', 'PRINT', 'DOWNLOAD_WATERMARKED'],
      [ids[1]!]: [],
    });
    await database.transaction((tx) =>
      tx.update('documents', { id: ids[0]! }, { flags: { viewOnly: true } }),
    );
    await database.transaction((tx) =>
      tx.update('rooms', { id: seeded.room.id }, { status: 'closed' }),
    );
    const clamped = await dr.capabilitiesFor(as('admin'), {
      tenantId: TENANT,
      roomId: seeded.room.id,
      nodeIds: ids,
    });
    expect(clamped[ids[0]!]).toEqual(['LIST', 'VIEW', 'MANAGE']);
    expect(clamped[ids[1]!]).toContain('DOWNLOAD_ORIGINAL');
    expect(clamped[ids[1]!]).not.toContain('UPLOAD');
  });

  it('describes folders and documents for the IAM resolver', async () => {
    const { dr, seeded } = await fixture();
    await expect(
      dr.resolveForIam({
        tenantId: TENANT,
        type: 'better-files-document',
        id: seeded.nodes['model.xlsx']!,
      }),
    ).resolves.toMatchObject({
      attributes: {
        roomId: seeded.room.id,
        roomStatus: 'live',
        parentType: 'better-files-room',
        parentId: seeded.room.id,
      },
    });
    await expect(
      dr.resolveForIam({
        tenantId: TENANT,
        type: 'better-files-folder',
        id: seeded.nodes['model.xlsx']!,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      dr.resolveForIam({
        tenantId: 'other',
        type: 'better-files-document',
        id: seeded.nodes['model.xlsx']!,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      dr.resolveForIam({ tenantId: TENANT, type: 'invoice', id: 'x' }),
    ).resolves.toBeUndefined();
  });
});

describe('HTTP protocol', () => {
  const url = 'http://app.test/api/better-files';

  it('serves the envelope over fetch', async () => {
    const { dr } = await fixture();
    const ok = await dr.handler(
      jsonRequest(
        `${url}/notes/hello`,
        { tenantId: TENANT, name: 'Ann' },
        { authorization: 'Bearer alice', 'x-request-id': 'req-1' },
      ),
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(ok.headers.get('x-request-id')).toBe('req-1');
    expect(await ok.json()).toEqual({ data: { greeting: 'hello Ann', by: 'alice' } });

    const health = await dr.handler(new Request(`${url}/health`));
    expect(await health.json()).toEqual({ data: { ok: true } });
  });

  it('maps errors and refuses malformed or cross-site requests', async () => {
    const { dr } = await fixture();
    const send = async (request: Request) => {
      const response = await dr.handler(request);
      return {
        status: response.status,
        body: (await response.json()) as { error?: { code: string } },
      };
    };
    const auth = { authorization: 'Bearer alice' };
    expect(
      await send(jsonRequest(`${url}/notes/missing`, { tenantId: TENANT }, auth)),
    ).toMatchObject({
      status: 404,
      body: { error: { code: 'NOT_FOUND' } },
    });
    expect(
      await send(jsonRequest(`${url}/notes/toString`, { tenantId: TENANT }, auth)),
    ).toMatchObject({ status: 404 });
    expect(await send(jsonRequest(`${url}/notes/hello`, { name: 'x' }, auth))).toMatchObject({
      status: 400,
      body: { error: { code: 'INVALID_INPUT' } },
    });
    expect(
      await send(
        jsonRequest(
          `${url}/notes/hello`,
          { tenantId: TENANT, name: 'x' },
          { authorization: 'Bearer nope' },
        ),
      ),
    ).toMatchObject({
      status: 401,
    });
    const noHeader = new Request(`${url}/notes/hello`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ tenantId: TENANT, name: 'x' }),
    });
    expect(await send(noHeader)).toMatchObject({ status: 403 });
    const crossSite = jsonRequest(
      `${url}/notes/hello`,
      { tenantId: TENANT, name: 'x' },
      {
        cookie: 'session=abc',
        origin: 'https://evil.test',
      },
    );
    expect(await send(crossSite)).toMatchObject({
      status: 403,
      body: { error: { code: 'FORBIDDEN' } },
    });
    const tooLarge = jsonRequest(
      `${url}/notes/hello`,
      { tenantId: TENANT, name: 'x'.repeat(70_000) },
      auth,
    );
    expect(await send(tooLarge)).toMatchObject({ status: 413 });
  });
});
