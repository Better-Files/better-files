import { BetterFilesError, invalidConfig } from '@better-files/core';
import { contextBytes } from '@better-files/crypto';
import {
  freshKey,
  fromBase64,
  keyRefs,
  KmsHttpError,
  requestJson,
  resolveSecret,
  roomKeyName,
  toBase64,
  type KmsKeyProvider,
  type Secret,
} from './shared.js';

export interface GcpKmsOptions {
  /** `projects/{project}/locations/{location}/keyRings/{ring}/cryptoKeys/{key}` */
  keyName: string;
  /** An OAuth access token with `cloudkms` scope, or a function returning one (e.g. from google-auth-library). */
  accessToken: Secret;
  /** Default `https://cloudkms.googleapis.com`. */
  endpoint?: string;
  /**
   * A crypto key per room in the same key ring. Cloud KMS never deletes keys, so retiring one destroys its versions
   * (after the key's scheduled-destruction period).
   */
  perRoomKeys?: boolean | { protectionLevel?: 'SOFTWARE' | 'HSM'; labels?: Record<string, string> };
  fetch?: typeof fetch;
  retries?: number;
}

const KEY_NAME = /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/;

/**
 * Google Cloud KMS as the key provider. Data keys are generated locally and wrapped with `cryptoKeys.encrypt`, with
 * the blob's encryption context as additional authenticated data.
 */
export function gcpKms(options: GcpKmsOptions): KmsKeyProvider {
  if (!KEY_NAME.test(options.keyName ?? ''))
    throw invalidConfig(
      'gcpKms: keyName must be projects/{p}/locations/{l}/keyRings/{r}/cryptoKeys/{k}',
    );
  const endpoint = (options.endpoint ?? 'https://cloudkms.googleapis.com').replace(/\/+$/, '');
  const keyRing = options.keyName.slice(0, options.keyName.indexOf('/cryptoKeys/'));
  const refs = keyRefs('gcp-kms');
  const perRoom =
    options.perRoomKeys === true ? {} : options.perRoomKeys ? options.perRoomKeys : undefined;
  const http = { provider: 'Cloud KMS', fetch: options.fetch, retries: options.retries };

  // Key references name a key in this provider's key ring; a reference to anything else is refused before a token
  // is sent anywhere.
  function keyFor(keyRef: string): string {
    const name = refs.read(keyRef);
    if (!KEY_NAME.test(name) || !name.startsWith(`${keyRing}/cryptoKeys/`))
      throw new BetterFilesError('INTERNAL_ERROR', 'The key reference is outside the key ring');
    return name;
  }

  const call = <T>(method: string, path: string, body?: unknown) =>
    requestJson<T>(
      http,
      `${endpoint}/v1/${path}`,
      async () => ({
        method,
        headers: {
          authorization: `Bearer ${await resolveSecret(options.accessToken)}`,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      (_status, error) => {
        const e = (error as { error?: { status?: string; message?: string } } | undefined)?.error;
        return {
          ...(e?.status ? { code: e.status } : {}),
          ...(e?.message ? { message: e.message } : {}),
        };
      },
    );

  const provider: KmsKeyProvider = {
    id: 'gcp-kms',
    owns: refs.owns,
    async generateDataKey({ keyRef, context }) {
      const keyName = keyRef && refs.owns(keyRef) ? keyFor(keyRef) : options.keyName;
      const plaintext = freshKey();
      const result = await call<{ ciphertext?: string }>('POST', `${keyName}:encrypt`, {
        plaintext: toBase64(plaintext),
        additionalAuthenticatedData: toBase64(contextBytes(context)),
      });
      if (!result?.ciphertext)
        throw new BetterFilesError('INTERNAL_ERROR', 'Cloud KMS returned no ciphertext');
      return { plaintext, wrapped: result.ciphertext, keyRef: refs.make(keyName) };
    },
    async decryptDataKey({ keyRef, wrapped, context }) {
      const result = await call<{ plaintext?: string }>('POST', `${keyFor(keyRef)}:decrypt`, {
        ciphertext: wrapped,
        additionalAuthenticatedData: toBase64(contextBytes(context)),
      });
      if (!result?.plaintext)
        throw new BetterFilesError('INTERNAL_ERROR', 'Cloud KMS returned no data key');
      return fromBase64(result.plaintext);
    },
  };
  if (!perRoom) return provider;

  return {
    ...provider,
    async createRoomKey({ roomId }) {
      const id = roomKeyName(roomId);
      const name = `${keyRing}/cryptoKeys/${id}`;
      try {
        await call('POST', `${keyRing}/cryptoKeys?cryptoKeyId=${encodeURIComponent(id)}`, {
          purpose: 'ENCRYPT_DECRYPT',
          versionTemplate: {
            algorithm: 'GOOGLE_SYMMETRIC_ENCRYPTION',
            protectionLevel: perRoom.protectionLevel ?? 'SOFTWARE',
          },
          labels: { 'better-files': 'room', ...perRoom.labels },
        });
      } catch (error) {
        // A retried room creation finds its key already there.
        if (!(error instanceof KmsHttpError && error.status === 409)) throw error;
      }
      return refs.make(name);
    },
    async retireRoomKey({ keyRef }) {
      if (!refs.owns(keyRef)) return;
      const name = keyFor(keyRef);
      let pageToken: string | undefined;
      do {
        const page = await call<{
          cryptoKeyVersions?: { name: string; state: string }[];
          nextPageToken?: string;
        }>(
          'GET',
          `${name}/cryptoKeyVersions?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
        ).catch((error: unknown) => {
          if (error instanceof KmsHttpError && error.status === 404) return undefined;
          throw error;
        });
        for (const version of page?.cryptoKeyVersions ?? [])
          if (version.state === 'ENABLED' || version.state === 'DISABLED')
            await call('POST', `${version.name}:destroy`, {});
        pageToken = page?.nextPageToken;
      } while (pageToken);
    },
  };
}
