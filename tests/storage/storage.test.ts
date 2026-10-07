import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { storageConformanceCases } from '@better-files/core/conformance';
import type { StorageAdapter } from '@better-files/core';
import { memoryStorage } from '@better-files/testing';
import { fileStorage } from '@better-files/storage-fs';
import { presignUrl, s3Storage, signHeaders } from '@better-files/storage-s3';

const directory = mkdtempSync(join(tmpdir(), 'better-files-fs-'));
let counter = 0;
afterAll(() => {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {}
});

/** An in-memory S3 that checks every request is signed, for exercising the adapter's protocol handling. */
function fakeS3() {
  const objects = new Map<string, Uint8Array>();
  const uploads = new Map<string, Map<number, Uint8Array>>();
  let ids = 0;
  const handler = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    if (!headers.get('authorization')?.startsWith('AWS4-HMAC-SHA256 Credential=AKID/'))
      return new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 });
    const [, bucket, ...rest] = url.pathname.split('/');
    if (bucket !== 'rooms')
      return new Response('<Error><Code>NoSuchBucket</Code></Error>', { status: 404 });
    const key = rest.map(decodeURIComponent).join('/');
    const body = init.body
      ? new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer())
      : undefined;
    const method = init.method ?? 'GET';
    const uploadId = url.searchParams.get('uploadId');
    if (method === 'POST' && url.searchParams.has('uploads')) {
      const id = `up${++ids}`;
      uploads.set(id, new Map());
      return new Response(
        `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
      );
    }
    if (method === 'PUT' && uploadId) {
      uploads.get(uploadId)!.set(Number(url.searchParams.get('partNumber')), body!);
      return new Response(null, {
        headers: { etag: `"${uploadId}-${url.searchParams.get('partNumber')}"` },
      });
    }
    if (method === 'POST' && uploadId) {
      const xml = new TextDecoder().decode(body);
      const order = [...xml.matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((m) => Number(m[1]));
      const parts = order.map((n) => uploads.get(uploadId)!.get(n)!);
      const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
      let offset = 0;
      for (const part of parts) {
        out.set(part, offset);
        offset += part.byteLength;
      }
      objects.set(key, out);
      uploads.delete(uploadId);
      return new Response('<CompleteMultipartUploadResult></CompleteMultipartUploadResult>');
    }
    if (method === 'DELETE' && uploadId) {
      uploads.delete(uploadId);
      return new Response(null, { status: 204 });
    }
    if (method === 'PUT') {
      const source = headers.get('x-amz-copy-source');
      const bytes = source
        ? objects.get(decodeURIComponent(source.split('/').slice(2).join('/')))
        : body;
      if (!bytes) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
      if (!source && Number(headers.get('content-length')) !== bytes.byteLength)
        return new Response('<Error><Code>BadDigest</Code></Error>', { status: 400 });
      objects.set(key, bytes);
      return new Response(null, { status: 200, headers: { etag: '"x"' } });
    }
    const found = objects.get(key);
    if (method === 'DELETE') {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    if (!found)
      return new Response(method === 'HEAD' ? null : '<Error><Code>NoSuchKey</Code></Error>', {
        status: 404,
      });
    if (method === 'HEAD')
      return new Response(null, { headers: { 'content-length': String(found.byteLength) } });
    const range = /^bytes=(\d+)-(\d*)$/.exec(headers.get('range') ?? '');
    const slice = range
      ? found.subarray(Number(range[1]), range[2] ? Number(range[2]) + 1 : undefined)
      : found;
    return new Response(slice as unknown as BodyInit, { status: range ? 206 : 200 });
  };
  return handler as typeof fetch;
}

const adapters: [string, () => StorageAdapter][] = [
  ['memory', () => memoryStorage()],
  ['fs', () => fileStorage({ root: join(directory, `root-${++counter}`) })],
  [
    's3 (fake endpoint)',
    () =>
      s3Storage({
        bucket: 'rooms',
        region: 'us-east-1',
        endpoint: 'http://s3.test',
        credentials: { accessKeyId: 'AKID', secretAccessKey: 'secret' },
        fetch: fakeS3(),
      }),
  ],
];

for (const [name, create] of adapters)
  describe(`${name} storage conformance`, () => {
    for (const testCase of storageConformanceCases())
      it(testCase.name, () => testCase.run(create()));
  });

describe('file storage', () => {
  it('refuses keys that would escape the root', async () => {
    const storage = fileStorage({ root: join(directory, 'escape') });
    for (const key of ['../x', 'a/../../x', '/abs', 'a//b', 'a\\..\\b'])
      await expect(storage.put(key, new Uint8Array(1))).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
  });
});

describe('SigV4', () => {
  // The worked examples from the Amazon S3 documentation ("Signature Calculations for the Authorization Header").
  const credentials = {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  };
  const date = new Date('2013-05-24T00:00:00Z');

  it('matches the documented GET Object signature', () => {
    const authorization = signHeaders({
      method: 'GET',
      path: '/test.txt',
      headers: {
        host: 'examplebucket.s3.amazonaws.com',
        range: 'bytes=0-9',
        'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        'x-amz-date': '20130524T000000Z',
      },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      region: 'us-east-1',
      credentials,
      date,
    });
    expect(authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('matches the documented presigned URL', () => {
    const url = presignUrl({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      region: 'us-east-1',
      credentials,
      date,
      expiresInSeconds: 86400,
    });
    expect(url).toContain(
      'X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });
});
