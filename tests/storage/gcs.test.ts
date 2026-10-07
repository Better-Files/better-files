import { createHash, createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { storageConformanceCases } from '@better-files/core/conformance';
import { createBetterFilesClient } from '@better-files/client';
import { gcsStorage, serviceAccountTokens } from '@better-files/storage-gcs';
import { as, fixture, TENANT } from '../fixtures.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const serviceAccount = {
  client_email: 'better-files@project.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};

const rfc3986 = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/**
 * An in-memory Cloud Storage: the JSON API (media upload, metadata, download with ranges, delete, list, compose with
 * generation preconditions, multi-call rewrite), the OAuth token endpoint (verifying the JWT), and the XML API for
 * V4 signed URLs (verifying the signature from the request it receives).
 */
function fakeGcs(options: { pageSize?: number; failOnce?: boolean } = {}) {
  const objects = new Map<string, { bytes: Uint8Array; generation: string }>();
  const stats = { tokens: 0, composes: 0, retried: 0, rewrites: 0 };
  let generation = 1000;
  let failNext = options.failOnce ?? false;
  const write = (name: string, bytes: Uint8Array) => {
    const object = { bytes, generation: String(++generation) };
    objects.set(name, object);
    return object;
  };
  const resource = (name: string, o: { bytes: Uint8Array; generation: string }) =>
    Response.json({
      name,
      size: String(o.bytes.byteLength),
      generation: o.generation,
      etag: `E${o.generation}`,
    });
  const notFound = () =>
    Response.json({ error: { code: 404, errors: [{ reason: 'notFound' }] } }, { status: 404 });

  function verifySignedUrl(method: string, url: URL, headers: Headers): boolean {
    const signature = url.searchParams.get('X-Goog-Signature');
    if (!signature || url.searchParams.get('X-Goog-Algorithm') !== 'GOOG4-RSA-SHA256') return false;
    const signedHeaders = url.searchParams.get('X-Goog-SignedHeaders')!.split(';');
    const query = [...url.searchParams.entries()]
      .filter(([name]) => name !== 'X-Goog-Signature')
      .map(([n, v]) => `${rfc3986(n)}=${rfc3986(v)}`)
      .sort()
      .join('&');
    const canonical = [
      method,
      url.pathname,
      query,
      signedHeaders.map((h) => `${h}:${h === 'host' ? url.host : headers.get(h)}\n`).join(''),
      signedHeaders.join(';'),
      'UNSIGNED-PAYLOAD',
    ].join('\n');
    const date = url.searchParams.get('X-Goog-Date')!;
    const toSign = [
      'GOOG4-RSA-SHA256',
      date,
      url.searchParams.get('X-Goog-Credential')!.split('/').slice(1).join('/'),
      createHash('sha256').update(canonical).digest('hex'),
    ].join('\n');
    return createVerify('RSA-SHA256').update(toSign).verify(publicKey, signature, 'hex');
  }

  const handler = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    const body = init.body
      ? new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer())
      : undefined;

    if (url.host === 'oauth2.googleapis.com') {
      const form = new URLSearchParams(new TextDecoder().decode(body));
      const [header, claims, signature] = form.get('assertion')!.split('.');
      const valid = createVerify('RSA-SHA256')
        .update(`${header}.${claims}`)
        .verify(publicKey, Buffer.from(signature!, 'base64url'));
      const parsed = JSON.parse(Buffer.from(claims!, 'base64url').toString());
      if (!valid || parsed.iss !== serviceAccount.client_email)
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      stats.tokens++;
      return Response.json({ access_token: 'ya29.test', expires_in: 3600 });
    }

    const segments = url.pathname.split('/').slice(1).map(decodeURIComponent);
    // XML API, signed URLs only: /{bucket}/{object...}
    if (segments[0] === 'rooms') {
      if (!verifySignedUrl(method, url, headers)) return new Response('<Error/>', { status: 403 });
      const name = segments.slice(1).join('/');
      if (method === 'PUT') {
        const object = write(name, body ?? new Uint8Array());
        return new Response(null, { headers: { etag: `"md5-${object.generation}"` } });
      }
      const found = objects.get(name);
      return found ? new Response(found.bytes as BodyInit) : new Response(null, { status: 404 });
    }

    if (headers.get('authorization') !== 'Bearer ya29.test')
      return Response.json({ error: { code: 401 } }, { status: 401 });
    if (failNext) {
      failNext = false;
      stats.retried++;
      return Response.json({ error: { code: 503 } }, { status: 503 });
    }

    // /upload/storage/v1/b/{bucket}/o
    if (segments[0] === 'upload') {
      if (url.searchParams.get('uploadType') !== 'media')
        return new Response(null, { status: 400 });
      if (Number(headers.get('content-length')) !== body!.byteLength)
        return new Response(null, { status: 400 });
      const name = url.searchParams.get('name')!;
      return resource(name, write(name, body!));
    }
    // /storage/v1/b/{bucket}/o[/{object}[/compose | /rewriteTo/b/{bucket}/o/{object}]]
    const [, , , bucket, , object, action, , , , target] = segments;
    if (bucket !== 'rooms') return notFound();
    if (object === undefined) {
      const prefix = url.searchParams.get('prefix') ?? '';
      const names = [...objects.keys()].filter((n) => n.startsWith(prefix)).sort();
      const start = Number(url.searchParams.get('pageToken') ?? 0);
      const size = options.pageSize ?? 1000;
      const page = names.slice(start, start + size);
      return Response.json({
        items: page.map((name) => ({ name })),
        ...(start + size < names.length ? { nextPageToken: String(start + size) } : {}),
      });
    }
    if (action === 'compose') {
      stats.composes++;
      const request = JSON.parse(new TextDecoder().decode(body)) as {
        sourceObjects: { name: string; objectPreconditions?: { ifGenerationMatch: string } }[];
      };
      if (request.sourceObjects.length > 32) return new Response(null, { status: 400 });
      const parts: Uint8Array[] = [];
      for (const source of request.sourceObjects) {
        const found = objects.get(source.name);
        if (!found) return notFound();
        const expected = source.objectPreconditions?.ifGenerationMatch;
        if (expected && expected !== found.generation)
          return Response.json({ error: { code: 412 } }, { status: 412 });
        parts.push(found.bytes);
      }
      return resource(object, write(object, Buffer.concat(parts)));
    }
    if (action === 'rewriteTo') {
      const found = objects.get(object);
      if (!found) return notFound();
      // Answer "not done yet" first, as GCS does for large copies.
      if (!url.searchParams.get('rewriteToken')) {
        stats.rewrites++;
        return Response.json({ done: false, rewriteToken: 'continue' });
      }
      return Response.json({
        done: true,
        resource: await resource(target!, write(target!, found.bytes)).json(),
      });
    }
    const found = objects.get(object);
    if (method === 'DELETE') {
      if (!found) return notFound();
      objects.delete(object);
      return new Response(null, { status: 204 });
    }
    if (!found) return notFound();
    if (url.searchParams.get('alt') !== 'media') return resource(object, found);
    const range = /^bytes=(\d+)-(\d*)$/.exec(headers.get('range') ?? '');
    const slice = range
      ? found.bytes.subarray(Number(range[1]), range[2] ? Number(range[2]) + 1 : undefined)
      : found.bytes;
    return new Response(slice as BodyInit, { status: range ? 206 : 200 });
  };
  return { fetch: handler as typeof fetch, objects, stats };
}

