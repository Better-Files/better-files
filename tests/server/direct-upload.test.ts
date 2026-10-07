import { describe, expect, it } from 'vitest';
import { createBetterFilesClient, type DirectEncryption } from '@better-files/client';
import { s3Storage } from '@better-files/storage-s3';
import { as, fixture, TENANT } from '../fixtures.js';

async function setup() {
  const f = await fixture();
  const room = await f.room();
  // The browser talks to two hosts: the app (the protocol) and the object store (presigned part URLs).
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    return url.startsWith('memory://')
      ? f.storage.fetch(input, init)
      : f.dr.handler(new Request(input, init));
  };
  const client = createBetterFilesClient<typeof f.dr>({
    baseURL: 'http://app.test',
    tenantId: TENANT,
    headers: () => ({ authorization: 'Bearer alice' }),
    fetch,
  });
  return { f, room, client, fetch };
}

describe('direct uploads', () => {
  it('encrypts in the client, uploads parts straight to storage, and stores a normal encrypted file', async () => {
    const { f, room, client } = await setup();
    const content = f.bytes(200_000, 11); // four 64 KiB parts in the fixture
    const seen: number[] = [];
    const result = await client.upload({
      parentId: room.rootNodeId,
      file: new Blob([content]),
      filename: 'better-files-export.bin',
      direct: true,
      concurrency: 2,
      onProgress: (p) => seen.push(p.ratio),
    });
    expect(result.version.number).toBe(1);
    expect(seen.at(-1)).toBe(1);

    // What is stored is ciphertext, not the file.
    const stored = [...f.storage.objects.values()].find(
      (bytes) => bytes.byteLength === 200_000 + 4 * 16,
    );
    expect(stored).toBeDefined();
    expect(Buffer.from(stored!.subarray(0, 64)).equals(Buffer.from(content.subarray(0, 64)))).toBe(
      false,
    );

    // It downloads through the ordinary path, decrypted and byte-identical.
    const ticket = await f.dr.api.documents.requestOriginal(as('alice'), {
      tenantId: TENANT,
      nodeId: result.document.id,
    });
    const downloaded = await f.download(ticket.url);
    expect(f.sha256(downloaded.body)).toBe(f.sha256(content));
    const [version] = await f.dr.api.versions.list(as('alice'), {
      tenantId: TENANT,
      nodeId: result.document.id,
    });
    expect(version!.sha256).toBe(f.sha256(content));
  });

  it('refuses parts that do not decrypt and discards them', async () => {
    const { f, room, fetch } = await setup();
    const content = f.bytes(1000, 3);
    const session = (await f.dr.api.uploads.create(as('alice'), {
      tenantId: TENANT,
      parentId: room.rootNodeId,
      filename: 'forged.bin',
      size: content.byteLength,
      direct: true,
    })) as {
      uploadId: string;
      direct: { parts: { part: number; url: string }[]; encryption: DirectEncryption };
    };
    expect(session.direct.encryption).toMatchObject({
      algorithm: 'AES-256-GCM-STREAM',
      segmentSize: 65_536,
    });
    // Right size, wrong bytes: as if encrypted with another key.
    const put = await fetch(session.direct.parts[0]!.url, {
      method: 'PUT',
      body: f.bytes(1016, 9) as BodyInit,
    });
    const etag = put.headers.get('etag')!;
    await expect(
      f.dr.api.uploads.complete(as('alice'), {
        tenantId: TENANT,
        uploadId: session.uploadId,
        parts: [{ part: 1, etag }],
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('integrity'),
    });
    expect(
      (await f.dr.api.rooms.index(as('alice'), { tenantId: TENANT, roomId: room.id })).map(
        (n) => n.name,
      ),
    ).toEqual([]);
  });

  it('needs a storage adapter with presigned parts', async () => {
    const { f, room } = await setup();
    delete (f.storage.multipart as { presignPart?: unknown }).presignPart;
    await expect(
      f.dr.api.uploads.create(as('alice'), {
        tenantId: TENANT,
        parentId: room.rootNodeId,
        filename: 'x.bin',
        size: 10,
        direct: true,
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('presigns S3 part uploads', async () => {
    const storage = s3Storage({
      bucket: 'rooms',
      region: 'us-east-1',
      endpoint: 'http://s3.test',
      credentials: { accessKeyId: 'AKID', secretAccessKey: 'secret' },
    });
    const url = new URL(
      await storage.multipart!.presignPart!('t1/blob', 'UPLOAD-1', 3, { expiresInSeconds: 600 }),
    );
    expect(url.searchParams.get('partNumber')).toBe('3');
    expect(url.searchParams.get('uploadId')).toBe('UPLOAD-1');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });
});
