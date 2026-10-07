import { randomBytes } from 'node:crypto';
import {
  BetterFilesError,
  invalidConfig,
  invalidInput,
  notFound,
  type ByteSource,
  type StorageAdapter,
  type StoredObject,
} from '@better-files/core';
import { AZURE_STORAGE_VERSION, blobSas, sharedKeyAuthorization } from './auth.js';

export {
  AZURE_STORAGE_VERSION,
  blobSas,
  parseConnectionString,
  sharedKeyAuthorization,
  type AzureConnection,
} from './auth.js';

/** A static secret or a function that returns a fresh one (for example from @azure/identity). */
export type Secret = string | (() => string | Promise<string>);

export interface AzureBlobStorageOptions {
  account: string;
  container: string;
  /**
   * - `accountKey`: Shared Key auth; also enables SAS URLs for direct uploads and downloads.
   * - `sasToken`: a container or account SAS with read, write and delete rights (no presigning).
   * - `accessToken`: a Microsoft Entra ID token for `https://storage.azure.com/`, or a function returning one (managed
   *   identity, @azure/identity); the identity needs "Storage Blob Data Contributor" (no presigning).
   */
  credentials: { accountKey: string } | { sasToken: string } | { accessToken: Secret };
  /**
   * Default `https://{account}.blob.core.windows.net`. For Azurite use `http://127.0.0.1:10000/devstoreaccount1`, or
   * take endpoint, account and credentials from `parseConnectionString()`.
   */
  endpoint?: string;
  /** Prepended to every key, so several apps can share a container. */
  prefix?: string;
  /** Retries for throttling (429, 503) and server errors on requests whose body can be resent. Default 3. */
  retries?: number;
  /** How long `copy` waits for an asynchronous server-side copy to finish. Default 60 seconds. */
  copyTimeoutMs?: number;
  fetch?: typeof fetch;
}

const UPLOAD_ID = /^[A-Za-z0-9_-]{24}$/;
/** Block blobs take single PUTs up to 5000 MiB. */
const MAX_SINGLE_PUT = 5000 * 1024 * 1024;