const create = (fake = fakeGcs({ pageSize: 2 }), prefix?: string) =>
  gcsStorage({
    bucket: 'rooms',
    credentials: { serviceAccount },
    endpoint: 'http://gcs.test',
    fetch: fake.fetch,
    ...(prefix ? { prefix } : {}),
  });

describe('gcs storage conformance', () => {
  for (const testCase of storageConformanceCases()) it(testCase.name, () => testCase.run(create()));
  it('passes with an access token and a key prefix', async () => {
    for (const testCase of storageConformanceCases()) {
      const fake = fakeGcs();
      await testCase.run(
        gcsStorage({
          bucket: 'rooms',
          credentials: { accessToken: async () => 'ya29.test' },
          endpoint: 'http://gcs.test',
          prefix: 'app-one/',
          fetch: fake.fetch,
        }),
      );
      expect([...fake.objects.keys()].every((name) => name.startsWith('app-one/'))).toBe(true);
    }
  });
});

describe('gcs storage', () => {
  it('mints one service-account token and reuses it until it nears expiry', async () => {
    const fake = fakeGcs();
    let now = Date.UTC(2026, 9, 3);
    const tokens = serviceAccountTokens(serviceAccount, { fetch: fake.fetch, now: () => now });
    expect(await Promise.all([tokens(), tokens(), tokens()])).toEqual(Array(3).fill('ya29.test'));
    expect(fake.stats.tokens).toBe(1);
    now += 58 * 60_000;
    await tokens();
    expect(fake.stats.tokens).toBe(1);
    now += 2 * 60_000;
    await tokens();
    expect(fake.stats.tokens).toBe(2);
  });

  it('composes many parts in rounds of 32 and removes the temporary parts', async () => {
    const fake = fakeGcs({ pageSize: 7 });
    const storage = create(fake);
    const { uploadId } = await storage.multipart!.create('t1/many');
    const parts = await Promise.all(
      Array.from({ length: 70 }, async (_, i) => ({
        part: i + 1,
        etag: (await storage.multipart!.uploadPart('t1/many', uploadId, i + 1, new Uint8Array([i])))
          .etag,
      })),
    );
    const done = await storage.multipart!.complete('t1/many', uploadId, parts.reverse());
    expect(done.size).toBe(70);
    const bytes = new Uint8Array(await new Response(await storage.get('t1/many')).arrayBuffer());
    expect([...bytes]).toEqual(Array.from({ length: 70 }, (_, i) => i));
    // 70 parts: three intermediate composes, then one final compose.
    expect(fake.stats.composes).toBe(4);
    expect([...fake.objects.keys()]).toEqual(['t1/many']);
  });

  it('refuses to complete when a part was replaced after it was uploaded', async () => {
    const storage = create();
    const { uploadId } = await storage.multipart!.create('t1/swap');
    const one = await storage.multipart!.uploadPart('t1/swap', uploadId, 1, new Uint8Array([1]));
    await storage.multipart!.uploadPart('t1/swap', uploadId, 1, new Uint8Array([9]));
    await expect(
      storage.multipart!.complete('t1/swap', uploadId, [{ part: 1, etag: one.etag }]),
    ).rejects.toThrow(/412/);
  });

  it('keeps keys and upload ids out of the multipart namespace', async () => {
    const storage = create();
    await expect(
      storage.put('.better-files-multipart/x/00001', new Uint8Array(1)),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      storage.multipart!.uploadPart('t1/a', '../../other', 1, new Uint8Array(1)),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('retries throttled and failed requests, and follows multi-call rewrites', async () => {
    const fake = fakeGcs({ failOnce: true });
    const storage = create(fake);
    await storage.put('t1/src', new TextEncoder().encode('copy me'));
    expect(fake.stats.retried).toBe(1);
    const copied = await storage.copy!('t1/src', 't1/dst');
    expect(copied).toMatchObject({ key: 't1/dst', size: 7 });
    expect(fake.stats.rewrites).toBe(1);
  });

  it('signs V4 URLs that the XML API accepts, and only with a service account', async () => {
    const fake = fakeGcs();
    const storage = create(fake);
    const put = await storage.presign!('t1/signed (1) file.bin', {
      method: 'PUT',
      expiresInSeconds: 300,
    });
    expect(new URL(put).searchParams.get('X-Goog-Expires')).toBe('300');
    // The canonical path is RFC 3986-encoded, as @google-cloud/storage signs it.
    expect(new URL(put).pathname).toBe('/rooms/t1/signed%20%281%29%20file.bin');
    expect((await fake.fetch(put, { method: 'PUT', body: new Uint8Array([1, 2, 3]) })).status).toBe(
      200,
    );
    const get = await storage.presign!('t1/signed (1) file.bin', {
      method: 'GET',
      expiresInSeconds: 60,
    });
    expect([...new Uint8Array(await (await fake.fetch(get)).arrayBuffer())]).toEqual([1, 2, 3]);
    const tampered = get.replace('X-Goog-Expires=60', 'X-Goog-Expires=6000');
    expect((await fake.fetch(tampered)).status).toBe(403);

    const tokenOnly = gcsStorage({ bucket: 'rooms', credentials: { accessToken: 't' } });
    expect(tokenOnly.presign).toBeUndefined();
    expect(tokenOnly.multipart!.presignPart).toBeUndefined();
  });

  it('serves a data room end to end, including direct uploads from the browser', async () => {
    const fake = fakeGcs();
    const f = await fixture({ storageAdapter: create(fake) });
    const room = await f.room();
    const fetch = (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      return url.startsWith('http://gcs.test')
        ? fake.fetch(input, init)
        : f.dr.handler(new Request(input, init));
    };
    const client = createBetterFilesClient<typeof f.dr>({
      baseURL: 'http://app.test',
      tenantId: TENANT,
      headers: () => ({ authorization: 'Bearer alice' }),
      fetch,
    });
    for (const direct of [false, true]) {
      const content = f.bytes(200_000, direct ? 5 : 6);
      const result = await client.upload({
        parentId: room.rootNodeId,
        file: new Blob([content]),
        filename: `gcs-${direct}.bin`,
        direct,
      });
      const ticket = await f.dr.api.documents.requestOriginal(as('alice'), {
        tenantId: TENANT,
        nodeId: result.document.id,
      });
      const downloaded = await f.download(ticket.url);
      expect(f.sha256(downloaded.body)).toBe(f.sha256(content));
    }
    // No temporary part objects are left behind.
    expect(
      [...fake.objects.keys()].some((name) => name.startsWith('.better-files-multipart/')),
    ).toBe(false);
  });
});
