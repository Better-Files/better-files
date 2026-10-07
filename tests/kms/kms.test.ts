import { describe, expect, it } from 'vitest';
import type { KeyProvider } from '@better-files/core';
import { localKeyProvider } from '@better-files/crypto';
import { regionalStorage } from '@better-files/storage-regional';
import { memoryStorage } from '@better-files/testing';
import {
  awsKms,
  azureKeyVault,
  cachingKeys,
  gcpKms,
  migratingKeys,
  regionalKeys,
  vaultTransit,
  type KmsKeyProvider,
} from '@better-files/kms';
import { as, fixture, SECRET, TENANT } from '../fixtures.js';
import {
  AZURE_VAULT,
  fakeAwsKms,
  fakeAzureKeyVault,
  fakeGcpKms,
  fakeVaultTransit,
  GCP_RING,
  VAULT_ADDRESS,
} from './fakes.js';

const credentials = { accessKeyId: 'AKID', secretAccessKey: 'secret' };
const context = { tenantId: TENANT, roomId: 'room_1', blobId: 'blob_1' };

function providers() {
  const aws = fakeAwsKms();
  const gcp = fakeGcpKms();
  const azure = fakeAzureKeyVault();
  const vault = fakeVaultTransit();
  return [
    {
      name: 'AWS KMS',
      fake: aws,
      make: (perRoomKeys = false) =>
        awsKms({
          region: 'eu-west-1',
          keyId: 'alias/better-files',
          credentials,
          fetch: aws.fetch,
          perRoomKeys,
        }),
    },
    {
      name: 'Cloud KMS',
      fake: gcp,
      make: (perRoomKeys = false) =>
        gcpKms({
          keyName: `${GCP_RING}/cryptoKeys/default`,
          accessToken: async () => 'gcp-token',
          fetch: gcp.fetch,
          perRoomKeys,
        }),
    },
    {
      name: 'Azure Key Vault',
      fake: azure,
      make: (perRoomKeys = false) =>
        azureKeyVault({
          vaultUrl: AZURE_VAULT,
          keyName: 'better-files',
          accessToken: 'azure-token',
          fetch: azure.fetch,
          perRoomKeys,
        }),
    },
    {
      name: 'Vault Transit',
      fake: vault,
      make: (perRoomKeys = false) =>
        vaultTransit({
          address: VAULT_ADDRESS,
          token: 'hvs.token',
          keyName: 'better-files',
          fetch: vault.fetch,
          perRoomKeys,
        }),
    },
  ];
}

const equal = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

describe.each(providers())('$name', ({ make, fake }) => {
  it('wraps data keys and unwraps them only with the same encryption context', async () => {
    const keys = make();
    const generated = await keys.generateDataKey({ tenantId: TENANT, context });
    expect(generated.plaintext.byteLength).toBe(32);
    expect(keys.owns(generated.keyRef)).toBe(true);
    expect(generated.wrapped).not.toContain(Buffer.from(generated.plaintext).toString('base64'));

    const again = await keys.decryptDataKey({
      tenantId: TENANT,
      keyRef: generated.keyRef,
      wrapped: generated.wrapped,
      context,
    });
    expect(equal(again, generated.plaintext)).toBe(true);

    // Another blob's context must not yield this blob's key.
    const other = await keys
      .decryptDataKey({
        tenantId: TENANT,
        keyRef: generated.keyRef,
        wrapped: generated.wrapped,
        context: { ...context, blobId: 'blob_2' },
      })
      .catch(() => undefined);
    expect(other && equal(other, generated.plaintext)).toBeFalsy();
  });

  it('encrypts files end to end, with a key per room that is retired when the room is deleted', async () => {
    const f = await fixture({ keys: make(true) });
    const room = await f.room();
    const content = f.bytes(200_000, 7);
    const { document } = await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'model.xlsx',
      content,
    });
    const ticket = await f.dr.api.documents.requestOriginal(as('alice'), {
      tenantId: TENANT,
      nodeId: document.id,
    });
    expect(equal((await f.download(ticket.url)).body, content)).toBe(true);

    const call = { tenantId: TENANT, roomId: room.id };
    await f.dr.api.rooms.publish(as('alice'), call);
    await f.dr.api.rooms.close(as('alice'), call);
    await f.dr.api.rooms.archive(as('alice'), call);
    const before = fake.requests.length;
    await f.dr.api.rooms.delete(as('alice'), { ...call, confirmName: 'Project Falcon' });
    expect(fake.requests.length).toBeGreaterThan(before);
  });
});

