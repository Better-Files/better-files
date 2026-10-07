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
import {
  encodeRfc3986,
  serviceAccountTokens,
  signedUrl,
  type GoogleServiceAccountKey,
  type Secret,
} from './auth.js';

export {
  encodeRfc3986,
  serviceAccountTokens,
  signedUrl,
  STORAGE_SCOPE,
  type GoogleServiceAccountKey,
  type Secret,
} from './auth.js';

export interface GcsStorageOptions {
  bucket: string;
  /**
   * A service-account key (the parsed JSON key file), which also enables signed URLs for direct uploads and
   * downloads; or an OAuth access token with `devstorage.read_write` scope, or a function returning one (workload
   * identity, google-auth-library). Emulators accept any token.
   */
  credentials: { serviceAccount: GoogleServiceAccountKey } | { accessToken: Secret };
  /** Prepended to every key, so several apps can share a bucket. */
  prefix?: string;
  /** Default `https://storage.googleapis.com`. Point it at fake-gcs-server or another emulator in tests. */
  endpoint?: string;
  /** Retries for throttling (429) and server errors (5xx) on requests whose body can be resent. Default 3. */
  retries?: number;
  fetch?: typeof fetch;
}

interface GcsObject {
  name: string;
  size?: string;
  etag?: string;
  generation?: string;
}

/** GCS composes at most 32 objects per request. */
const COMPOSE_LIMIT = 32;
const UPLOAD_ID = /^[A-Za-z0-9_-]{24}$/;
const MULTIPART_DIR = '.better-files-multipart';

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

/**
 * Google Cloud Storage over the JSON API and `fetch`, without the Google SDK, so it also runs on edge runtimes.
 *
 * GCS has no S3-style multipart upload in its JSON API, so multipart uploads store each part as a temporary object
 * under `.better-files-multipart/{uploadId}/` and `complete` joins them with `compose` (in rounds of 32), then deletes
 * the parts. Part numbers come from the caller, so parts can arrive in any order and be retried. Add a lifecycle
 * rule that deletes objects under that prefix after a few days to clean up uploads that were never completed or
 * aborted.
 */
