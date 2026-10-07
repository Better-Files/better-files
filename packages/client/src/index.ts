/**
 * The browser-safe Better Files client: typed calls over the HTTP protocol (`POST {basePath}/{group}/{method}`), a
 * parallel, resumable uploader, and helpers for download and viewer links. It imports no server code; types come
 * from `typeof dr` through a type-only import.
 */

import { encryptPart, type DirectUpload } from './direct.js';
import { subscribeRoom, type SubscribeOptions } from './live.js';

export {
  liveInvalidations,
  parseEventStream,
  subscribeRoom,
  type RoomActivity,
  type SubscribeOptions,
} from './live.js';

export { encryptPart, type DirectEncryption, type DirectUpload } from './direct.js';

type AnyFunction = (credential: never, input: never) => Promise<unknown>;
type ApiShape = Record<string, Record<string, AnyFunction>>;

/** `client.rooms.create(input)` for every `dr.api.rooms.create(credential, input)`, minus the credential. */
export type ClientApi<Api> = {
  [G in keyof Api]: {
    [M in keyof Api[G]]: Api[G][M] extends (credential: never, input: infer I) => Promise<infer O>
      ? (input: ClientInput<I>, options?: CallOptions) => Promise<O>
      : never;
  };
};

/** Inputs without the tenant: the client sends its configured `tenantId` unless one is given. */
export type ClientInput<I> = I extends { tenantId: string }
  ? Omit<I, 'tenantId'> & { tenantId?: string }
  : I;

export interface CallOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export interface BetterFilesClientOptions {
  /** Origin of the app serving the protocol; omit in the browser to use the page's origin. */
  baseURL?: string;
  /** Default `/api/better-files`. */
  basePath?: string;
  /** Sent as `tenantId` with every call unless the input has one. */
  tenantId?: string | (() => string | undefined);
  /** Extra headers per request (a bearer token for server-to-server calls). */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Default `include`, so Better IAM session cookies travel with same-site calls. */
  credentials?: RequestCredentials;
  fetch?: typeof fetch;
  /** Called on 401: the session lapsed or was revoked. */
  onUnauthenticated?: (error: BetterFilesClientError) => void;
  /** Adds an `X-Request-Id` to each call, echoed in errors for support tickets. */
  requestId?: boolean;
}

export class BetterFilesClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId?: string;
  readonly details?: unknown;
  constructor(input: {
    code: string;
    status: number;
    message: string;
    requestId?: string;
    details?: unknown;
  }) {
    super(input.message);
    this.name = 'BetterFilesClientError';
    this.code = input.code;
    this.status = input.status;
    if (input.requestId) this.requestId = input.requestId;
    if (input.details !== undefined) this.details = input.details;
  }
}

export interface UploadProgress {
  loaded: number;
  total: number;
  ratio: number;
}

export interface UploadInput {
  /** The folder a new document goes into … */
  parentId?: string;
  /** … or the document this is a new version of. */
  documentId?: string;
  file: Blob | Uint8Array;
  filename?: string;
  mimeType?: string;
  comment?: string;
  /** Parallel part uploads. Default 3. */
  concurrency?: number;
  /** Retries per part on network errors and 5xx. Default 3. */
  retries?: number;
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
  tenantId?: string;
  /**
   * Encrypt in the browser and PUT straight to object storage (presigned URLs), for large files and serverless
   * hosts with request-size limits. Needs a storage adapter with presigned parts (S3-compatible) and bucket CORS
   * that allows PUT and exposes `ETag`. The server still verifies every segment before accepting the file.
   */
  direct?: boolean;
}

interface UploadSession {
  uploadId: string;
  multipart: boolean;
  partSize: number;
  parts: number;
  contentUrl: string;
  partUrl: string;
  direct?: DirectUpload;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('Aborted'));
    });
  });

function randomRequestId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * ```ts
 * import type { dr } from '@/server/better-files';
 * const rooms = createBetterFilesClient<typeof dr>({ tenantId: () => session.tenantId });
 * const list = await rooms.rooms.list({});
 * await rooms.upload({ parentId: folder.id, file, onProgress: (p) => setProgress(p.ratio) });
 * ```
 */