describe('AWS KMS', () => {
  it('signs for the kms service, sends the context and retries throttling', async () => {
    const fake = fakeAwsKms();
    const keys = awsKms({
      region: 'eu-west-1',
      keyId: 'alias/better-files',
      credentials,
      fetch: fake.fetch,
    });
    fake.failNext({ status: 400, body: { __type: 'ThrottlingException', message: 'slow down' } });
    await keys.generateDataKey({ tenantId: TENANT, context });
    expect(fake.requests).toHaveLength(2);
    const sent = fake.requests[1]!;
    expect(sent.headers.get('x-amz-target')).toBe('TrentService.GenerateDataKey');
    expect(sent.headers.get('authorization')).toMatch(/SignedHeaders=.*x-amz-target/);
    expect(sent.body).toEqual({
      KeyId: 'alias/better-files',
      KeySpec: 'AES_256',
      EncryptionContext: context,
    });
  });

  it('reports KMS errors with their code and does not retry them', async () => {
    const fake = fakeAwsKms();
    const keys = awsKms({
      region: 'eu-west-1',
      keyId: 'alias/missing',
      credentials,
      fetch: fake.fetch,
    });
    await expect(keys.generateDataKey({ tenantId: TENANT, context })).rejects.toMatchObject({
      kmsCode: 'NotFoundException',
      status: 400,
    });
    expect(fake.requests).toHaveLength(1);
  });

  it('tolerates retiring a room key twice', async () => {
    const fake = fakeAwsKms();
    const keys = awsKms({
      region: 'eu-west-1',
      keyId: 'alias/better-files',
      credentials,
      fetch: fake.fetch,
      perRoomKeys: true,
    });
    const keyRef = await keys.createRoomKey!({ tenantId: TENANT, roomId: 'room_1' });
    expect(fake.requests[0]!.body.Tags).toContainEqual({ TagKey: 'roomId', TagValue: 'room_1' });
    await keys.retireRoomKey!({ tenantId: TENANT, roomId: 'room_1', keyRef });
    await keys.retireRoomKey!({ tenantId: TENANT, roomId: 'room_1', keyRef });
    await expect(keys.generateDataKey({ tenantId: TENANT, keyRef, context })).rejects.toMatchObject(
      {
        kmsCode: 'KMSInvalidStateException',
      },
    );
  });
});

describe('Azure Key Vault', () => {
  it('unwraps with the key version that wrapped, after rotation', async () => {
    const fake = fakeAzureKeyVault();
    const keys = azureKeyVault({
      vaultUrl: AZURE_VAULT,
      keyName: 'better-files',
      accessToken: 'azure-token',
      fetch: fake.fetch,
    });
    const before = await keys.generateDataKey({ tenantId: TENANT, context });
    fake.rotate('better-files');
    const after = await keys.generateDataKey({ tenantId: TENANT, context });
    expect(after.keyRef).not.toBe(before.keyRef);
    const again = await keys.decryptDataKey({ tenantId: TENANT, ...before, context });
    expect(equal(again, before.plaintext)).toBe(true);
  });

  it('never sends its token to a host named in a tampered key reference', async () => {
    const fake = fakeAzureKeyVault();
    const keys = azureKeyVault({
      vaultUrl: AZURE_VAULT,
      keyName: 'better-files',
      accessToken: 'azure-token',
      fetch: fake.fetch,
    });
    await expect(
      keys.decryptDataKey({
        tenantId: TENANT,
        keyRef: 'azure-kv:https://attacker.test/keys/better-files',
        wrapped: 'x',
        context,
      }),
    ).rejects.toThrow(/outside this vault/);
    expect(fake.requests).toHaveLength(0);
  });
});

