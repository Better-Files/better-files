import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { storageConformanceCases } from '@better-files/core/conformance';
import { createBetterFilesClient } from '@better-files/client';
import {
  azureBlobStorage,
  blobSas,
  parseConnectionString,
  sharedKeyAuthorization,
} from '@better-files/storage-azure';
import { as, fixture, TENANT } from '../fixtures.js';

const ACCOUNT = 'acct';
const KEY = Buffer.from('a 32 byte test key for azure!!!!').toString('base64');

/**
 * An in-memory Blob service. Shared Key requests are checked against the signature computed from the request the
 * service actually receives (so a header the adapter signs but does not send, or the reverse, fails); SAS requests
 * are checked with a string-to-sign built here from the documented field order.
 */
function fakeAzure(options: { pendingCopies?: boolean; failOnce?: boolean } = {}) {
  const blobs = new Map<string, Uint8Array>();
  const staged = new Map<string, Map<string, Uint8Array>>();
  const copying = new Map<string, number>();
  const stats = { retried: 0, polls: 0 };
  let failNext = options.failOnce ?? false;
  const error = (status: number, code: string) =>
    new Response(status === 404 || status === 0 ? null : `<Error><Code>${code}</Code></Error>`, {
      status,
      headers: { 'x-ms-error-code': code },
    });

  function sasValid(url: URL, container: string, blob: string): boolean {
    const q = url.searchParams;
    const toSign = [
      q.get('sp'),
      q.get('st') ?? '',
      q.get('se'),
      `/blob/${ACCOUNT}/${container}/${blob}`,
      '',
      '',
      q.get('spr') ?? '',
      q.get('sv'),
      q.get('sr'),
      '',
      '',
      '',
      '',
      '',
      '',
      '',
    ].join('\n');
    const expected = createHmac('sha256', Buffer.from(KEY, 'base64'))
      .update(toSign)
      .digest('base64');
    return q.get('sig') === expected && new Date(q.get('se')!).getTime() > Date.now();
  }

  const handler = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    const body = init.body
      ? new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer())
      : new Uint8Array();
    // Path style (`http://host/acct/container/blob`, as Azurite) or virtual host style.
    const parts = url.pathname.split('/').slice(1);
    if (!url.host.startsWith(`${ACCOUNT}.`)) parts.shift();
    const [container, ...rest] = parts;
    const name = rest.map(decodeURIComponent).join('/');

    if (url.searchParams.has('sig')) {
      if (!sasValid(url, container!, name)) return error(403, 'AuthenticationFailed');
    } else {
      const received: Record<string, string> = {};
      headers.forEach((value, key) => (received[key] = value));
      delete received.authorization;
      const expected = sharedKeyAuthorization({
        account: ACCOUNT,
        accountKey: KEY,
        method,
        url,
        headers: received,
      });
      if (headers.get('authorization') !== expected) return error(403, 'AuthenticationFailed');
      if (headers.get('x-ms-version') !== '2023-11-03') return error(400, 'InvalidHeaderValue');
    }
    if (container !== 'rooms') return error(404, 'ContainerNotFound');
    if (failNext) {
      failNext = false;
      stats.retried++;
      return error(503, 'ServerBusy');
    }
    const comp = url.searchParams.get('comp');

    if (method === 'PUT' && comp === 'block') {
      const id = url.searchParams.get('blockid')!;
      const list = staged.get(name) ?? new Map();
      if ([...list.keys()].some((other) => other.length !== id.length))
        return error(400, 'InvalidBlobOrBlock');
      list.set(id, body);
      staged.set(name, list);
      return new Response(null, { status: 201, headers: { 'content-md5': 'bWQ1' } });
    }
    if (method === 'PUT' && comp === 'blocklist') {
      const ids = [...new TextDecoder().decode(body).matchAll(/<Latest>([^<]+)<\/Latest>/g)].map(
        (m) => m[1]!,
      );
      const list = staged.get(name);
      if (!list || ids.some((id) => !list.has(id))) return error(400, 'InvalidBlockList');
      blobs.set(name, Buffer.concat(ids.map((id) => list.get(id)!)));
      staged.delete(name);
      return new Response(null, { status: 201, headers: { etag: '"0x1"' } });
    }
    if (method === 'PUT' && headers.has('x-ms-copy-source')) {
      const source = new URL(headers.get('x-ms-copy-source')!);
      const sourceParts = source.pathname.split('/').slice(1);
      if (!source.host.startsWith(`${ACCOUNT}.`)) sourceParts.shift();
      const from = sourceParts.slice(1).map(decodeURIComponent).join('/');
      const bytes = blobs.get(from);
      if (!bytes) return error(404, 'CannotVerifyCopySource');
      blobs.set(name, bytes);
      if (options.pendingCopies) copying.set(name, 2);
      return new Response(null, {
        status: 202,
        headers: { 'x-ms-copy-status': options.pendingCopies ? 'pending' : 'success' },
      });
    }
    if (method === 'PUT') {
      if (headers.get('x-ms-blob-type') !== 'BlockBlob') return error(400, 'MissingRequiredHeader');
      if (Number(headers.get('content-length')) !== body.byteLength)
        return error(400, 'InvalidHeaderValue');
      blobs.set(name, body);
      return new Response(null, { status: 201, headers: { etag: '"0x2"' } });
    }
    const found = blobs.get(name);
    if (method === 'DELETE') {
      if (!found) return error(404, 'BlobNotFound');
      blobs.delete(name);
      return new Response(null, { status: 202 });
    }
    if (!found) return error(404, 'BlobNotFound');
    if (method === 'HEAD') {
      const left = copying.get(name);
      if (left !== undefined) {
        stats.polls++;
        if (left <= 1) copying.delete(name);
        else copying.set(name, left - 1);
      }
      return new Response(null, {
        headers: {
          'content-length': String(found.byteLength),
          etag: '"0x3"',
          'x-ms-copy-status': left !== undefined && left > 1 ? 'pending' : 'success',
        },
      });
    }
    const range = /^bytes=(\d+)-(\d*)$/.exec(headers.get('x-ms-range') ?? '');
    const slice = range
      ? found.subarray(Number(range[1]), range[2] ? Number(range[2]) + 1 : undefined)
      : found;
    return new Response(slice as BodyInit, { status: range ? 206 : 200 });
  };
  return { fetch: handler as typeof fetch, blobs, staged, stats };
}

