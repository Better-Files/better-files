import { invalidConfig, type KeyProvider } from '@better-files/core';
import { contextBytes } from '@better-files/crypto';
import type { KmsKeyProvider } from './shared.js';

/** Whether a provider issued a key reference: its `owns`, or the known shape of built-in providers. */
function ownership(provider: KeyProvider): ((keyRef: string) => boolean) | undefined {
  const owns = (provider as Partial<KmsKeyProvider>).owns;
  if (typeof owns === 'function') return owns.bind(provider);
  if (provider.id === 'local') return (keyRef) => keyRef.startsWith('local:');
  return undefined;
}

export interface MigratingKeysOptions {
  /** Wraps every new data key and creates new room keys. */
  current: KeyProvider;
  /** Providers that wrapped existing files. Each stored blob goes back to the one that issued its key reference. */
  previous: KeyProvider[];
}

/**
 * Moves an installation to another key provider without re-encrypting stored files: new files use `current`, and
 * existing files are unwrapped by the provider that wrapped them (found by key reference, or by trying providers
 * that cannot tell, such as Better IAM's KMS). Rooms whose key belongs to an old provider get new files wrapped
 * with `current`'s default key.
 */
export function migratingKeys(options: MigratingKeysOptions): KmsKeyProvider {
  const all = [options.current, ...options.previous];
  if (new Set(all.map((p) => p.id)).size !== all.length)
    throw invalidConfig('migratingKeys: providers must have different ids');
  const owners = all.map((provider) => ({ provider, owns: ownership(provider) }));
  const ownerOf = (keyRef: string) => owners.find((o) => o.owns?.(keyRef))?.provider;
  const currentOwns = owners[0]!.owns;
  const isCurrent = (keyRef: string) =>
    currentOwns ? currentOwns(keyRef) : ownerOf(keyRef) === undefined;

  return {
    id: `migrating:${options.current.id}`,
    owns: (keyRef) => owners.some((o) => o.owns?.(keyRef) ?? true),
    ...(options.current.createRoomKey
      ? { createRoomKey: (input) => options.current.createRoomKey!(input) }
      : {}),
    async retireRoomKey(input) {
      const owner = ownerOf(input.keyRef) ?? (currentOwns ? undefined : options.current);
      await owner?.retireRoomKey?.(input);
    },
    generateDataKey({ tenantId, keyRef, context }) {
      return options.current.generateDataKey({
        tenantId,
        context,
        ...(keyRef && isCurrent(keyRef) ? { keyRef } : {}),
      });
    },
    async decryptDataKey(input) {
      const owner = ownerOf(input.keyRef);
      if (owner) return owner.decryptDataKey(input);
      let last: unknown;
      for (const { provider, owns } of owners) {
        if (owns) continue;
        try {
          return await provider.decryptDataKey(input);
        } catch (error) {
          last = error;
        }
      }
      throw last ?? invalidConfig(`No key provider issued the key reference ${input.keyRef}`);
    },
  };
}

export interface CachingKeysOptions {
  /** How long an unwrapped data key is kept in memory. Default 5 minutes. */
  maxAgeMs?: number;
  /** Most data keys kept. Default 1000. */
  maxEntries?: number;
}

/**
 * Keeps unwrapped data keys in memory for a while, so streaming a popular document does not call the KMS on every
 * request. This trades KMS cost and latency for plaintext keys in process memory and for key revocation taking
 * effect only after `maxAgeMs`; leave it off where that matters more.
 */
export function cachingKeys<P extends KeyProvider>(
  provider: P,
  options: CachingKeysOptions = {},
): P & { clear(): void } {
  const maxAge = options.maxAgeMs ?? 5 * 60_000;
  const maxEntries = options.maxEntries ?? 1000;
  const cache = new Map<string, { key: Uint8Array; expires: number }>();
  const forget = (id: string) => {
    cache.get(id)?.key.fill(0);
    cache.delete(id);
  };

  return {
    ...provider,
    clear() {
      for (const id of [...cache.keys()]) forget(id);
    },
    async decryptDataKey(input) {
      const id = JSON.stringify([
        input.tenantId,
        input.keyRef,
        input.wrapped,
        Buffer.from(contextBytes(input.context)).toString('base64'),
      ]);
      const now = Date.now();
      const hit = cache.get(id);
      if (hit && hit.expires > now) {
        // Least recently used goes first.
        cache.delete(id);
        cache.set(id, hit);
        return hit.key.slice();
      }
      if (hit) forget(id);
      const key = await provider.decryptDataKey(input);
      cache.set(id, { key: key.slice(), expires: now + maxAge });
      while (cache.size > maxEntries) forget(cache.keys().next().value!);
      return key;
    },
  };
}