describe('Cloud KMS', () => {
  it('keeps key references inside the configured key ring', async () => {
    const fake = fakeGcpKms();
    const keys = gcpKms({
      keyName: `${GCP_RING}/cryptoKeys/default`,
      accessToken: 'gcp-token',
      fetch: fake.fetch,
    });
    await expect(
      keys.decryptDataKey({
        tenantId: TENANT,
        keyRef: 'gcp-kms:projects/other/locations/x/keyRings/y/cryptoKeys/z',
        wrapped: 'x',
        context,
      }),
    ).rejects.toThrow(/outside the key ring/);
    expect(fake.requests).toHaveLength(0);
  });

  it('destroys every version of a retired room key, and reuses a key left by a retried creation', async () => {
    const fake = fakeGcpKms();
    const keys = gcpKms({
      keyName: `${GCP_RING}/cryptoKeys/default`,
      accessToken: 'gcp-token',
      fetch: fake.fetch,
      perRoomKeys: true,
    });
    const keyRef = await keys.createRoomKey!({ tenantId: TENANT, roomId: 'room_1' });
    expect(await keys.createRoomKey!({ tenantId: TENANT, roomId: 'room_1' })).toBe(keyRef);
    await keys.retireRoomKey!({ tenantId: TENANT, roomId: 'room_1', keyRef });
    expect(fake.keys.get(`${GCP_RING}/cryptoKeys/better-files-room-1`)!.versions[0]!.state).toBe(
      'DESTROY_SCHEDULED',
    );
  });
});

describe('Vault Transit', () => {
  it('allows deletion before deleting a retired room key, and never deletes the shared key', async () => {
    const fake = fakeVaultTransit();
    const keys = vaultTransit({
      address: VAULT_ADDRESS,
      token: 'hvs.token',
      keyName: 'better-files',
      fetch: fake.fetch,
      perRoomKeys: true,
    });
    const keyRef = await keys.createRoomKey!({ tenantId: TENANT, roomId: 'room_9' });
    expect(fake.keys.has('better-files-room-9')).toBe(true);
    await keys.retireRoomKey!({ tenantId: TENANT, roomId: 'room_9', keyRef });
    expect(fake.keys.has('better-files-room-9')).toBe(false);
    await keys.retireRoomKey!({ tenantId: TENANT, roomId: 'x', keyRef: 'vault:better-files' });
    expect(fake.keys.has('better-files')).toBe(true);
  });
});