const create = (fake = fakeAzure(), extra: { endpoint?: string; prefix?: string } = {}) =>
  azureBlobStorage({
    account: ACCOUNT,
    container: 'rooms',
    credentials: { accountKey: KEY },
    endpoint: extra.endpoint ?? `http://azure.test/${ACCOUNT}`,
    fetch: fake.fetch,
    ...(extra.prefix ? { prefix: extra.prefix } : {}),
  });

describe('azure blob storage conformance', () => {
  for (const testCase of storageConformanceCases()) it(testCase.name, () => testCase.run(create()));
  it('passes on the default endpoint, with a prefix and asynchronous copies', async () => {
    for (const testCase of storageConformanceCases()) {
      const fake = fakeAzure({ pendingCopies: true });
      await testCase.run(
        azureBlobStorage({
          account: ACCOUNT,
          container: 'rooms',
          credentials: { accountKey: KEY },
          prefix: 'app-one',
          fetch: fake.fetch,
        }),
      );
      expect([...fake.blobs.keys()].every((name) => name.startsWith('app-one/'))).toBe(true);
    }
  });
});

describe('azure signing', () => {
  // Cross-checked against @azure/storage-blob 12.34 (StorageSharedKeyCredential, generateBlobSASQueryParameters).
  it('matches the Azure SDK for Shared Key and service SAS', () => {
    expect(
      sharedKeyAuthorization({
        account: ACCOUNT,
        accountKey: KEY,
        method: 'PUT',
        url: new URL('https://acct.blob.core.windows.net/rooms/t1/x.bin?comp=block&blockid=QUJD'),
        headers: {
          'content-length': '5',
          'x-ms-date': 'Sat, 03 Oct 2026 10:00:00 GMT',
          'x-ms-version': '2023-11-03',
        },
      }),
    ).toBe('SharedKey acct:7cZCFaVvy2wb/dsFeE+sjPhES7JAKwPQGGS5z3Vu27s=');
    const sas = new URLSearchParams(
      blobSas({
        account: ACCOUNT,
        accountKey: KEY,
        container: 'rooms',
        blob: 't1/a file.bin',
        permissions: 'r',
        startsOn: new Date('2026-10-03T10:00:00Z'),
        expiresOn: new Date('2026-10-03T11:00:00Z'),
      }),
    );
    expect(sas.get('sig')).toBe('kh7XiGU7JcNbgPibr2BBmgnarAFI9BylTY/GABVFRCg=');
  });
});

