import { createHash } from 'node:crypto';
import {
  coreAccessModel,
  type Credential,
  type BetterFilesPlugin,
  type DatabaseAdapter,
  type BetterFilesHooks,
  type KeyProvider,
  type StorageAdapter,
} from '@better-files/core';
import { localKeyProvider } from '@better-files/crypto';
import { betterFiles, type BetterFilesOptions } from '@better-files/server';
import {
  fakeIam,
  memoryDatabase,
  memoryStorage,
  relationDecider,
  type FakePrincipal,
} from '@better-files/testing';

export const TENANT = 't1';
export const SECRET = 'a-test-secret-with-more-than-32-characters';

export const users = {
  alice: { id: 'alice', tenantId: TENANT, name: 'Alice Owner', email: 'alice@acme.test' },
  bob: { id: 'bob', tenantId: TENANT, name: 'Bob Buyer', email: 'bob@acme.test' },
  carol: { id: 'carol', tenantId: TENANT, name: 'Carol Counsel', email: 'carol@acme.test' },
  dave: { id: 'dave', tenantId: TENANT, name: 'Dave Outsider', email: 'dave@acme.test' },
  mallory: { id: 'mallory', tenantId: 't2', name: 'Mallory', email: 'mallory@other.test' },
} satisfies Record<string, FakePrincipal>;

export const as = (token: string): Credential => ({ token });

export async function fixture<const P extends readonly BetterFilesPlugin[] = []>(
  options: {
    database?: DatabaseAdapter;
    plugins?: P;
    hooks?: BetterFilesHooks;
    schema?: BetterFilesOptions['schema'];
    /** Room creators: who may call rooms.create. Default alice. */
    creators?: string[];
    partSize?: number;
    /** Another storage adapter (a storage cluster); `storage` stays the in-memory one. */
    storageAdapter?: StorageAdapter;
    /** Another key provider (a cloud KMS); default `localKeyProvider`. */
    keys?: KeyProvider;
  } = {},
) {
  const database = options.database ?? memoryDatabase();
  const storage = memoryStorage();
  const clock = { current: Date.UTC(2026, 8, 25, 12, 0, 0) };
  const principals: Record<string, FakePrincipal> = { ...users };
  const creators = options.creators ?? ['alice'];
  // eslint-disable-next-line prefer-const
  let dr: ReturnType<typeof make>;
  const iam = fakeIam({
    principals,
    decide: relationDecider(
      [...coreAccessModel, ...(options.plugins ?? []).flatMap((p) => p.accessModel ?? [])],
      {
        tenantActions: (principal) =>
          // Room creators administer the tenant (every tenant-level action); everyone may list their rooms.
          creators.includes(principal.id) ? ['*'] : ['better-files:rooms:read'],
        roomOf: async (type, id) =>
          (await dr.resolveForIam({ tenantId: TENANT, type, id }).catch(() => undefined))
            ?.attributes.roomId as string | undefined,
      },
    ),
  });
  const make = () =>
    betterFiles({
      iam,
      database,
      storage: options.storageAdapter ?? storage,
      secret: SECRET,
      encryption: { keys: options.keys ?? localKeyProvider({ secret: SECRET }) },
      plugins: (options.plugins ?? []) as P,
      ...(options.hooks ? { hooks: options.hooks } : {}),
      ...(options.schema ? { schema: options.schema } : {}),
      clock: { now: () => clock.current },
      logger: { warn() {}, error() {} },
      limits: { partSize: options.partSize ?? 64 * 1024 },
    });
  dr = make();
  await dr.initialize();

  const bytes = (size: number, seed = 1) => {
    const out = new Uint8Array(size);
    let x = seed;
    for (let i = 0; i < size; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      out[i] = x & 0xff;
    }
    return out;
  };
  const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

  /** Creates a document with content through the public API (single upload or parts). */
  async function upload(
    who: string,
    input: {
      parentId?: string;
      documentId?: string;
      filename: string;
      content: Uint8Array;
      mimeType?: string;
    },
  ) {
    const session = await dr.api.uploads.create(as(who), {
      tenantId: TENANT,
      ...(input.parentId ? { parentId: input.parentId } : {}),
      ...(input.documentId ? { documentId: input.documentId } : {}),
      filename: input.filename,
      size: input.content.byteLength,
      sha256: sha256(input.content),
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    });
    if (session.multipart) {
      const order = Array.from({ length: session.parts }, (_, i) => i + 1).reverse();
      for (const part of order) {
        const start = (part - 1) * session.partSize;
        await dr.files.upload(as(who), {
          tenantId: TENANT,
          uploadId: session.uploadId,
          part,
          body: input.content.subarray(start, start + session.partSize),
        });
      }
    } else
      await dr.files.upload(as(who), {
        tenantId: TENANT,
        uploadId: session.uploadId,
        body: input.content,
      });
    return dr.api.uploads.complete(as(who), { tenantId: TENANT, uploadId: session.uploadId });
  }

  async function download(url: string, range?: string) {
    const token = url.split('/files/')[1]!;
    const response = await dr.files.serve(token, range ? { range } : {});
    return { response, body: new Uint8Array(await response.arrayBuffer()) };
  }

  /** A room owned by alice, with bob in a "Buyers" group holding `view` on the whole room. */
  async function room(name = 'Project Falcon') {
    const created = await dr.api.rooms.create(as('alice'), { tenantId: TENANT, name });
    return created;
  }

  return { dr, iam, database, storage, clock, principals, bytes, sha256, upload, download, room };
}
