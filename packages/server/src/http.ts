import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { BetterFilesError, type Credential, type Logger } from '@better-files/core';
import type { RequestInfo } from './pipeline.js';
import type { StreamOptions } from './stream.js';

export type ApiFunction = (
  credential: Credential,
  input: unknown,
  request?: RequestInfo,
) => Promise<unknown>;
export type ApiTable = Record<string, Record<string, ApiFunction>>;

const securityHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

function json(status: number, body: unknown, requestId?: string): Response {
  const headers: Record<string, string> = { ...securityHeaders };
  if (requestId) headers['x-request-id'] = requestId;
  return new Response(JSON.stringify(body), { status, headers });
}

/** Errors from the identity system (Better IAM's IamError) carry the same code/status shape. */
function errorShape(
  error: unknown,
): { status: number; code: string; message: string; details?: unknown } | undefined {
  if (error instanceof BetterFilesError)
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    };
  if (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { status?: unknown }).status === 'number' &&
    typeof (error as { code?: unknown }).code === 'string'
  ) {
    const { status, code, message } = error as { status: number; code: string; message?: string };
    if (status >= 400 && status < 500) return { status, code, message: message ?? code };
  }
  return undefined;
}

export interface HttpOptions {
  basePath: string;
  trustedOrigins: readonly string[];
  maxJsonBodyBytes: number;
  /** Trust `x-forwarded-for` for the client address (behind a proxy you control). */
  trustProxy: boolean;
  logger: Logger;
  api: ApiTable;
  upload(
    credential: Credential,
    input: { tenantId: string; uploadId: string; part?: number; body: ReadableStream<Uint8Array> },
    request: RequestInfo,
  ): Promise<unknown>;
  serve(token: string, request: { method: string; range: string | null }): Promise<Response>;
  stream(credential: Credential, options: StreamOptions): Promise<Response>;
}

const segment = /^[a-zA-Z][a-zA-Z0-9-]{0,63}$/;
const requestIdPattern = /^[A-Za-z0-9._-]{1,128}$/;