describe('azure blob storage', () => {
  it('polls pending copies until they succeed', async () => {
    const fake = fakeAzure({ pendingCopies: true });
    const storage = create(fake);
    await storage.put('t1/src', new TextEncoder().encode('copy me'));
    expect(await storage.copy!('t1/src', 't1/dst')).toMatchObject({ key: 't1/dst', size: 7 });
    expect(fake.stats.polls).toBe(2);
  });

  it('retries throttled requests and reports service error codes', async () => {
    const fake = fakeAzure({ failOnce: true });
    const storage = create(fake);
    await storage.put('t1/x', new Uint8Array([1]));
    expect(fake.stats.retried).toBe(1);
    const wrongKey = azureBlobStorage({
      account: ACCOUNT,
      container: 'rooms',
      credentials: { accountKey: Buffer.from('another key').toString('base64') },
      endpoint: `http://azure.test/${ACCOUNT}`,
      fetch: fake.fetch,
    });
    await expect(wrongKey.head('t1/x')).rejects.toThrow(/403 AuthenticationFailed/);
  });

  it('derives block ids from part numbers and refuses bad upload ids', async () => {
    const fake = fakeAzure();
    const storage = create(fake);
    const { uploadId } = await storage.multipart!.create('t1/big');
    await storage.multipart!.uploadPart('t1/big', uploadId, 1, new Uint8Array([1]));
    await expect(
      storage.multipart!.complete('t1/big', uploadId, [
        { part: 1, etag: 'x' },
        { part: 2, etag: 'never uploaded' },
      ]),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      storage.multipart!.uploadPart('t1/big', 'short', 1, new Uint8Array(1)),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('issues SAS URLs the service accepts, and only with the account key', async () => {
    const fake = fakeAzure();
    const storage = create(fake);
    await storage.put('t1/a file.bin', new Uint8Array([4, 5, 6]));
    const get = await storage.presign!('t1/a file.bin', { method: 'GET', expiresInSeconds: 120 });
    expect(new URL(get).searchParams.get('sp')).toBe('r');
    expect([...new Uint8Array(await (await fake.fetch(get)).arrayBuffer())]).toEqual([4, 5, 6]);
    expect((await fake.fetch(get.replace('sp=r', 'sp=rw'))).status).toBe(403);

    const sasOnly = azureBlobStorage({
      account: ACCOUNT,
      container: 'rooms',
      credentials: { sasToken: '?sv=2023-11-03&sig=x' },
    });
    expect(sasOnly.presign).toBeUndefined();
    expect(sasOnly.multipart!.presignPart).toBeUndefined();
  });

  it('reads connection strings, including Azurite', () => {
    expect(parseConnectionString('UseDevelopmentStorage=true')).toMatchObject({
      account: 'devstoreaccount1',
      endpoint: 'http://127.0.0.1:10000/devstoreaccount1',
    });
    expect(
      parseConnectionString(
        `DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=${KEY};EndpointSuffix=core.chinacloudapi.cn`,
      ),
    ).toEqual({
      account: 'acct',
      endpoint: 'https://acct.blob.core.chinacloudapi.cn',
      credentials: { accountKey: KEY },
    });
    expect(
      parseConnectionString(
        'BlobEndpoint=https://acct.blob.core.windows.net;SharedAccessSignature=sv=1&sig=2',
      ),
    ).toMatchObject({ account: 'acct', credentials: { sasToken: 'sv=1&sig=2' } });
    expect(() => parseConnectionString('AccountName=acct')).toThrow(/AccountKey/);
  });

  it('serves a data room end to end, including direct uploads from the browser', async () => {
    const fake = fakeAzure();
    const f = await fixture({ storageAdapter: create(fake) });
    const room = await f.room();
    const fetch = (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      return url.startsWith('http://azure.test')
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
      const content = f.bytes(200_000, direct ? 7 : 8);
      const result = await client.upload({
        parentId: room.rootNodeId,
        file: new Blob([content]),
        filename: `azure-${direct}.bin`,
        direct,
      });
      const ticket = await f.dr.api.documents.requestOriginal(as('alice'), {
        tenantId: TENANT,
        nodeId: result.document.id,
      });
      const downloaded = await f.download(ticket.url);
      expect(f.sha256(downloaded.body)).toBe(f.sha256(content));
    }
    expect(fake.staged.size).toBe(0);
  });
});
