import { hkdfSync, randomBytes } from 'node:crypto';
import {
  BetterFilesError,
  invalidConfig,
  type EncryptionContext,
  type KeyProvider,
} from '@better-files/core';
import { contextBytes } from '@better-files/crypto';

/**
 * A key provider whose key references carry its own prefix (`aws-kms:…`, `gcp-kms:…`), so `migratingKeys` can send
 * each stored blob to the provider that wrapped it.
 */
export interface KmsKeyProvider extends KeyProvider {
  /** True when `keyRef` was issued by this provider. */
  owns(keyRef: string): boolean;
}

/** A static secret or a function that returns a fresh one (short-lived cloud tokens). */
export type Secret = string | (() => string | Promise<string>);

export const resolveSecret = async (secret: Secret) =>
  typeof secret === 'function' ? secret() : secret;

export const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
export const fromBase64 = (text: string) => new Uint8Array(Buffer.from(text, 'base64'));

export function freshKey(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}

/**
 * Binds a data key to its encryption context for key services that have no associated data on wrap (Azure Key
 * Vault, Vault Transit): the key the engine uses is HKDF(seed, context). Unwrapping with another context yields a
 * different key, and the file then fails its integrity check, the same outcome as an AAD mismatch.
 */
export function bindContext(seed: Uint8Array, context: EncryptionContext): Uint8Array {
  return new Uint8Array(
    hkdfSync('sha256', seed, 'better-files:kms:bind:v1', contextBytes(context), 32),
  );
}

export function keyRefs(prefix: string) {
  const head = `${prefix}:`;
  return {
    make: (value: string) => head + value,
    owns: (keyRef: string) => keyRef.startsWith(head),
    read(keyRef: string): string {
      if (!keyRef.startsWith(head))
        throw new BetterFilesError('INTERNAL_ERROR', `The key reference is not a ${prefix} key`);
      return keyRef.slice(head.length);
    },
  };
}

/** Room ids made safe for key names (`[A-Za-z0-9-]`), within the services' length limits. */
export function roomKeyName(roomId: string, prefix = 'better-files-'): string {
  return (prefix + roomId.replace(/[^A-Za-z0-9-]/g, '-')).slice(0, 63);
}

export interface HttpOptions {
  provider: string;
  fetch?: typeof fetch | undefined;
  /** Retries for throttling (429) and server errors (5xx). Default 2. */
  retries?: number | undefined;
  /** Error codes that are also retried (AWS reports throttling as 400 `ThrottlingException`). */
  retryCodes?: readonly string[] | undefined;
}

export class KmsHttpError extends BetterFilesError {
  constructor(
    readonly provider: string,
    readonly status: number,
    readonly kmsCode: string | undefined,
    message: string,
  ) {
    super(
      status === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR',
      `${provider} request failed: ${status}${kmsCode ? ` ${kmsCode}` : ''}${message ? `: ${message}` : ''}`,
    );
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Sends a JSON request, retrying throttling and server errors with jittered backoff, and parses the reply. */
export async function requestJson<T>(
  http: HttpOptions,
  url: string | URL,
  init: () => Promise<RequestInit> | RequestInit,
  readError: (status: number, body: unknown) => { code?: string; message?: string } = () => ({}),
): Promise<T> {
  const doFetch = http.fetch ?? globalThis.fetch;
  const retries = http.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    const response = await doFetch(url, await init());
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    if (response.ok) return body as T;
    const detail = readError(response.status, body);
    const retryable =
      response.status === 429 ||
      response.status >= 500 ||
      (detail.code !== undefined && (http.retryCodes ?? []).includes(detail.code));
    if (retryable && attempt < retries) {
      await sleep(100 * 2 ** attempt + Math.random() * 100);
      continue;
    }
    throw new KmsHttpError(
      http.provider,
      response.status,
      detail.code,
      (detail.message ?? '').slice(0, 300),
    );
  }
}

export function requireOption(value: string | undefined, name: string): string {
  if (!value) throw invalidConfig(`${name} is required`);
  return value;
}