export function createHttp(options: HttpOptions) {
  const base = options.basePath.replace(/\/+$/, '');

  function originAllowed(request: Request, url: URL): boolean {
    // Cookie-bearing requests must come from an exact trusted origin (CSRF); bearer-token requests need not.
    if (!request.headers.get('cookie')) return true;
    const origin = request.headers.get('origin');
    if (!origin) return false;
    return origin === url.origin || options.trustedOrigins.includes(origin);
  }

  function clientInfo(request: Request): RequestInfo {
    const forwarded = options.trustProxy
      ? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      : undefined;
    const ip = forwarded || undefined;
    const userAgent = request.headers.get('user-agent') ?? undefined;
    return {
      ...(ip && /^[0-9a-fA-F:.]{2,45}$/.test(ip) ? { ip } : {}),
      ...(userAgent ? { userAgent } : {}),
    };
  }

  function guard(request: Request, url: URL) {
    if (request.headers.get('x-better-files') !== '1')
      throw new BetterFilesError('FORBIDDEN', 'Missing X-Better-Files header');
    if (!originAllowed(request, url)) throw new BetterFilesError('FORBIDDEN', 'Untrusted origin');
  }

  async function handler(request: Request, extra: { ip?: string } = {}): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== base && !url.pathname.startsWith(`${base}/`))
      return json(404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    const path = url.pathname.slice(base.length + 1);
    const parts = path.split('/');
    const incomingId = request.headers.get('x-request-id');
    const requestId = incomingId && requestIdPattern.test(incomingId) ? incomingId : undefined;
    try {
      if (request.method === 'GET' && path === 'health') return json(200, { data: { ok: true } });
      if (request.method === 'OPTIONS') return preflight(request, url);
      if (
        (request.method === 'GET' || request.method === 'HEAD') &&
        parts[0] === 'files' &&
        parts.length === 2
      )
        return await options.serve(decodeURIComponent(parts[1]!), {
          method: request.method,
          range: request.headers.get('range'),
        });
      if (
        request.method === 'GET' &&
        parts[0] === 'rooms' &&
        parts[2] === 'events' &&
        parts.length === 3
      ) {
        // EventSource cannot send headers, so this read-only stream skips X-Better-Files; a cross-site page still
        // cannot read it without a trusted origin.
        const origin = request.headers.get('origin');
        if (origin && origin !== url.origin && !options.trustedOrigins.includes(origin))
          throw new BetterFilesError('FORBIDDEN', 'Untrusted origin');
        const tenantId = url.searchParams.get('tenantId');
        if (!tenantId) throw new BetterFilesError('INVALID_INPUT', 'tenantId is required');
        const resume = request.headers.get('last-event-id') ?? url.searchParams.get('after');
        const after = resume && /^\d{1,15}$/.test(resume) ? Number(resume) : undefined;
        return await options.stream(
          { headers: request.headers },
          {
            tenantId,
            roomId: decodeURIComponent(parts[1]!),
            ...(after !== undefined ? { after } : {}),
            signal: request.signal,
          },
        );
      }
      if (request.method === 'PUT' && parts[0] === 'uploads' && parts.length >= 3) {
        guard(request, url);
        const tenantId = url.searchParams.get('tenantId');
        if (!tenantId) throw new BetterFilesError('INVALID_INPUT', 'tenantId is required');
        if (!request.body) throw new BetterFilesError('INVALID_INPUT', 'The request has no body');
        let part: number | undefined;
        if (parts[2] === 'parts' && parts.length === 4) part = Number(parts[3]);
        else if (parts[2] !== 'content' || parts.length !== 3)
          throw new BetterFilesError('NOT_FOUND', 'Unknown operation');
        if (part !== undefined && !Number.isInteger(part))
          throw new BetterFilesError('INVALID_INPUT', 'Invalid part number');
        const info = { ...clientInfo(request), ...(extra.ip ? { ip: extra.ip } : {}) };
        const data = await options.upload(
          { headers: request.headers },
          {
            tenantId,
            uploadId: decodeURIComponent(parts[1]!),
            ...(part === undefined ? {} : { part }),
            body: request.body,
          },
          info,
        );
        return json(200, { data }, requestId);
      }
      if (request.method !== 'POST')
        throw new BetterFilesError('NOT_FOUND', 'Not found', { status: 405 });
      const [group, method, ...rest] = parts;
      const known =
        group !== undefined &&
        method !== undefined &&
        rest.length === 0 &&
        segment.test(group) &&
        segment.test(method) &&
        Object.hasOwn(options.api, group) &&
        Object.hasOwn(options.api[group]!, method);
      if (!known) throw new BetterFilesError('NOT_FOUND', 'Unknown operation');
      if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json'))
        throw new BetterFilesError('INVALID_INPUT', 'Expected application/json', { status: 415 });
      guard(request, url);
      const body = await readJson(request, options.maxJsonBodyBytes);
      const info = { ...clientInfo(request), ...(extra.ip ? { ip: extra.ip } : {}) };
      const data = await options.api[group]![method]!({ headers: request.headers }, body, info);
      return json(200, { data: data ?? null }, requestId);
    } catch (error) {
      const shape = errorShape(error);
      if (shape)
        return json(
          shape.status,
          {
            error: {
              code: shape.code,
              message: shape.message,
              ...(shape.details ? { details: shape.details } : {}),
              ...(requestId ? { requestId } : {}),
            },
          },
          requestId,
        );
      options.logger.error('Unhandled error in better-files handler', {
        error: error instanceof Error ? error.message : String(error),
        requestId,
      });
      return json(
        500,
        {
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Internal error',
            ...(requestId ? { requestId } : {}),
          },
        },
        requestId,
      );
    }
  }

  function preflight(request: Request, url: URL): Response {
    const origin = request.headers.get('origin');
    if (!origin || (origin !== url.origin && !options.trustedOrigins.includes(origin)))
      return new Response(null, { status: 204 });
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': origin,
        'access-control-allow-credentials': 'true',
        'access-control-allow-methods': 'GET, HEAD, POST, PUT, OPTIONS',
        'access-control-allow-headers':
          'content-type, x-better-files, x-request-id, authorization, range',
        'access-control-max-age': '600',
        vary: 'origin',
      },
    });
  }

  /** Node `http` adapter: JSON bodies are read up to the limit; uploads and downloads stream. */
  async function nodeHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host ?? 'localhost';
    const protocol = (req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http';
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers))
      if (Array.isArray(value)) for (const v of value) headers.append(key, v);
      else if (value !== undefined) headers.set(key, value);
    const method = req.method ?? 'GET';
    let body: BodyInit | undefined;
    if (method === 'POST') {
      try {
        body = await readNodeBody(req, options.maxJsonBodyBytes);
      } catch (error) {
        return writeResponse(
          res,
          json(413, { error: { code: 'PAYLOAD_TOO_LARGE', message: (error as Error).message } }),
        );
      }
    } else if (method === 'PUT') body = Readable.toWeb(req) as unknown as BodyInit;
    const request = new Request(`${protocol}://${host}${req.url ?? '/'}`, {
      method,
      headers,
      ...(body ? { body, duplex: 'half' } : {}),
    } as RequestInit);
    const ip = req.socket.remoteAddress;
    await writeResponse(res, await handler(request, ip ? { ip } : {}));
  }

  return { handler, nodeHandler };
}

async function readJson(request: Request, limit: number): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > limit)
    throw new BetterFilesError('PAYLOAD_TOO_LARGE', 'Request body is too large');
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > limit)
    throw new BetterFilesError('PAYLOAD_TOO_LARGE', 'Request body is too large');
  if (text.length === 0) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BetterFilesError('INVALID_INPUT', 'Malformed JSON');
  }
}

function readNodeBody(req: IncomingMessage, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > limit) {
        reject(new Error('Request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (!response.body) {
    res.end();
    return;
  }
  // Stream downloads instead of buffering them.
  await new Promise<void>((resolve, reject) => {
    const stream = Readable.fromWeb(
      response.body as import('node:stream/web').ReadableStream<Uint8Array>,
    );
    stream.on('error', (error) => {
      res.destroy(error);
      reject(error);
    });
    res.on('close', resolve);
    stream.pipe(res);
  });
}
