import { createHash, createSign } from 'node:crypto';
import { BetterFilesError, invalidConfig } from '@better-files/core';

/** The fields Better Files reads from a Google service-account JSON key file. */
export interface GoogleServiceAccountKey {
  client_email: string;
  private_key: string;
  /** Default `https://oauth2.googleapis.com/token`. */
  token_uri?: string;
}

/** A static secret or a function that returns a fresh one (for example from google-auth-library). */
export type Secret = string | (() => string | Promise<string>);

export const STORAGE_SCOPE = 'https://www.googleapis.com/auth/devstorage.read_write';

const base64url = (input: string | Buffer) => Buffer.from(input).toString('base64url');

/**
 * Mints OAuth access tokens from a service-account key with the JWT bearer grant (RFC 7523), caching each token until
 * a minute before it expires and sharing one request between concurrent callers.
 */
export function serviceAccountTokens(
  key: GoogleServiceAccountKey,
  options: { scope?: string; fetch?: typeof fetch; now?: () => number } = {},
): () => Promise<string> {
  if (!key?.client_email || !key.private_key)
    throw invalidConfig('A service-account key needs client_email and private_key');
  const tokenUri = key.token_uri ?? 'https://oauth2.googleapis.com/token';
  const now = options.now ?? Date.now;
  let cached: { token: string; expiresAt: number } | undefined;
  let pending: Promise<string> | undefined;

  async function mint(): Promise<string> {
    const issuedAt = Math.floor(now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64url(
      JSON.stringify({
        iss: key.client_email,
        scope: options.scope ?? STORAGE_SCOPE,
        aud: tokenUri,
        iat: issuedAt,
        exp: issuedAt + 3600,
      }),
    );
    const signature = createSign('RSA-SHA256')
      .update(`${header}.${claims}`)
      .sign(key.private_key)
      .toString('base64url');
    const response = await (options.fetch ?? globalThis.fetch)(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${header}.${claims}.${signature}`,
      }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!response.ok || !body.access_token)
      throw new BetterFilesError(
        'INTERNAL_ERROR',
        `Google token request failed: ${response.status}${body.error ? ` ${body.error}` : ''}`,
      );
    cached = {
      token: body.access_token,
      expiresAt: now() + Math.max(0, (body.expires_in ?? 3600) - 60) * 1000,
    };
    return body.access_token;
  }

  return async () => {
    if (cached && now() < cached.expiresAt) return cached.token;
    pending ??= mint().finally(() => (pending = undefined));
    return pending;
  };
}

/** RFC 3986 encoding, as V4 signing requires (`encodeURIComponent` leaves `!'()*` alone). */
export const encodeRfc3986 = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const stamp = (date: Date) =>
  date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

/**
 * A V4 signed URL (`GOOG4-RSA-SHA256`) for the XML API, signed locally with the service account's private key.
 * `url` is the object URL (`https://storage.googleapis.com/{bucket}/{object}`) with any extra query parameters.
 */
export function signedUrl(input: {
  method: string;
  url: URL;
  key: GoogleServiceAccountKey;
  date: Date;
  expiresInSeconds: number;
  headers?: Record<string, string>;
}): string {
  if (input.expiresInSeconds < 1 || input.expiresInSeconds > 604_800)
    throw invalidConfig('Signed URLs last between 1 second and 7 days');
  const datetime = stamp(input.date);
  const scope = `${datetime.slice(0, 8)}/auto/storage/goog4_request`;
  const headers: Record<string, string> = { host: input.url.host };
  for (const [name, value] of Object.entries(input.headers ?? {}))
    headers[name.toLowerCase()] = value.trim();
  const headerNames = Object.keys(headers).sort();
  const signedHeaders = headerNames.join(';');

  const query: [string, string][] = [...input.url.searchParams.entries()];
  query.push(
    ['X-Goog-Algorithm', 'GOOG4-RSA-SHA256'],
    ['X-Goog-Credential', `${input.key.client_email}/${scope}`],
    ['X-Goog-Date', datetime],
    ['X-Goog-Expires', String(input.expiresInSeconds)],
    ['X-Goog-SignedHeaders', signedHeaders],
  );
  const canonicalQuery = query
    .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
  const canonicalRequest = [
    input.method,
    input.url.pathname,
    canonicalQuery,
    headerNames.map((name) => `${name}:${headers[name]}\n`).join(''),
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = [
    'GOOG4-RSA-SHA256',
    datetime,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const signature = createSign('RSA-SHA256')
    .update(stringToSign)
    .sign(input.key.private_key)
    .toString('hex');
  return `${input.url.origin}${input.url.pathname}?${canonicalQuery}&X-Goog-Signature=${signature}`;
}
