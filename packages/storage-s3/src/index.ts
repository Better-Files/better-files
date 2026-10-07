import { createHash } from 'node:crypto';
import {
  BetterFilesError,
  invalidInput,
  notFound,
  type ByteSource,
  type StorageAdapter,
  type StoredObject,
} from '@better-files/core';
import {
  amzDate,
  EMPTY_SHA256,
  encodePath,
  presignUrl,
  signHeaders,
  UNSIGNED_PAYLOAD,
  type AwsCredentials,
} from './sigv4.js';
import { awsCredentials } from './credentials.js';

export { signHeaders, presignUrl, encodeRfc3986, type AwsCredentials } from './sigv4.js';
export { awsCredentials, type AwsCredentialsOptions } from './credentials.js';

export interface S3StorageOptions {
  bucket: string;
  region: string;
  /** Custom endpoint for R2, MinIO, B2, Wasabi (`https://<account>.r2.cloudflarestorage.com`). */
  endpoint?: string;
  /** Path-style addressing (`{endpoint}/{bucket}/{key}`); default true when `endpoint` is set. */
  forcePathStyle?: boolean;
  /** Default `awsCredentials()`: environment, web identity, container role or EC2 instance role. */
  credentials?: AwsCredentials | (() => Promise<AwsCredentials>);
  /** Prepended to every key, so several apps can share a bucket. */
  prefix?: string;
  /** Server-side encryption on top of Better Files' own encryption. */
  serverSideEncryption?: 'AES256' | 'aws:kms';
  fetch?: typeof fetch;
}

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

const tag = (xml: string, name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1];

/**
 * S3-compatible object storage without the AWS SDK: SigV4 over `fetch`, so it also runs on edge runtimes. Bodies of
 * known length stream straight through; others are buffered (Better Files always passes the length).
 */