export function gcsStorage(options: GcsStorageOptions): StorageAdapter {
  if (!options.bucket) throw invalidConfig('gcsStorage: bucket is required');
  const doFetch = options.fetch ?? globalThis.fetch;
  const endpoint = new URL(options.endpoint ?? 'https://storage.googleapis.com');
  const origin = `${endpoint.origin}${endpoint.pathname.replace(/\/+$/, '')}`;
  const retries = options.retries ?? 3;
  const prefix = options.prefix ? options.prefix.replace(/\/+$/, '') + '/' : '';
  const bucket = encodeURIComponent(options.bucket);
  const serviceAccount =
    'serviceAccount' in options.credentials ? options.credentials.serviceAccount : undefined;
  const token = serviceAccount
    ? serviceAccountTokens(serviceAccount, { fetch: doFetch })
    : async () => {
        const secret = (options.credentials as { accessToken: Secret }).accessToken;
        return typeof secret === 'function' ? secret() : secret;
      };

  const objectName = (key: string) => {
    if (!key || key.length > 1024 || key.startsWith(MULTIPART_DIR))
      throw invalidInput('Invalid storage key');
    return prefix + key;
  };
  const partsDir = (uploadId: string) => {
    if (!UPLOAD_ID.test(uploadId)) throw invalidInput('Invalid upload id');
    return `${prefix}${MULTIPART_DIR}/${uploadId}/`;
  };
  const partName = (uploadId: string, part: number) => {
    if (!Number.isInteger(part) || part < 1 || part > 10_000)
      throw invalidInput('Part numbers run from 1 to 10000');
    return `${partsDir(uploadId)}${String(part).padStart(5, '0')}`;
  };
  const metadataUrl = (name: string) =>
    new URL(`${origin}/storage/v1/b/${bucket}/o/${encodeURIComponent(name)}`);

  async function send(
    method: string,
    url: URL,
    init: { headers?: Record<string, string>; body?: Uint8Array | ReadableStream<Uint8Array> } = {},
  ): Promise<Response> {
    const replayable = !(init.body instanceof ReadableStream);
    for (let attempt = 0; ; attempt++) {
      const response = await doFetch(url, {
        method,
        headers: { authorization: `Bearer ${await token()}`, ...init.headers },
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
    const body = (await response.json().catch(() => undefined)) as
      | { error?: { message?: string; errors?: { reason?: string }[] } }
      | undefined;
    const reason = body?.error?.errors?.[0]?.reason;
    throw new BetterFilesError(
      'INTERNAL_ERROR',
      `Storage request failed: ${response.status}${reason ? ` ${reason}` : ''}`,
    );
  }

  async function json<T>(response: Response, what: string): Promise<T> {
    if (!response.ok) await failure(response, what);
    return (await response.json()) as T;
  }

  const stored = (key: string, object: GcsObject): StoredObject => ({
    key,
    size: Number(object.size ?? 0),
    ...(object.etag ? { etag: object.etag } : {}),
  });

  async function upload(name: string, body: ByteSource, contentLength?: number) {
    const url = new URL(`${origin}/upload/storage/v1/b/${bucket}/o`);
    url.searchParams.set('uploadType', 'media');
    url.searchParams.set('name', name);
    // A Content-Length is required; streams of unknown length are buffered (Better Files always passes the length).
    const payload =
      contentLength !== undefined && body instanceof ReadableStream ? body : await readAll(body);
    const length = payload instanceof Uint8Array ? payload.byteLength : contentLength!;
    const response = await send('POST', url, {
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(length) },
      body: payload,
    });
    return json<GcsObject>(response, 'Object');
  }

  async function remove(name: string) {
    const response = await send('DELETE', metadataUrl(name));
    if (!response.ok && response.status !== 404) await failure(response, 'Object');
    await response.body?.cancel().catch(() => {});
  }

  async function list(namePrefix: string): Promise<string[]> {
    const names: string[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(`${origin}/storage/v1/b/${bucket}/o`);
      url.searchParams.set('prefix', namePrefix);
      url.searchParams.set('fields', 'items(name),nextPageToken');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const page = await json<{ items?: { name: string }[]; nextPageToken?: string }>(
        await send('GET', url),
        'Bucket',
      );
      for (const item of page.items ?? []) names.push(item.name);
      pageToken = page.nextPageToken;
    } while (pageToken);
    return names;
  }

  async function compose(
    destination: string,
    sources: { name: string; generation?: string }[],
  ): Promise<GcsObject> {
    const body = new TextEncoder().encode(
      JSON.stringify({
        sourceObjects: sources.map(({ name, generation }) => ({
          name,
          ...(generation ? { objectPreconditions: { ifGenerationMatch: generation } } : {}),
        })),
        destination: { contentType: 'application/octet-stream' },
      }),
    );
    const response = await send('POST', new URL(`${metadataUrl(destination).href}/compose`), {
      headers: { 'content-type': 'application/json' },
      body,
    });
    return json<GcsObject>(response, 'Upload part');
  }

  const presignable = (name: string) => {
    if (!serviceAccount)
      throw invalidConfig('gcsStorage: signed URLs need credentials.serviceAccount');
    return new URL(`${origin}/${bucket}/${name.split('/').map(encodeRfc3986).join('/')}`);
  };

  const adapter: StorageAdapter = {
    id: 'gcs',
    async put(key, body, putOptions) {
      return stored(key, await upload(objectName(key), body, putOptions?.contentLength));
    },
    async get(key, range) {
      const url = metadataUrl(objectName(key));
      url.searchParams.set('alt', 'media');
      const response = await send('GET', url, {
        ...(range ? { headers: { range: `bytes=${range.start}-${range.end ?? ''}` } } : {}),
      });
      if (!response.ok || !response.body) await failure(response, 'Object');
      return response.body as ReadableStream<Uint8Array>;
    },
    async head(key) {
      const url = metadataUrl(objectName(key));
      url.searchParams.set('fields', 'name,size,etag,generation');
      const response = await send('GET', url);
      if (response.status === 404) {
        await response.body?.cancel().catch(() => {});
        return null;
      }
      return stored(key, await json<GcsObject>(response, 'Object'));
    },
    async delete(key) {
      await remove(objectName(key));
    },
    async copy(from, to) {
      // `rewrite` copies server-side; large cross-location copies take several calls.
      const target = `${metadataUrl(objectName(from)).href}/rewriteTo/b/${bucket}/o/${encodeURIComponent(objectName(to))}`;
      let rewriteToken: string | undefined;
      for (;;) {
        const url = new URL(target);
        if (rewriteToken) url.searchParams.set('rewriteToken', rewriteToken);
        const result = await json<{ done: boolean; rewriteToken?: string; resource?: GcsObject }>(
          await send('POST', url, {
            headers: { 'content-type': 'application/json' },
            body: new TextEncoder().encode('{}'),
          }),
          'Object',
        );
        if (result.done && result.resource) return stored(to, result.resource);
        if (!result.rewriteToken)
          throw new BetterFilesError('INTERNAL_ERROR', 'Storage returned no rewrite token');
        rewriteToken = result.rewriteToken;
      }
    },
    multipart: {
      async create(key) {
        objectName(key);
        return { uploadId: randomBytes(18).toString('base64url') };
      },
      async uploadPart(key, uploadId, part, body) {
        objectName(key);
        const object = await upload(partName(uploadId, part), body);
        // The generation pins the exact part bytes at completion time.
        return { etag: object.generation ?? object.etag ?? '' };
      },
      async complete(key, uploadId, parts) {
        const name = objectName(key);
        const directory = partsDir(uploadId);
        if (parts.length === 0) throw invalidInput('An upload needs at least one part');
        const ordered = [...parts].sort((a, b) => a.part - b.part);
        if (new Set(ordered.map((p) => p.part)).size !== ordered.length)
          throw invalidInput('Duplicate part numbers');
        // Direct uploads return the XML API's MD5 ETag rather than a generation; those parts are taken as they are.
        let sources = ordered.map(({ part, etag }) => ({
          name: partName(uploadId, part),
          ...(/^\d+$/.test(etag) ? { generation: etag } : {}),
        }));
        let round = 0;
        while (sources.length > COMPOSE_LIMIT) {
          const next: { name: string; generation?: string }[] = [];
          for (let i = 0; i < sources.length; i += COMPOSE_LIMIT) {
            const intermediate = `${directory}r${round}-${String(i / COMPOSE_LIMIT).padStart(4, '0')}`;
            const result = await compose(intermediate, sources.slice(i, i + COMPOSE_LIMIT));
            next.push({
              name: intermediate,
              ...(result.generation ? { generation: result.generation } : {}),
            });
          }
          sources = next;
          round++;
        }
        const result = await compose(name, sources);
        await adapter.multipart!.abort(key, uploadId);
        return stored(key, result);
      },
      async abort(key, uploadId) {
        objectName(key);
        const names = await list(partsDir(uploadId));
        for (let i = 0; i < names.length; i += 16)
          await Promise.all(names.slice(i, i + 16).map(remove));
      },
      async presignPart(key, uploadId, part, presignOptions) {
        objectName(key);
        return signedUrl({
          method: 'PUT',
          url: presignable(partName(uploadId, part)),
          key: serviceAccount!,
          date: new Date(),
          expiresInSeconds: presignOptions.expiresInSeconds,
        });
      },
    },
    async presign(key, presignOptions) {
      return signedUrl({
        method: presignOptions.method,
        url: presignable(objectName(key)),
        key: serviceAccount!,
        date: new Date(),
        expiresInSeconds: presignOptions.expiresInSeconds,
        ...(presignOptions.contentType && presignOptions.method === 'PUT'
          ? { headers: { 'content-type': presignOptions.contentType } }
          : {}),
      });
    },
  };
  if (!serviceAccount) {
    delete adapter.presign;
    delete adapter.multipart!.presignPart;
  }
  return adapter;
}
