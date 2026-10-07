import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '@better-files/core';
import { createBetterFilesClient } from '@better-files/client';
import { postgresAdapter } from '@better-files/adapter-postgres';
import { memoryDatabase } from '@better-files/testing';
import { as, fixture, TENANT } from '../fixtures.js';
import { ensureBucket, postgresUrl, realS3, s3Configured } from '../docker/services.js';

/**
 * The whole file path on real infrastructure: PostgreSQL when `BETTER_FILES_POSTGRES_URL` is set, and an S3-compatible
 * store (`BETTER_FILES_S3_ENDPOINT`, MinIO in tests/docker/compose.yml). The rest of the suite uses fakes, which can't
 * show that S3 accepts our signatures, part sizes and presigned URLs.
 */

// S3 refuses multipart parts under 5 MiB (except the last); the server's part size must respect that.
const PART = 5 * 1024 * 1024;
// One full part plus a partial one that ends mid-segment.
const SIZE = PART + 300_000;

const databases: DatabaseAdapter[] = [];
afterAll(async () => {
  for (const db of databases) await db.close?.();
});

async function setup() {
  const database = postgresUrl
    ? postgresAdapter({ connectionString: postgresUrl })
    : memoryDatabase();
  databases.push(database);
  const storage = realS3('engine');
  const f = await fixture({
    database,
    storageAdapter: storage,
    partSize: PART,
    // A table prefix per run, so repeated runs against a long-lived database never see each other's rows.
    schema: { tablePrefix: `dr_${Date.now().toString(36)}_` },
  });
  const room = await f.room();
  /** The stored object behind a version, read straight from the database. */
  async function storedObject(versionId: string) {
    const version = await database.findOne<{ blobId: string }>('versions', {
      tenantId: TENANT,
      id: versionId,
    });
    const blob = await database.findOne<{ storageKey: string; size: number }>('blobs', {
      tenantId: TENANT,
      id: version!.blobId,
    });
    return blob!;
  }
  return { f, room, storage, storedObject };
}

describe.skipIf(!s3Configured)(
  `real services (${postgresUrl ? 'postgres' : 'memory database'} + s3)`,
  () => {
    beforeAll(ensureBucket);

    it('uploads through the server in S3-sized parts, then streams whole files and ranges back', async () => {
      const { f, room, storage, storedObject } = await setup();
      const content = f.bytes(SIZE, 7);
      const result = await f.upload('alice', {
        parentId: room.rootNodeId,
        filename: 'model.xlsx',
        content,
      });

      // Stored as ciphertext: plaintext plus a 16-byte tag per 64 KiB segment.
      const blob = await storedObject(result.version.id);
      const head = await storage.head(blob.storageKey);
      expect(head?.size).toBe(SIZE + Math.ceil(SIZE / 65_536) * 16);

      const ticket = await f.dr.api.documents.requestOriginal(as('alice'), {
        tenantId: TENANT,
        nodeId: result.document.id,
      });
      const whole = await f.download(ticket.url);
      expect(f.sha256(whole.body)).toBe(f.sha256(content));

      // A range across the part boundary and several segment boundaries decrypts only what it needs.
      const start = PART - 70_000;
      const end = PART + 70_000;
      const again = await f.dr.api.documents.requestOriginal(as('alice'), {
        tenantId: TENANT,
        nodeId: result.document.id,
      });
      const ranged = await f.download(again.url, `bytes=${start}-${end}`);
      expect(ranged.response.status).toBe(206);
      expect(Buffer.from(ranged.body).equals(Buffer.from(content.subarray(start, end + 1)))).toBe(
        true,
      );
    }, 120_000);

    it('accepts browser-encrypted parts sent straight to presigned S3 URLs', async () => {
      const { f, room } = await setup();
      // The client talks to the app through the handler and to S3 over the network, as a browser would.
      const client = createBetterFilesClient<typeof f.dr>({
        baseURL: 'http://app.test',
        tenantId: TENANT,
        headers: () => ({ authorization: 'Bearer alice' }),
        fetch: (input, init) => {
          const url = input instanceof Request ? input.url : String(input);
          return url.startsWith('http://app.test')
            ? f.dr.handler(new Request(input, init))
            : fetch(input, init);
        },
      });
      const content = f.bytes(SIZE, 13);
      const result = await client.upload({
        parentId: room.rootNodeId,
        file: new Blob([content]),
        filename: 'direct.bin',
        direct: true,
        concurrency: 2,
      });
      const ticket = await f.dr.api.documents.requestOriginal(as('alice'), {
        tenantId: TENANT,
        nodeId: result.document.id,
      });
      expect(f.sha256((await f.download(ticket.url)).body)).toBe(f.sha256(content));
    }, 120_000);

    it('refuses to serve an object that was altered in the bucket', async () => {
      const { f, room, storage, storedObject } = await setup();
      const content = f.bytes(200_000, 21);
      const result = await f.upload('alice', {
        parentId: room.rootNodeId,
        filename: 'board-minutes.pdf',
        content,
      });
      const blob = await storedObject(result.version.id);
      const stored = new Uint8Array(
        await new Response(await storage.get(blob.storageKey)).arrayBuffer(),
      );
      stored[100] = stored[100]! ^ 0xff;
      await storage.put(blob.storageKey, stored);

      const ticket = await f.dr.api.documents.requestOriginal(as('alice'), {
        tenantId: TENANT,
        nodeId: result.document.id,
      });
      await expect(f.download(ticket.url)).rejects.toThrow();
    }, 120_000);
  },
);
