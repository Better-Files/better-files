import { BetterFilesError, invalidConfig } from '@better-files/core';
import {
  bindContext,
  fromBase64,
  keyRefs,
  KmsHttpError,
  requestJson,
  resolveSecret,
  roomKeyName,
  type KmsKeyProvider,
  type Secret,
} from './shared.js';

export interface VaultTransitOptions {
  /** `https://vault.example.com:8200` */
  address: string;
  /** A Vault token, or a function returning one (AppRole, Kubernetes auth). */
  token: Secret;
  keyName: string;
  /** Where the transit engine is mounted. Default `transit`. */
  mount?: string;
  /** Vault Enterprise / HCP namespace. */
  namespace?: string;
  /** A transit key per room. Retiring one allows deletion and deletes it. */
  perRoomKeys?: boolean | { type?: 'aes256-gcm96' | 'chacha20-poly1305' };
  fetch?: typeof fetch;
  retries?: number;
}

const NAME = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * HashiCorp Vault (or OpenBao) Transit as the key provider. Data keys come from `datakey/plaintext` and are derived
 * with the blob's encryption context, which binds them the way associated data would.
 */
export function vaultTransit(options: VaultTransitOptions): KmsKeyProvider {
  if (!NAME.test(options.keyName ?? ''))
    throw invalidConfig('vaultTransit: keyName may only contain letters, digits, _ . and -');
  const mount = (options.mount ?? 'transit').replace(/^\/+|\/+$/g, '');
  if (!/^[A-Za-z0-9_.\-/]+$/.test(mount)) throw invalidConfig('vaultTransit: invalid mount');
  const address = options.address.replace(/\/+$/, '');
  const refs = keyRefs('vault');
  const perRoom =
    options.perRoomKeys === true ? {} : options.perRoomKeys ? options.perRoomKeys : undefined;
  const http = { provider: 'Vault', fetch: options.fetch, retries: options.retries };

  function keyFor(keyRef: string): string {
    const name = refs.read(keyRef);
    if (!NAME.test(name))
      throw new BetterFilesError('INTERNAL_ERROR', 'Invalid Vault key reference');
    return name;
  }

  const call = <T>(method: string, path: string, body?: unknown) =>
    requestJson<T>(
      http,
      `${address}/v1/${mount}/${path}`,
      async () => ({
        method,
        headers: {
          'x-vault-token': await resolveSecret(options.token),
          ...(options.namespace ? { 'x-vault-namespace': options.namespace } : {}),
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      (_status, error) => {
        const errors = (error as { errors?: string[] } | undefined)?.errors;
        return errors?.length ? { message: errors.join('; ') } : {};
      },
    );

  const provider: KmsKeyProvider = {
    id: 'vault-transit',
    owns: refs.owns,
    async generateDataKey({ keyRef, context }) {
      const name = keyRef && refs.owns(keyRef) ? keyFor(keyRef) : options.keyName;
      const result = await call<{ data?: { plaintext?: string; ciphertext?: string } }>(
        'POST',
        `datakey/plaintext/${name}`,
        { bits: 256 },
      );
      if (!result?.data?.plaintext || !result.data.ciphertext)
        throw new BetterFilesError('INTERNAL_ERROR', 'Vault returned no data key');
      const seed = fromBase64(result.data.plaintext);
      try {
        return {
          plaintext: bindContext(seed, context),
          wrapped: result.data.ciphertext,
          keyRef: refs.make(name),
        };
      } finally {
        seed.fill(0);
      }
    },
    async decryptDataKey({ keyRef, wrapped, context }) {
      const result = await call<{ data?: { plaintext?: string } }>(
        'POST',
        `decrypt/${keyFor(keyRef)}`,
        { ciphertext: wrapped },
      );
      if (!result?.data?.plaintext)
        throw new BetterFilesError('INTERNAL_ERROR', 'Vault returned no data key');
      const seed = fromBase64(result.data.plaintext);
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
    async createRoomKey({ roomId }) {
      const name = roomKeyName(roomId);
      // Creating an existing key is a no-op in Transit, so retries are safe.
      await call('POST', `keys/${name}`, { type: perRoom.type ?? 'aes256-gcm96' });
      return refs.make(name);
    },
    async retireRoomKey({ keyRef }) {
      if (!refs.owns(keyRef)) return;
      const name = keyFor(keyRef);
      if (name === options.keyName) return;
      try {
        await call('POST', `keys/${name}/config`, { deletion_allowed: true });
        await call('DELETE', `keys/${name}`);
      } catch (error) {
        if (!(error instanceof KmsHttpError && error.status === 404)) throw error;
      }
    },
  };
}