async function readAll(source: ByteSource): Promise<Uint8Array> {
  if (source instanceof Uint8Array) return source;
  const chunks: Uint8Array[] = [];
  if (source instanceof ReadableStream) {
    const reader = source.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } else for await (const chunk of source) chunks.push(chunk);
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const tag = (xml: string, name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1];

/**
 * Azure Blob Storage (block blobs) over `fetch`, without the Azure SDK.
 *
 * Multipart uploads map onto staged blocks: each part is a `Put Block` with an id derived from the upload id and the
 * part number, and `complete` commits them with `Put Block List`. Azure has no call to discard staged blocks, so
 * `abort` leaves them for the service to drop (uncommitted blocks expire after seven days, and never become
 * visible). Two uploads to the same key at the same time would discard each other's blocks on commit; Better Files
 * gives every upload its own key.
 */
export function azureBlobStorage(options: AzureBlobStorageOptions): StorageAdapter {
  if (!options.account) throw invalidConfig('azureBlobStorage: account is required');
  if (!/^[a-z0-9](?!.*--)[a-z0-9-]{1,61}[a-z0-9]$/.test(options.container ?? ''))
    throw invalidConfig('azureBlobStorage: container must be a valid container name');
  const doFetch = options.fetch ?? globalThis.fetch;
  const endpoint = new URL(options.endpoint ?? `https://${options.account}.blob.core.windows.net`);
  const base = `${endpoint.origin}${endpoint.pathname.replace(/\/+$/, '')}/${options.container}`;
  const retries = options.retries ?? 3;
  const prefix = options.prefix ? options.prefix.replace(/\/+$/, '') + '/' : '';
  const credentials = options.credentials;
  const accountKey = 'accountKey' in credentials ? credentials.accountKey : undefined;
  const sas =
    'sasToken' in credentials
      ? new URLSearchParams(credentials.sasToken.replace(/^\?/, ''))
      : undefined;

  const blobName = (key: string) => {
    if (!key || key.length > 1024 || key.endsWith('/') || key.includes('//'))
      throw invalidInput('Invalid storage key');
    return prefix + key;
  };
  const blobUrl = (name: string, query: Record<string, string> = {}) => {
    const url = new URL(`${base}/${name.split('/').map(encodeURIComponent).join('/')}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return url;
  };
  const blockId = (uploadId: string, part: number) => {
    if (!UPLOAD_ID.test(uploadId)) throw invalidInput('Invalid upload id');
    if (!Number.isInteger(part) || part < 1 || part > 50_000)
      throw invalidInput('Part numbers run from 1 to 50000');
    // Every block id of a blob must have the same length.
    return Buffer.from(`${uploadId}-${String(part).padStart(5, '0')}`).toString('base64');
  };

  async function send(
    method: string,
    url: URL,
    init: { headers?: Record<string, string>; body?: Uint8Array | ReadableStream<Uint8Array> } = {},
  ): Promise<Response> {
    const replayable = !(init.body instanceof ReadableStream);
    if (sas) for (const [name, value] of sas) url.searchParams.set(name, value);
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = {
        'x-ms-date': new Date().toUTCString(),
        'x-ms-version': AZURE_STORAGE_VERSION,
        ...init.headers,
      };
      if (accountKey)
        headers.authorization = sharedKeyAuthorization({
          account: options.account,
          accountKey,
          method,
          url,
          headers,
        });
      else if ('accessToken' in credentials) {
        const secret = credentials.accessToken;
        headers.authorization = `Bearer ${typeof secret === 'function' ? await secret() : secret}`;
      }
      const response = await doFetch(url, {
        method,
        headers,
        ...(init.body ? { body: init.body as BodyInit, duplex: 'half' } : {}),
      } as RequestInit);
      if (replayable && attempt < retries && (response.status === 429 || response.status >= 500)) {
        await response.body?.cancel().catch(() => {});
        await sleep(100 * 2 ** attempt + Math.random() * 100);
        continue;
      }
      return response;
    }
  }

  async function failure(response: Response, what: string): Promise<never> {
    if (response.status === 404) throw notFound(what);
    const text = await response.text().catch(() => '');
    const code = response.headers.get('x-ms-error-code') ?? tag(text, 'Code');
    throw new BetterFilesError(
      'INTERNAL_ERROR',
      `Storage request failed: ${response.status}${code ? ` ${code}` : ''}`,
    );
  }

  const done = async (response: Response, what: string, allow404 = false) => {
    if (!response.ok && !(allow404 && response.status === 404)) await failure(response, what);
    await response.body?.cancel().catch(() => {});
  };

  async function properties(name: string): Promise<Headers | null> {
    const response = await send('HEAD', blobUrl(name));
    if (response.status === 404) return null;
    await done(response, 'Object');
    return response.headers;
  }

  const stored = (key: string, headers: Headers | null, size = 0): StoredObject => {
    const etag = headers?.get('etag');
    return {
      key,
      size: headers ? Number(headers.get('content-length') ?? 0) : size,
      ...(etag ? { etag } : {}),
    };
  };

  const sasUrl = (
    name: string,
    permissions: string,
    expiresInSeconds: number,
    query: Record<string, string> = {},
  ) => {
    if (!accountKey) throw invalidConfig('azureBlobStorage: SAS URLs need credentials.accountKey');
    if (expiresInSeconds < 1 || expiresInSeconds > 7 * 24 * 3600)
      throw invalidConfig('SAS URLs last between 1 second and 7 days');
    const url = blobUrl(name, query);
    const token = blobSas({
      account: options.account,
      accountKey,
      container: options.container,
      blob: name,
      permissions,
      // A little slack for clock skew between this host and Azure.
      startsOn: new Date(Date.now() - 5 * 60_000),
      expiresOn: new Date(Date.now() + expiresInSeconds * 1000),
      protocol: url.protocol === 'https:' ? 'https' : 'https,http',
    });
    return `${url.href}${url.search ? '&' : '?'}${token}`;
  };

  const adapter: StorageAdapter = {
    id: 'azure-blob',
    async put(key, body, putOptions) {
      const name = blobName(key);
      const length = putOptions?.contentLength;
      // A Content-Length is required; streams of unknown length are buffered (Better Files always passes the length).
      const payload =
        length !== undefined && body instanceof ReadableStream ? body : await readAll(body);
      const size = payload instanceof Uint8Array ? payload.byteLength : length!;
      if (size > MAX_SINGLE_PUT)
        throw invalidInput('Objects over 5000 MiB must use a multipart upload');
      const response = await send('PUT', blobUrl(name), {
        headers: {
          'content-length': String(size),
          'content-type': 'application/octet-stream',
          'x-ms-blob-type': 'BlockBlob',
        },
        body: payload,
      });
      await done(response, 'Object');
      return {
        key,
        size,
        ...(response.headers.get('etag') ? { etag: response.headers.get('etag')! } : {}),
      };
    },
    async get(key, range) {
      const response = await send('GET', blobUrl(blobName(key)), {
        ...(range ? { headers: { 'x-ms-range': `bytes=${range.start}-${range.end ?? ''}` } } : {}),
      });
      if (!response.ok || !response.body) await failure(response, 'Object');
      return response.body as ReadableStream<Uint8Array>;
    },
    async head(key) {
      const headers = await properties(blobName(key));
      return headers ? stored(key, headers) : null;
    },
    async delete(key) {
      await done(
        await send('DELETE', blobUrl(blobName(key)), {
          headers: { 'x-ms-delete-snapshots': 'include' },
        }),
        'Object',
        true,
      );
    },
    async copy(from, to) {
      const source = blobUrl(blobName(from));
      if (sas) for (const [name, value] of sas) source.searchParams.set(name, value);
      const target = blobName(to);
      const response = await send('PUT', blobUrl(target), {
        headers: { 'x-ms-copy-source': source.href, 'content-length': '0' },
      });
      await done(response, 'Object');
      // Copies inside one account usually finish at once; larger ones report `pending` and are polled.
      let status = response.headers.get('x-ms-copy-status');
      const deadline = Date.now() + (options.copyTimeoutMs ?? 60_000);
      let headers: Headers | null = null;
      while (status !== 'success') {
        if (status === 'failed' || status === 'aborted')
          throw new BetterFilesError('INTERNAL_ERROR', `The storage copy ${status}`);
        if (Date.now() > deadline)
          throw new BetterFilesError('INTERNAL_ERROR', 'The storage copy did not finish in time');
        await sleep(250);
        headers = await properties(target);
        status = headers?.get('x-ms-copy-status') ?? 'failed';
      }
      return stored(to, headers ?? (await properties(target)));
    },
    multipart: {
      async create(key) {
        blobName(key);
        return { uploadId: randomBytes(18).toString('base64url') };
      },
      async uploadPart(key, uploadId, part, body) {
        const id = blockId(uploadId, part);
        const bytes = await readAll(body);
        await done(
          await send('PUT', blobUrl(blobName(key), { comp: 'block', blockid: id }), {
            headers: { 'content-length': String(bytes.byteLength) },
            body: bytes,
          }),
          'Upload',
        );
        return { etag: id };
      },
      async complete(key, uploadId, parts) {
        if (parts.length === 0) throw invalidInput('An upload needs at least one part');
        const ordered = [...parts].sort((a, b) => a.part - b.part);
        if (new Set(ordered.map((p) => p.part)).size !== ordered.length)
          throw invalidInput('Duplicate part numbers');
        // Block ids are derived from the part numbers, never taken from the caller's etags.
        const xml = `<?xml version="1.0" encoding="utf-8"?><BlockList>${ordered
          .map(({ part }) => `<Latest>${blockId(uploadId, part)}</Latest>`)
          .join('')}</BlockList>`;
        const bytes = new TextEncoder().encode(xml);
        const name = blobName(key);
        const response = await send('PUT', blobUrl(name, { comp: 'blocklist' }), {
          headers: {
            'content-length': String(bytes.byteLength),
            'content-type': 'application/xml',
            'x-ms-blob-content-type': 'application/octet-stream',
          },
          body: bytes,
        });
        if (response.status === 400) {
          const text = await response.text().catch(() => '');
          throw new BetterFilesError(
            'INVALID_INPUT',
            `Completing the upload failed: ${tag(text, 'Code') ?? 'InvalidBlockList'}`,
          );
        }
        await done(response, 'Upload');
        return stored(key, await properties(name));
      },
      async abort(key, uploadId) {
        // Staged blocks cannot be discarded one by one; they expire unseen. Validate the ids for symmetry.
        blobName(key);
        blockId(uploadId, 1);
      },
      async presignPart(key, uploadId, part, presignOptions) {
        return sasUrl(blobName(key), 'w', presignOptions.expiresInSeconds, {
          comp: 'block',
          blockid: blockId(uploadId, part),
        });
      },
    },
    async presign(key, presignOptions) {
      // A presigned PUT must carry `x-ms-blob-type: BlockBlob`; Better Files' direct uploads use presignPart instead.
      return sasUrl(
        blobName(key),
        presignOptions.method === 'GET' ? 'r' : 'cw',
        presignOptions.expiresInSeconds,
      );
    },
  };
  if (!accountKey) {
    delete adapter.presign;
    delete adapter.multipart!.presignPart;
  }
  return adapter;
}
