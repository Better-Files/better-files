import { BetterFilesError, invalidConfig, type KeyProvider } from '@better-files/core';
import type { KmsKeyProvider } from './shared.js';

export interface RegionalKeysOptions {
  /** A key provider per data-residency region, e.g. `{ eu: awsKms({ region: 'eu-central-1', … }), us: … }`. */
  regions: Record<string, KeyProvider>;
  /** The region for rooms created without one, and for key references made before `regionalKeys`. */
  defaultRegion: string;
}

const PREFIX = 'region:';

/**
 * Keeps each room's keys in its data-residency region: creating a room asks that region's provider for the room key,
 * and every later wrap and unwrap goes to the same provider. Rooms get a key reference even when the regional
 * provider has no keys per room (`region:{name}:`, meaning the region's default key), so a room's region always
 * travels with its files. A room in a region with no provider is refused rather than keyed elsewhere.
 */
export function regionalKeys(options: RegionalKeysOptions): KmsKeyProvider {
  const names = Object.keys(options.regions);
  if (!names.length) throw invalidConfig('regionalKeys: name at least one region');
  for (const name of names)
    if (!/^[A-Za-z0-9_-]+$/.test(name))
      throw invalidConfig(`regionalKeys: invalid region name "${name}"`);
  if (!options.regions[options.defaultRegion])
    throw invalidConfig('regionalKeys: defaultRegion must be one of the regions');

  const providerFor = (region: string): KeyProvider => {
    const provider = options.regions[region];
    if (!provider)
      throw new BetterFilesError('INVALID_CONFIG', `No key provider for the region "${region}"`);
    return provider;
  };
  /** Splits `region:{name}:{inner}`; references from before regionalKeys belong to the default region. */
  const parse = (keyRef: string) => {
    if (!keyRef.startsWith(PREFIX)) return { region: options.defaultRegion, inner: keyRef };
    const rest = keyRef.slice(PREFIX.length);
    const colon = rest.indexOf(':');
    if (colon <= 0) throw new BetterFilesError('INTERNAL_ERROR', 'Invalid regional key reference');
    return { region: rest.slice(0, colon), inner: rest.slice(colon + 1) };
  };
  const make = (region: string, inner: string) => `${PREFIX}${region}:${inner}`;

  return {
    id: 'regional',
    owns: (keyRef) => keyRef.startsWith(PREFIX),
    async createRoomKey({ tenantId, roomId, region }) {
      const name = region ?? options.defaultRegion;
      const provider = providerFor(name);
      const inner = provider.createRoomKey
        ? await provider.createRoomKey({ tenantId, roomId, region: name })
        : '';
      return make(name, inner);
    },
    async retireRoomKey({ tenantId, roomId, keyRef }) {
      const { region, inner } = parse(keyRef);
      if (inner) await providerFor(region).retireRoomKey?.({ tenantId, roomId, keyRef: inner });
    },
    async generateDataKey({ tenantId, keyRef, context }) {
      const { region, inner } = keyRef
        ? parse(keyRef)
        : { region: options.defaultRegion, inner: '' };
      const key = await providerFor(region).generateDataKey({
        tenantId,
        context,
        ...(inner ? { keyRef: inner } : {}),
      });
      return { ...key, keyRef: make(region, key.keyRef) };
    },
    async decryptDataKey(input) {
      const { region, inner } = parse(input.keyRef);
      return providerFor(region).decryptDataKey({ ...input, keyRef: inner });
    },
  };
}
