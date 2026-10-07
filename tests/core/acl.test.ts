import { describe, expect, it } from 'vitest';
import {
  applyClamps,
  Capability,
  createCapabilityRegistry,
  exceedsCeiling,
  resolveAccess,
  subjectKey,
  type AccessEntry,
  type SubjectKey,
} from '@better-files/core';

const { preset } = createCapabilityRegistry();
const buyerA = subjectKey('group', 'buyer-a');
const buyerB = subjectKey('group', 'buyer-b');
const alice = subjectKey('identity', 'alice');
// root > finance > tax > return.pdf
const path = ['root', 'finance', 'tax', 'return.pdf'];
const entry = (
  nodeId: string,
  subject: SubjectKey,
  mask: number,
  extra: Partial<AccessEntry> = {},
) => ({
  nodeId,
  subject,
  mask,
  ...extra,
});
const resolve = (
  entries: AccessEntry[],
  subjects: SubjectKey[],
  options: { now?: number; requireAncestorList?: boolean } = {},
) =>
  resolveAccess({
    path,
    entries,
    subjects,
    now: options.now ?? 1_000,
    ...(options.requireAncestorList === undefined
      ? {}
      : { requireAncestorList: options.requireAncestorList }),
  });

describe('resolveAccess', () => {
  it('grants nothing without entries', () => {
    expect(resolve([], [buyerA])).toBe(0);
  });

  it('inherits the nearest entry down the tree', () => {
    const entries = [
      entry('root', buyerA, preset('view')),
      entry('finance', buyerA, preset('download')),
    ];
    expect(resolve(entries, [buyerA])).toBe(preset('download'));
  });

  it('lets a deeper entry narrow access', () => {
    const entries = [
      entry('root', buyerA, preset('download')),
      entry('tax', buyerA, preset('view')),
    ];
    expect(resolve(entries, [buyerA])).toBe(preset('view'));
  });

  it('hides a subtree when an ancestor lacks LIST, unless breadcrumbs are revealed', () => {
    const entries = [
      entry('root', buyerA, preset('view')),
      entry('finance', buyerA, preset('hidden')),
      entry('return.pdf', buyerA, preset('download')),
    ];
    expect(resolve(entries, [buyerA])).toBe(0);
    expect(resolve(entries, [buyerA], { requireAncestorList: false })).toBe(preset('download'));
  });

  it('makes a locked ancestor final for its subtree', () => {
    const entries = [
      entry('root', buyerA, preset('view')),
      entry('finance', buyerA, preset('view'), { locked: true }),
      entry('return.pdf', buyerA, preset('downloadOriginal')),
    ];
    expect(resolve(entries, [buyerA])).toBe(preset('view'));
  });

  it('unions masks across subjects; hidden for one subject does not hide for another', () => {
    const entries = [
      entry('root', buyerA, preset('view')),
      entry('root', buyerB, preset('view')),
      entry('tax', buyerB, preset('hidden')),
      entry('return.pdf', alice, Capability.PRINT),
    ];
    expect(resolve(entries, [buyerB])).toBe(0);
    expect(resolve(entries, [buyerA, buyerB])).toBe(preset('view'));
    expect(resolve(entries, [buyerA, alice])).toBe(preset('view') | Capability.PRINT);
  });

  it('ignores expired entries', () => {
    const entries = [
      entry('root', buyerA, preset('view')),
      entry('finance', buyerA, preset('download'), { expiresAt: 500 }),
    ];
    expect(resolve(entries, [buyerA], { now: 499 })).toBe(preset('download'));
    expect(resolve(entries, [buyerA], { now: 500 })).toBe(preset('view'));
  });

  it('is monotonic in subjects on random trees', () => {
    // Adding a subject can never remove access (the property UIs and caches rely on).
    let seed = 42;
    const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
    const subjects: SubjectKey[] = [buyerA, buyerB, alice];
    const masks = Object.values(createCapabilityRegistry().presets);
    for (let round = 0; round < 500; round++) {
      const entries: AccessEntry[] = [];
      for (const nodeId of path)
        for (const subject of subjects)
          if (random() < 0.4)
            entries.push(
              entry(nodeId, subject, masks[Math.floor(random() * masks.length)]!, {
                locked: random() < 0.15,
              }),
            );
      for (const subject of subjects) {
        const alone = resolve(entries, [subject]);
        const together = resolve(entries, subjects);
        expect(together & alone).toBe(alone);
      }
    }
  });
});

describe('clamps and ceilings', () => {
  it('removes clamped bits and detects grants above the granter', () => {
    expect(
      applyClamps(preset('download'), [{ remove: Capability.DOWNLOAD_WATERMARKED, reason: 'x' }]),
    ).toBe(preset('viewPrint'));
    expect(exceedsCeiling(preset('download'), preset('view'))).toBe(true);
    expect(exceedsCeiling(preset('view'), preset('download'))).toBe(false);
  });
});