describe('migratingKeys', () => {
  it('reads files wrapped by the old provider and wraps new ones with the new provider', async () => {
    const fake = fakeAwsKms();
    const local = localKeyProvider({ secret: SECRET });
    const aws = awsKms({
      region: 'eu-west-1',
      keyId: 'alias/better-files',
      credentials,
      fetch: fake.fetch,
    });

    // The installation starts on the local provider and is then configured with the migrating one.
    let active: KeyProvider = local;
    const f = await fixture({
      keys: {
        id: 'switch',
        generateDataKey: (input) => active.generateDataKey(input),
        decryptDataKey: (input) => active.decryptDataKey(input),
      },
    });
    const room = await f.room();
    const oldContent = f.bytes(50_000, 1);
    const old = (
      await f.upload('alice', {
        parentId: room.rootNodeId,
        filename: 'old.pdf',
        content: oldContent,
      })
    ).document;

    active = migratingKeys({ current: aws, previous: [local] });
    const newContent = f.bytes(50_000, 2);
    const fresh = (
      await f.upload('alice', {
        parentId: room.rootNodeId,
        filename: 'new.pdf',
        content: newContent,
      })
    ).document;
    // One data key for the new file (completing the upload then reads it back with Decrypt).
    expect(
      fake.requests.filter((r) => r.headers.get('x-amz-target') === 'TrentService.GenerateDataKey'),
    ).toHaveLength(1);

    const read = async (nodeId: string) => {
      const ticket = await f.dr.api.documents.requestOriginal(as('alice'), {
        tenantId: TENANT,
        nodeId,
      });
      return (await f.download(ticket.url)).body;
    };
    expect(equal(await read(fresh.id), newContent)).toBe(true);
    expect(equal(await read(old.id), oldContent)).toBe(true);
  });

  it('routes decryption by key reference and tries providers that cannot tell', async () => {
    const calls: string[] = [];
    const opaque = (id: string, works: boolean): KeyProvider => ({
      id,
      async generateDataKey() {
        throw new Error('unused');
      },
      async decryptDataKey() {
        calls.push(id);
        if (!works) throw new Error(`${id} cannot`);
        return new Uint8Array(32).fill(id.length);
      },
    });
    const fake = fakeAwsKms();
    const aws = awsKms({
      region: 'eu-west-1',
      keyId: 'alias/better-files',
      credentials,
      fetch: fake.fetch,
    });
    const keys = migratingKeys({
      current: aws,
      previous: [opaque('a', false), opaque('bbb', true)],
    });
    const key = await keys.decryptDataKey({
      tenantId: TENANT,
      keyRef: 'kms-key-1',
      wrapped: 'w',
      context,
    });
    expect(calls).toEqual(['a', 'bbb']);
    expect(key[0]).toBe(3);
    expect(fake.requests).toHaveLength(0);
    expect(() => migratingKeys({ current: aws, previous: [aws] })).toThrow(/different ids/);
  });
});

describe('regionalKeys', () => {
  function setup(perRoomKeys: boolean) {
    const eu = fakeAwsKms('eu-central-1');
    const us = fakeAwsKms('us-east-1');
    const keys = regionalKeys({
      regions: {
        eu: awsKms({
          region: 'eu-central-1',
          keyId: 'alias/better-files',
          credentials,
          fetch: eu.fetch,
          perRoomKeys,
        }),
        us: awsKms({
          region: 'us-east-1',
          keyId: 'alias/better-files',
          credentials,
          fetch: us.fetch,
          perRoomKeys,
        }),
      },
      defaultRegion: 'eu',
    });
    return { eu, us, keys };
  }

  it("creates and uses each room's key in the room's region", async () => {
    const { eu, us, keys } = setup(true);
    const keyRef = await keys.createRoomKey!({ tenantId: TENANT, roomId: 'room_1', region: 'us' });
    expect(keyRef).toMatch(/^region:us:aws-kms:arn:aws:kms:us-east-1:/);
    const generated = await keys.generateDataKey({ tenantId: TENANT, keyRef, context });
    expect(generated.keyRef).toMatch(/^region:us:/);
    const again = await keys.decryptDataKey({ tenantId: TENANT, ...generated, context });
    expect(equal(again, generated.plaintext)).toBe(true);
    await keys.retireRoomKey!({ tenantId: TENANT, roomId: 'room_1', keyRef });
    expect(us.requests.map((r) => r.headers.get('x-amz-target'))).toEqual([
      'TrentService.CreateKey',
      'TrentService.GenerateDataKey',
      'TrentService.Decrypt',
      'TrentService.ScheduleKeyDeletion',
    ]);
    expect(eu.requests).toHaveLength(0);
  });

  it("records the region without keys per room, and uses the region's default key", async () => {
    const { eu, us, keys } = setup(false);
    const keyRef = await keys.createRoomKey!({ tenantId: TENANT, roomId: 'room_1', region: 'us' });
    expect(keyRef).toBe('region:us:');
    const generated = await keys.generateDataKey({ tenantId: TENANT, keyRef, context });
    expect(us.requests[0]!.body.KeyId).toBe('alias/better-files');
    expect(eu.requests).toHaveLength(0);
    // Rooms without a region, and references made before regionalKeys, belong to the default region.
    const plain = await keys.generateDataKey({ tenantId: TENANT, context });
    expect(plain.keyRef).toMatch(/^region:eu:/);
    expect(
      equal(
        await keys.decryptDataKey({ tenantId: TENANT, ...generated, context }),
        generated.plaintext,
      ),
    ).toBe(true);
  });

  it("keeps a room's files and keys in its region end to end, with regional storage", async () => {
    const { eu, us, keys } = setup(true);
    const storage = { eu: memoryStorage(), us: memoryStorage() };
    const f = await fixture({
      keys,
      storageAdapter: regionalStorage({ regions: storage, defaultRegion: 'eu' }),
    });
    const room = await f.dr.api.rooms.create(as('alice'), {
      tenantId: TENANT,
      name: 'Zurich deal',
      region: 'us',
    });
    const content = f.bytes(80_000, 3);
    const { document } = await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'cap-table.xlsx',
      content,
    });
    const ticket = await f.dr.api.documents.requestOriginal(as('alice'), {
      tenantId: TENANT,
      nodeId: document.id,
    });
    expect(equal((await f.download(ticket.url)).body, content)).toBe(true);
    expect(storage.us.objects.size).toBe(1);
    expect(storage.eu.objects.size).toBe(0);
    expect(us.requests.map((r) => r.headers.get('x-amz-target'))).toContain(
      'TrentService.CreateKey',
    );
    expect(eu.requests).toHaveLength(0);
  });

  it('refuses a room in a region without a provider instead of keying it elsewhere', async () => {
    const { eu, us, keys } = setup(true);
    await expect(
      keys.createRoomKey!({ tenantId: TENANT, roomId: 'room_1', region: 'apac' }),
    ).rejects.toThrow(/No key provider for the region "apac"/);
    expect(eu.requests.length + us.requests.length).toBe(0);
    expect(() => regionalKeys({ regions: {}, defaultRegion: 'eu' })).toThrow(/at least one region/);
    expect(() =>
      regionalKeys({ regions: { eu: localKeyProvider({ secret: SECRET }) }, defaultRegion: 'us' }),
    ).toThrow(/defaultRegion/);
  });
});