export function s3Storage(options: S3StorageOptions): StorageAdapter {
  const doFetch = options.fetch ?? globalThis.fetch;
  const pathStyle = options.forcePathStyle ?? options.endpoint !== undefined;
  const base = new URL(options.endpoint ?? `https://s3.${options.region}.amazonaws.com`);
  const prefix = options.prefix ? options.prefix.replace(/\/+$/, '') + '/' : '';
  const source = options.credentials ?? awsCredentials();
  const credentials = async () => (typeof source === 'function' ? source() : source);

  const objectUrl = (key: string, query: Record<string, string> = {}) => {
    if (!key || key.length > 1024) throw invalidInput('Invalid storage key');
    const path = encodePath(prefix + key);
    const url = pathStyle
      ? new URL(
          `${base.origin}${base.pathname.replace(/\/$/, '')}/${encodeURIComponent(options.bucket)}/${path}`,
        )
      : new URL(`${base.protocol}//${options.bucket}.${base.host}/${path}`);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    return url;
  };

  async function send(
    method: string,
    url: URL,
    init: {
      headers?: Record<string, string>;
      body?: BodyInit | ReadableStream<Uint8Array>;
      payloadHash?: string;
    } = {},
  ): Promise<Response> {
    const creds = await credentials();
    const date = new Date();
    const payloadHash = init.payloadHash ?? (init.body ? UNSIGNED_PAYLOAD : EMPTY_SHA256);
    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-date': amzDate(date),
      'x-amz-content-sha256': payloadHash,
      ...(creds.sessionToken ? { 'x-amz-security-token': creds.sessionToken } : {}),
      ...init.headers,
    };
    const query = Object.fromEntries(url.searchParams);
    headers.authorization = signHeaders({
      method,
      path: url.pathname,
      query,
      headers: Object.fromEntries(
        Object.entries(headers).filter(([name]) => name !== 'authorization'),
      ),
      payloadHash,
      region: options.region,
      credentials: creds,
      date,
    });
    delete headers.host;
    const response = await doFetch(url, {
      method,
      headers,
      ...(init.body ? { body: init.body as BodyInit, duplex: 'half' } : {}),
    } as RequestInit);
    return response;
  }

  async function failure(response: Response, what: string): Promise<never> {
    if (response.status === 404) throw notFound(what);
    const text = await response.text().catch(() => '');
    throw new BetterFilesError(
      'INTERNAL_ERROR',
      `Storage request failed: ${response.status} ${tag(text, 'Code') ?? ''}`.trim(),
    );
  }

  const sse: Record<string, string> = options.serverSideEncryption
    ? { 'x-amz-server-side-encryption': options.serverSideEncryption }
    : {};

  async function putBody(
    url: URL,
    body: ByteSource,
    contentLength?: number,
    extra: Record<string, string> = {},
  ) {
    // S3 needs a Content-Length; unknown lengths are buffered.
    if (
      contentLength === undefined ||
      body instanceof Uint8Array ||
      !(body instanceof ReadableStream)
    ) {
      const bytes = await readAll(body);
      const hash = createHash('sha256').update(bytes).digest('hex');
      return send('PUT', url, {
        headers: { 'content-length': String(bytes.byteLength), ...extra },
        body: bytes as unknown as BodyInit,
        payloadHash: hash,
      });
    }
    return send('PUT', url, {
      headers: { 'content-length': String(contentLength), ...extra },
      body,
    });
  }

  const adapter: StorageAdapter & { head: StorageAdapter['head'] } = {
    id: 's3',
    async put(key, body, putOptions) {
      const response = await putBody(objectUrl(key), body, putOptions?.contentLength, sse);
      if (!response.ok) await failure(response, 'Object');
      const head = await adapter.head(key);
      return head ?? { key, size: putOptions?.contentLength ?? 0 };
    },
    async get(key, range) {
      const response = await send('GET', objectUrl(key), {
        ...(range ? { headers: { range: `bytes=${range.start}-${range.end ?? ''}` } } : {}),
      });
      if (!response.ok || !response.body) await failure(response, 'Object');
      return response.body as ReadableStream<Uint8Array>;
    },
    async head(key) {
      const response = await send('HEAD', objectUrl(key));
      if (response.status === 404) return null;
      if (!response.ok) await failure(response, 'Object');
      const etag = response.headers.get('etag');
      return {
        key,
        size: Number(response.headers.get('content-length') ?? 0),
        ...(etag ? { etag } : {}),
      };
    },
    async delete(key) {
      const response = await send('DELETE', objectUrl(key));
      if (!response.ok && response.status !== 404) await failure(response, 'Object');
    },
    async copy(from, to) {
      const source = `/${options.bucket}/${encodePath(prefix + from)}`;
      const response = await send('PUT', objectUrl(to), {
        headers: { 'x-amz-copy-source': source, ...sse },
      });
      if (!response.ok) await failure(response, 'Object');
      return (await adapter.head(to)) ?? { key: to, size: 0 };
    },
    multipart: {
      async create(key) {
        const response = await send('POST', objectUrl(key, { uploads: '' }), { headers: sse });
        if (!response.ok) await failure(response, 'Upload');
        const uploadId = tag(await response.text(), 'UploadId');
        if (!uploadId)
          throw new BetterFilesError('INTERNAL_ERROR', 'Storage returned no upload id');
        return { uploadId };
      },
      async uploadPart(key, uploadId, part, body) {
        const bytes = await readAll(body);
        const response = await putBody(
          objectUrl(key, { partNumber: String(part), uploadId }),
          bytes,
          bytes.byteLength,
        );
        if (!response.ok) await failure(response, 'Upload');
        return { etag: response.headers.get('etag') ?? '' };
      },
      async complete(key, uploadId, parts) {
        const xml = `<CompleteMultipartUpload>${[...parts]
          .sort((a, b) => a.part - b.part)
          .map(
            ({ part, etag }) =>
              `<Part><PartNumber>${part}</PartNumber><ETag>${etag.replace(/[<>&]/g, '')}</ETag></Part>`,
          )
          .join('')}</CompleteMultipartUpload>`;
        const bytes = new TextEncoder().encode(xml);
        const response = await send('POST', objectUrl(key, { uploadId }), {
          headers: {
            'content-length': String(bytes.byteLength),
            'content-type': 'application/xml',
          },
          body: bytes as unknown as BodyInit,
          payloadHash: createHash('sha256').update(bytes).digest('hex'),
        });
        const text = await response.text();
        // S3 can answer 200 with an error document for a failed completion.
        if (!response.ok || tag(text, 'Code'))
          throw new BetterFilesError(
            'INTERNAL_ERROR',
            `Completing the upload failed: ${tag(text, 'Code') ?? response.status}`,
          );
        return (await adapter.head(key)) ?? ({ key, size: 0 } as StoredObject);
      },
      async abort(key, uploadId) {
        const response = await send('DELETE', objectUrl(key, { uploadId }));
        if (!response.ok && response.status !== 404) await failure(response, 'Upload');
      },
      /** A presigned PUT for one part, for direct uploads. The bucket's CORS rules must expose `ETag`. */
      async presignPart(key, uploadId, part, presignOptions) {
        return presignUrl({
          method: 'PUT',
          url: objectUrl(key, { partNumber: String(part), uploadId }),
          region: options.region,
          credentials: await credentials(),
          date: new Date(),
          expiresInSeconds: presignOptions.expiresInSeconds,
        });
      },
    },
    async presign(key, presignOptions) {
      return presignUrl({
        method: presignOptions.method,
        url: objectUrl(key),
        region: options.region,
        credentials: await credentials(),
        date: new Date(),
        expiresInSeconds: presignOptions.expiresInSeconds,
      });
    },
  };
  return adapter;
}
