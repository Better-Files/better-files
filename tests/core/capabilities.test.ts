import { describe, expect, it } from 'vitest';
import {
  Capability,
  CORE_MASK,
  createCapabilityRegistry,
  createId,
  BetterFilesError,
  hasAll,
  isId,
  ulid,
} from '@better-files/core';

describe('capabilities', () => {
  it('expands presets and names', () => {
    const registry = createCapabilityRegistry();
    expect(registry.preset('view')).toBe(Capability.LIST | Capability.VIEW);
    expect(registry.preset('manager')).toBe(CORE_MASK);
    expect(registry.namesOf(registry.preset('download'))).toEqual([
      'LIST',
      'VIEW',
      'PRINT',
      'DOWNLOAD_WATERMARKED',
    ]);
    expect(hasAll(registry.preset('editor'), Capability.UPLOAD | Capability.DELETE)).toBe(true);
    expect(hasAll(registry.preset('contributor'), Capability.DELETE)).toBe(false);
  });

  it('registers extension capabilities and custom presets', () => {
    const registry = createCapabilityRegistry({
      extensions: { ANNOTATE: { bit: 16 }, QA_ASK: { bit: 17 } },
      presets: { reviewer: ['LIST', 'VIEW', 'ANNOTATE'] },
    });
    expect(registry.bit('ANNOTATE')).toBe(1 << 16);
    expect(registry.preset('reviewer')).toBe(Capability.LIST | Capability.VIEW | (1 << 16));
    expect(registry.preset('manager')).toBe(CORE_MASK | (1 << 16) | (1 << 17));
    expect(registry.namesOf(1 << 17)).toEqual(['QA_ASK']);
  });

  it('refuses reserved, reused and out-of-range bits and unknown names', () => {
    expect(() => createCapabilityRegistry({ extensions: { SHARE: { bit: 3 } } })).toThrow(
      BetterFilesError,
    );
    expect(() => createCapabilityRegistry({ extensions: { SHARE: { bit: 31 } } })).toThrow(/bit/);
    expect(() =>
      createCapabilityRegistry({ extensions: { ONE: { bit: 20 }, TWO: { bit: 20 } } }),
    ).toThrow(/reuses bit 20/);
    expect(() => createCapabilityRegistry({ extensions: { lower: { bit: 20 } } })).toThrow(
      /UPPER_SNAKE/,
    );
    expect(() => createCapabilityRegistry({ presets: { broken: ['NOPE'] } })).toThrow(
      /Unknown capability/,
    );
  });
});

describe('ids', () => {
  it('creates prefixed, time-sortable ids', () => {
    const early = createId('room', 1_000);
    const late = createId('room', 2_000);
    expect(isId(early, 'room')).toBe(true);
    expect(isId(early, 'node')).toBe(false);
    expect(early < late).toBe(true);
    expect(ulid()).toHaveLength(26);
  });
});