describe('cachingKeys', () => {
  it('serves repeated unwraps from memory, as copies, until they expire', async () => {
    const fake = fakeVaultTransit();
    let now = 0;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const keys: KmsKeyProvider & { clear(): void } = cachingKeys(
        vaultTransit({
          address: VAULT_ADDRESS,
          token: 'hvs.token',
          keyName: 'better-files',
          fetch: fake.fetch,
        }),
        { maxAgeMs: 1000 },
      );
      const generated = await keys.generateDataKey({ tenantId: TENANT, context });
      const input = {
        tenantId: TENANT,
        keyRef: generated.keyRef,
        wrapped: generated.wrapped,
        context,
      };
      const first = await keys.decryptDataKey(input);
      first.fill(0); // the caller zeroing its copy must not poison the cache
      const second = await keys.decryptDataKey(input);
      expect(equal(second, generated.plaintext)).toBe(true);
      expect(fake.requests.filter((r) => r.url.pathname.includes('/decrypt/'))).toHaveLength(1);
      expect(keys.owns(generated.keyRef)).toBe(true);
      now = 2000;
      await keys.decryptDataKey(input);
      expect(fake.requests.filter((r) => r.url.pathname.includes('/decrypt/'))).toHaveLength(2);
    } finally {
      Date.now = realNow;
    }
  });
});

describe('configuration', () => {
  it('refuses incomplete or unsafe options', () => {
    expect(() => gcpKms({ keyName: 'my-key', accessToken: 't' })).toThrow(/keyName/);
    expect(() =>
      azureKeyVault({ vaultUrl: 'http://acme.vault.azure.net', keyName: 'k', accessToken: 't' }),
    ).toThrow(/https/);
    expect(() => vaultTransit({ address: VAULT_ADDRESS, token: 't', keyName: '../sys' })).toThrow(
      /keyName/,
    );
    expect(() => awsKms({ region: '', keyId: 'k', credentials })).toThrow(/region/);
  });
});
