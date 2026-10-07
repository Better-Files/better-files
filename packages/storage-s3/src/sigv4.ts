import { createHash, createHmac } from 'node:crypto';

/** AWS Signature Version 4 for S3-compatible services (AWS S3, Cloudflare R2, MinIO, Backblaze B2, Wasabi). */

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) =>
  createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding, as SigV4 requires (encodeURIComponent leaves !'()* alone). */
export const encodeRfc3986 = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** S3 object paths keep their slashes; every segment is encoded once. */
export const encodePath = (path: string) => path.split('/').map(encodeRfc3986).join('/');

export const amzDate = (date: Date) => date.toISOString().replace(/[:-]|\.\d{3}/g, '');

function signingKey(secret: string, day: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), service), 'aws4_request');
}

function canonicalQuery(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map((key) => `${encodeRfc3986(key)}=${encodeRfc3986(query[key]!)}`)
    .join('&');
}

export interface SignInput {
  method: string;
  /** Already-encoded path, starting with `/`. */
  path: string;
  query?: Record<string, string>;
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  service?: string;
  credentials: AwsCredentials;
  date: Date;
}

/** Returns the Authorization header value; `headers` must include `host`, `x-amz-date` and `x-amz-content-sha256`. */
export function signHeaders(input: SignInput): string {
  const service = input.service ?? 's3';
  const time = amzDate(input.date);
  const day = time.slice(0, 8);
  const headers = Object.entries(input.headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const signedHeaders = headers.map(([name]) => name).join(';');
  const canonical = [
    input.method,
    input.path,
    canonicalQuery(input.query ?? {}),
    headers.map(([name, value]) => `${name}:${value}\n`).join(''),
    signedHeaders,
    input.payloadHash,
  ].join('\n');
  const scope = `${day}/${input.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', time, scope, sha256(canonical)].join('\n');
  const signature = createHmac(
    'sha256',
    signingKey(input.credentials.secretAccessKey, day, input.region, service),
  )
    .update(stringToSign)
    .digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

/** A presigned URL (query-string authentication), valid for `expiresInSeconds`. */
export function presignUrl(input: {
  method: string;
  url: URL;
  region: string;
  service?: string;
  credentials: AwsCredentials;
  date: Date;
  expiresInSeconds: number;
  extraHeaders?: Record<string, string>;
}): string {
  const service = input.service ?? 's3';
  const time = amzDate(input.date);
  const day = time.slice(0, 8);
  const scope = `${day}/${input.region}/${service}/aws4_request`;
  const headers: Record<string, string> = { host: input.url.host, ...input.extraHeaders };
  const signedHeaders = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort()
    .join(';');
  const query: Record<string, string> = {
    ...Object.fromEntries(input.url.searchParams),
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${input.credentials.accessKeyId}/${scope}`,
    'X-Amz-Date': time,
    'X-Amz-Expires': String(input.expiresInSeconds),
    'X-Amz-SignedHeaders': signedHeaders,
    ...(input.credentials.sessionToken
      ? { 'X-Amz-Security-Token': input.credentials.sessionToken }
      : {}),
  };
  const canonical = [
    input.method,
    input.url.pathname,
    canonicalQuery(query),
    Object.entries(headers)
      .map(([name, value]) => [name.toLowerCase(), value.trim()] as const)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, value]) => `${name}:${value}\n`)
      .join(''),
    signedHeaders,
    UNSIGNED_PAYLOAD,
  ].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', time, scope, sha256(canonical)].join('\n');
  const signature = createHmac(
    'sha256',
    signingKey(input.credentials.secretAccessKey, day, input.region, service),
  )
    .update(stringToSign)
    .digest('hex');
  return `${input.url.origin}${input.url.pathname}?${canonicalQuery(query)}&X-Amz-Signature=${signature}`;
}