export function createBetterFilesClient<T extends { api: object }>(
  options: BetterFilesClientOptions = {},
) {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const basePath = (options.basePath ?? '/api/better-files').replace(/\/+$/, '');
  const origin = options.baseURL?.replace(/\/+$/, '') ?? '';
  const url = (path: string) => `${origin}${path.startsWith('/') ? path : `${basePath}/${path}`}`;
  const tenant = () =>
    typeof options.tenantId === 'function' ? options.tenantId() : options.tenantId;

  async function headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    return {
      'x-better-files': '1',
      ...(options.requestId ? { 'x-request-id': randomRequestId() } : {}),
      ...(options.headers ? await options.headers() : {}),
      ...extra,
    };
  }

  async function parse<O>(response: Response): Promise<O> {
    const text = await response.text();
    let body: {
      data?: O;
      error?: { code: string; message: string; requestId?: string; details?: unknown };
    } = {};
    try {
      body = text ? (JSON.parse(text) as typeof body) : {};
    } catch {
      /* not JSON */
    }
    if (!response.ok || body.error) {
      const error = new BetterFilesClientError({
        code: body.error?.code ?? 'HTTP_ERROR',
        status: response.status,
        message: body.error?.message ?? `Request failed with ${response.status}`,
        ...(body.error?.requestId ? { requestId: body.error.requestId } : {}),
        ...(body.error?.details !== undefined ? { details: body.error.details } : {}),
      });
      if (response.status === 401) options.onUnauthenticated?.(error);
      throw error;
    }
    return body.data as O;
  }

  /** Any operation by path, typed by the caller: `client.$request('qa/ask', input)`. */
  async function request<O = unknown>(
    path: string,
    input: Record<string, unknown> = {},
    call: CallOptions = {},
  ): Promise<O> {
    const tenantId = (input.tenantId as string | undefined) ?? tenant();
    const response = await doFetch(url(path), {
      method: 'POST',
      credentials: options.credentials ?? 'include',
      headers: await headers({ 'content-type': 'application/json', ...call.headers }),
      body: JSON.stringify({ ...input, ...(tenantId ? { tenantId } : {}) }),
      ...(call.signal ? { signal: call.signal } : {}),
    });
    return parse<O>(response);
  }

  async function put(
    path: string,
    body: Blob | Uint8Array,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await doFetch(url(path), {
      method: 'PUT',
      credentials: options.credentials ?? 'include',
      headers: await headers({ 'content-type': 'application/octet-stream' }),
      body: body as BodyInit,
      ...(signal ? { signal } : {}),
    });
    return parse(response);
  }

  /** Uploads a file through an upload session: one request for small files, parallel retried parts for large ones. */
  async function upload(input: UploadInput) {
    const size = input.file instanceof Blob ? input.file.size : input.file.byteLength;
    const filename = input.filename ?? (input.file instanceof File ? input.file.name : undefined);
    if (!filename) throw new Error('upload needs a filename');
    const mimeType =
      input.mimeType ??
      (input.file instanceof Blob && input.file.type ? input.file.type : undefined);
    const tenantId = input.tenantId ?? tenant();
    const session = await request<UploadSession>('uploads/create', {
      ...(input.parentId ? { parentId: input.parentId } : {}),
      ...(input.documentId ? { documentId: input.documentId } : {}),
      filename,
      size,
      ...(mimeType ? { mimeType } : {}),
      ...(input.comment ? { comment: input.comment } : {}),
      ...(input.direct ? { direct: true } : {}),
      ...(tenantId ? { tenantId } : {}),
    });
    const slice = (start: number, end: number) =>
      input.file instanceof Blob ? input.file.slice(start, end) : input.file.subarray(start, end);
    const bytesOf = async (part: Blob | Uint8Array) =>
      part instanceof Uint8Array ? part : new Uint8Array(await part.arrayBuffer());
    const progress = new Map<number, number>();
    const report = () => {
      const loaded = [...progress.values()].reduce((sum, bytes) => sum + bytes, 0);
      input.onProgress?.({ loaded, total: size, ratio: size === 0 ? 1 : loaded / size });
    };
    const attempt = async (path: string, body: Blob | Uint8Array) => {
      const retries = input.retries ?? 3;
      for (let tries = 0; ; tries++) {
        try {
          return await put(path, body, input.signal);
        } catch (error) {
          const status = error instanceof BetterFilesClientError ? error.status : 0;
          const retryable = status === 0 || status >= 500 || status === 429;
          if (!retryable || tries >= retries || input.signal?.aborted) throw error;
          await sleep(250 * 2 ** tries, input.signal);
        }
      }
    };
    /** One PUT to the object store's presigned URL: no API headers or cookies, and the ETag comes back. */
    const putDirect = async (target: string, body: Uint8Array) => {
      const retries = input.retries ?? 3;
      for (let tries = 0; ; tries++) {
        let status = 0;
        try {
          const response = await doFetch(target, {
            method: 'PUT',
            credentials: 'omit',
            body: body as BodyInit,
            ...(input.signal ? { signal: input.signal } : {}),
          });
          status = response.status;
          if (!response.ok) throw new Error(`Storage refused the part (${response.status})`);
          // Azure's Put Block answers without an ETag; its checksum stands in (the adapter ignores it).
          const etag =
            response.headers.get('etag') ??
            response.headers.get('content-md5') ??
            response.headers.get('x-ms-content-crc64');
          if (!etag)
            throw new Error('Storage returned no ETag: expose ETag in the bucket CORS rules');
          return etag;
        } catch (error) {
          const retryable = status === 0 || status >= 500 || status === 429;
          if (!retryable || tries >= retries || input.signal?.aborted) throw error;
          await sleep(250 * 2 ** tries, input.signal);
        }
      }
    };
    try {
      if (session.direct) {
        const direct = session.direct;
        const etags: { part: number; etag: string }[] = [];
        const queue = [...direct.parts];
        const worker = async () => {
          for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
            const start = (next.part - 1) * direct.partSize;
            const end = Math.min(start + direct.partSize, size);
            const plain = await bytesOf(slice(start, end));
            const body = direct.encryption
              ? await encryptPart(plain, direct.encryption, start, size)
              : plain;
            etags.push({ part: next.part, etag: await putDirect(next.url, body) });
            progress.set(next.part, end - start);
            report();
          }
        };
        await Promise.all(
          Array.from(
            { length: Math.max(1, Math.min(input.concurrency ?? 3, direct.parts.length)) },
            worker,
          ),
        );
        return await request<{
          document: { id: string; name: string };
          version: { id: string; number: number };
        }>('uploads/complete', {
          uploadId: session.uploadId,
          parts: etags.sort((a, b) => a.part - b.part),
          ...(tenantId ? { tenantId } : {}),
        });
      }
      if (!session.multipart) {
        await attempt(session.contentUrl, slice(0, size));
        progress.set(1, size);
        report();
      } else {
        const queue = Array.from({ length: session.parts }, (_, index) => index + 1);
        const worker = async () => {
          for (let part = queue.shift(); part !== undefined; part = queue.shift()) {
            const start = (part - 1) * session.partSize;
            const end = Math.min(start + session.partSize, size);
            await attempt(session.partUrl.replace('{part}', String(part)), slice(start, end));
            progress.set(part, end - start);
            report();
          }
        };
        await Promise.all(
          Array.from(
            { length: Math.max(1, Math.min(input.concurrency ?? 3, session.parts)) },
            worker,
          ),
        );
      }
      return await request<{
        document: { id: string; name: string };
        version: { id: string; number: number };
      }>('uploads/complete', { uploadId: session.uploadId, ...(tenantId ? { tenantId } : {}) });
    } catch (error) {
      await request('uploads/abort', {
        uploadId: session.uploadId,
        ...(tenantId ? { tenantId } : {}),
      }).catch(() => undefined);
      throw error;
    }
  }

  /** An absolute URL for a ticket path returned by `documents.requestOriginal` and friends. */
  const fileUrl = (ticketUrl: string) => url(ticketUrl);

  const api = new Proxy({} as ClientApi<T['api']>, {
    get(target, group: string) {
      if (Object.hasOwn(target, group)) return (target as Record<string, unknown>)[group];
      if (typeof group !== 'string' || group === 'then') return undefined;
      return new Proxy(
        {},
        {
          get(__, method: string) {
            if (typeof method !== 'string' || method === 'then') return undefined;
            return (input: Record<string, unknown> = {}, call?: CallOptions) =>
              request(`${group}/${method}`, input, call);
          },
        },
      );
    },
  });

  /** Follows a room's activity live (`subscribe(roomId, { onActivity })`); returns `{ close }`. */
  const subscribe = (roomId: string, subscribeOptions: SubscribeOptions & { tenantId?: string }) =>
    subscribeRoom(
      {
        url: (id) => {
          const tenantId = subscribeOptions.tenantId ?? tenant();
          return url(
            `rooms/${encodeURIComponent(id)}/events${tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : ''}`,
          );
        },
        fetch: doFetch,
        headers: async () => (options.headers ? await options.headers() : {}),
        credentials: options.credentials ?? 'include',
      },
      roomId,
      subscribeOptions,
    );

  return Object.assign(api, { $request: request, upload, fileUrl, subscribe }) as ClientApi<
    T['api']
  > & {
    $request: typeof request;
    upload: typeof upload;
    fileUrl: typeof fileUrl;
    subscribe: typeof subscribe;
  };
}

export type BetterFilesClient<T extends { api: object }> = ReturnType<
  typeof createBetterFilesClient<T>
>;
export type { ApiShape };

type Output<F> = F extends (...args: never[]) => Promise<infer O> ? O : never;
/** The output of `client[G][M]` for a server type, plugins and host fields included. */
export type OperationResult<
  T extends { api: object },
  G extends string,
  M extends string,
> = G extends keyof ClientApi<T['api']>
  ? M extends keyof ClientApi<T['api']>[G]
    ? Output<ClientApi<T['api']>[G][M]>
    : never
  : never;

export {
  QueryCache,
  runQuery,
  standardQueries,
  uploadInvalidations,
  type CacheEntry,
  type QueryDefinition,
} from './cache.js';
