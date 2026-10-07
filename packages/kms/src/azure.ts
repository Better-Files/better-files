import { BetterFilesError, invalidConfig } from '@better-files/core';
import {
  bindContext,
  freshKey,
  keyRefs,
  KmsHttpError,
  requestJson,
  resolveSecret,
  roomKeyName,
  type KmsKeyProvider,
  type Secret,
} from './shared.js';

export interface AzureKeyVaultOptions {
  /** `https://{vault}.vault.azure.net` or a Managed HSM URL. */
  vaultUrl: string;
  keyName: string;
  /** A Microsoft Entra access token for `https://vault.azure.net`, or a function returning one (@azure/identity). */
  accessToken: Secret;
  /** Wrapping algorithm. Default `RSA-OAEP-256`; use `A256KW` with Managed HSM `oct-HSM` keys. */
  algorithm?: 'RSA-OAEP-256' | 'RSA-OAEP' | 'A256KW';
  apiVersion?: string;
  /** A key per room. Retiring it deletes the key (recoverable during the vault's soft-delete period). */
  perRoomKeys?: boolean | { keyType?: 'RSA' | 'RSA-HSM'; keySize?: 2048 | 3072 | 4096 };
  fetch?: typeof fetch;
  retries?: number;
}

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const fromB64url = (text: string) => new Uint8Array(Buffer.from(text, 'base64url'));

/**
 * Azure Key Vault (or Managed HSM) as the key provider. A random seed is wrapped with `wrapkey`, and the data key
 * is derived from the seed and the blob's encryption context, since key wrapping takes no associated data.
 */
export function azureKeyVault(options: AzureKeyVaultOptions): KmsKeyProvider {
  let vault: URL;
  try {
    vault = new URL(options.vaultUrl);
  } catch {
    throw invalidConfig('azureKeyVault: vaultUrl must be a URL');
  }
  if (
    vault.protocol !== 'https:' &&
    vault.hostname !== 'localhost' &&
    vault.hostname !== '127.0.0.1'
  )
    throw invalidConfig('azureKeyVault: vaultUrl must use https');
  if (!/^[0-9A-Za-z-]{1,127}$/.test(options.keyName ?? ''))
    throw invalidConfig('azureKeyVault: keyName may only contain letters, digits and dashes');
  const origin = vault.origin;
  const algorithm = options.algorithm ?? 'RSA-OAEP-256';
  const apiVersion = options.apiVersion ?? '7.4';
  const refs = keyRefs('azure-kv');
  const perRoom =
    options.perRoomKeys === true ? {} : options.perRoomKeys ? options.perRoomKeys : undefined;
  const http = { provider: 'Azure Key Vault', fetch: options.fetch, retries: options.retries };

  // A key reference is a key URL (with or without a version) in this vault. Anything else is refused before the
  // bearer token is sent, so a tampered row cannot redirect it to another host.
  function keyUrl(keyRef: string): string {
    const value = refs.read(keyRef);
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new BetterFilesError('INTERNAL_ERROR', 'Invalid Key Vault key reference');
    }
    if (url.origin !== origin || !/^\/keys\/[0-9A-Za-z-]+(\/[0-9A-Za-z]+)?$/.test(url.pathname))
      throw new BetterFilesError('INTERNAL_ERROR', 'The key reference is outside this vault');
    return `${origin}${url.pathname}`;
  }

  const call = <T>(method: string, url: string, body?: unknown) =>
    requestJson<T>(
      http,
      `${url}?api-version=${encodeURIComponent(apiVersion)}`,
      async () => ({
        method,
        headers: {
          authorization: `Bearer ${await resolveSecret(options.accessToken)}`,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      (_status, error) => {
        const e = (error as { error?: { code?: string; message?: string } } | undefined)?.error;
        return {
          ...(e?.code ? { code: e.code } : {}),
          ...(e?.message ? { message: e.message } : {}),
        };
      },
    );

  const provider: KmsKeyProvider = {
    id: 'azure-key-vault',
    owns: refs.owns,
    async generateDataKey({ keyRef, context }) {
      const url =
        keyRef && refs.owns(keyRef) ? keyUrl(keyRef) : `${origin}/keys/${options.keyName}`;
      const seed = freshKey();
      try {
        const result = await call<{ kid?: string; value?: string }>('POST', `${url}/wrapkey`, {
          alg: algorithm,
          value: b64url(seed),
        });
        if (!result?.value)
          throw new BetterFilesError('INTERNAL_ERROR', 'Key Vault returned no wrapped key');
        // The kid names the exact key version, which unwrapping needs after rotation.
        const versioned = result.kid ? keyUrl(refs.make(result.kid)) : url;
        return {
          plaintext: bindContext(seed, context),
          wrapped: result.value,
          keyRef: refs.make(versioned),
        };
      } finally {
        seed.fill(0);
      }
    },
    async decryptDataKey({ keyRef, wrapped, context }) {
      const result = await call<{ value?: string }>('POST', `${keyUrl(keyRef)}/unwrapkey`, {
        alg: algorithm,
        value: wrapped,
      });
      if (!result?.value)
        throw new BetterFilesError('INTERNAL_ERROR', 'Key Vault returned no data key');
      const seed = fromB64url(result.value);
      try {
        return bindContext(seed, context);
      } finally {
        seed.fill(0);
      }
    },
  };
  if (!perRoom) return provider;

  return {
    ...provider,
    async createRoomKey({ tenantId, roomId }) {
      const name = roomKeyName(roomId);
      const keyType = perRoom.keyType ?? 'RSA';
      await call('POST', `${origin}/keys/${name}/create`, {
        kty: keyType,
        key_size: perRoom.keySize ?? 3072,
        key_ops: ['wrapKey', 'unwrapKey'],
        tags: { 'better-files': 'room', tenantId, roomId },
      });
      return refs.make(`${origin}/keys/${name}`);
    },
    async retireRoomKey({ keyRef }) {
      if (!refs.owns(keyRef)) return;
      const name = /^\/keys\/([0-9A-Za-z-]+)/.exec(new URL(keyUrl(keyRef)).pathname)![1]!;
      // Never delete the shared key, even if a room was pointed at it.
      if (name === options.keyName) return;
      try {
        await call('DELETE', `${origin}/keys/${name}`);
      } catch (error) {
        if (!(error instanceof KmsHttpError && error.status === 404)) throw error;
      }
    },
  };
}
