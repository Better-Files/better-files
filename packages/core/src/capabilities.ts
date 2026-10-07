import { invalidConfig } from './errors.js';

/**
 * What a subject may do with a node. Bits 0–15 belong to the core; plugins and configuration register their own
 * capabilities from bit 16 upward (see `createCapabilityRegistry`).
 */
export const Capability = {
  /** See that the node exists: name, index number, position in the tree. */
  LIST: 1 << 0,
  /** Open it in the secure viewer (server-rendered, watermarked pages). */
  VIEW: 1 << 1,
  PRINT: 1 << 2,
  COPY_TEXT: 1 << 3,
  DOWNLOAD_WATERMARKED: 1 << 4,
  DOWNLOAD_ORIGINAL: 1 << 5,
  /** Add children to a folder, or new versions to a document. */
  UPLOAD: 1 << 6,
  /** Rename, move, change metadata. */
  EDIT: 1 << 7,
  DELETE: 1 << 8,
  /** Permissions, members and settings for the subtree. */
  MANAGE: 1 << 9,
} as const;

export type CoreCapability = keyof typeof Capability;
export const coreCapabilityNames = Object.keys(Capability) as CoreCapability[];
export const CORE_MASK = coreCapabilityNames.reduce((mask, name) => mask | Capability[name], 0);
export const FIRST_EXTENSION_BIT = 16;
/** Bitwise operators work on 32-bit signed integers; bit 30 is the highest safe positive bit. */
export const LAST_EXTENSION_BIT = 30;

export const Presets = {
  hidden: [],
  view: ['LIST', 'VIEW'],
  viewPrint: ['LIST', 'VIEW', 'PRINT'],
  download: ['LIST', 'VIEW', 'PRINT', 'DOWNLOAD_WATERMARKED'],
  downloadOriginal: [
    'LIST',
    'VIEW',
    'PRINT',
    'COPY_TEXT',
    'DOWNLOAD_WATERMARKED',
    'DOWNLOAD_ORIGINAL',
  ],
  contributor: ['LIST', 'VIEW', 'PRINT', 'DOWNLOAD_WATERMARKED', 'UPLOAD'],
  editor: ['LIST', 'VIEW', 'PRINT', 'DOWNLOAD_WATERMARKED', 'UPLOAD', 'EDIT', 'DELETE'],
  manager: ['*'],
} as const satisfies Record<string, readonly (CoreCapability | '*')[]>;
export type CorePreset = keyof typeof Presets;

export interface CapabilityDefinition {
  bit: number;
  description?: string;
}

/** The capabilities in force for one `betterFiles()` instance: the core bits plus registered extensions. */
export interface CapabilityRegistry {
  readonly names: readonly string[];
  readonly all: number;
  bit(name: string): number;
  has(name: string): boolean;
  mask(names: Iterable<string>): number;
  namesOf(mask: number): string[];
  preset(name: string): number;
  readonly presets: Readonly<Record<string, number>>;
}

export function createCapabilityRegistry(
  options: {
    extensions?: Record<string, CapabilityDefinition>;
    presets?: Record<string, readonly string[]>;
  } = {},
): CapabilityRegistry {
  const bits = new Map<string, number>(coreCapabilityNames.map((name) => [name, Capability[name]]));
  const usedBits = new Map<number, string>(
    coreCapabilityNames.map((name) => [Capability[name], name]),
  );
  for (const [name, definition] of Object.entries(options.extensions ?? {})) {
    if (!/^[A-Z][A-Z0-9_]{0,47}$/.test(name))
      throw invalidConfig(`Capability ${name} must be an UPPER_SNAKE_CASE name`);
    if (bits.has(name)) throw invalidConfig(`Capability ${name} is declared more than once`);
    const { bit } = definition;
    if (!Number.isInteger(bit) || bit < FIRST_EXTENSION_BIT || bit > LAST_EXTENSION_BIT)
      throw invalidConfig(
        `Capability ${name} must use a bit from ${FIRST_EXTENSION_BIT} to ${LAST_EXTENSION_BIT}`,
      );
    const value = 1 << bit;
    const taken = usedBits.get(value);
    if (taken) throw invalidConfig(`Capability ${name} reuses bit ${bit} of ${taken}`);
    bits.set(name, value);
    usedBits.set(value, name);
  }
  const all = [...bits.values()].reduce((mask, value) => mask | value, 0);
  const bit = (name: string) => {
    const value = bits.get(name);
    if (value === undefined) throw invalidConfig(`Unknown capability ${name}`);
    return value;
  };
  const mask = (names: Iterable<string>) => {
    let result = 0;
    for (const name of names) result |= name === '*' ? all : bit(name);
    return result;
  };
  const presets: Record<string, number> = {};
  for (const [name, members] of Object.entries(Presets)) presets[name] = mask(members);
  for (const [name, members] of Object.entries(options.presets ?? {})) {
    if (!/^[a-zA-Z][a-zA-Z0-9-]{0,47}$/.test(name))
      throw invalidConfig(`Invalid preset name ${name}`);
    presets[name] = mask(members);
  }
  return {
    names: [...bits.keys()],
    all,
    bit,
    has: (name) => bits.has(name),
    mask,
    namesOf: (value) => [...bits].filter(([, b]) => (value & b) === b).map(([name]) => name),
    preset(name) {
      const value = presets[name];
      if (value === undefined) throw invalidConfig(`Unknown preset ${name}`);
      return value;
    },
    presets,
  };
}

/** True when `mask` contains every bit of `required`. */
export const hasAll = (mask: number, required: number): boolean => (mask & required) === required;
