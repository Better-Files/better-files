import { describe, expect, it } from 'vitest';
import {
  Capability,
  createAccessIndex,
  createCapabilityRegistry,
  resolveAccess,
  resolvePathMasks,
  subjectKey,
  type AccessEntry,
  type SubjectKey,
} from '@better-files/core';

// Property tests for the permission resolver: random trees and matrices, checked against a spec written directly
// from the rules in PLAN §9.3, and the indexed resolver checked against the reference one.

const ROUNDS = 400;
const NOW = 10_000;
const masks = [0, ...Object.values(createCapabilityRegistry().presets), Capability.PRINT];
const allSubjects: SubjectKey[] = [
  subjectKey('identity', 'alice'),
  subjectKey('group', 'buyer-a'),
  subjectKey('group', 'buyer-b'),
  subjectKey('link', 'l1'),
];

function prng(seed: number) {
  let state = seed;
  const next = () => (state = (state * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
  return {
    next,
    int: (max: number) => Math.floor(next() * max),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
  };
}

interface World {
  /** Every root-to-node path of a random tree. */
  paths: string[][];
  nodes: string[];
  entries: AccessEntry[];
}

function world(seed: number): World {
  const random = prng(seed);
  const parents = new Map<string, string | undefined>([['n0', undefined]]);
  const count = 2 + random.int(14);
  for (let i = 1; i < count; i++) parents.set(`n${i}`, `n${random.int(i)}`);
  const nodes = [...parents.keys()];
  const pathOf = (id: string): string[] => {
    const parent = parents.get(id);
    return parent === undefined ? [id] : [...pathOf(parent), id];
  };
  const entries: AccessEntry[] = [];
  for (const nodeId of [...nodes, 'elsewhere'])
    for (const subject of allSubjects)
      while (random.next() < 0.3) {
        const roll = random.next();
        entries.push({
          nodeId,
          subject,
          mask: random.pick(masks),
          ...(random.next() < 0.15 ? { locked: true } : {}),
          ...(roll < 0.1 ? { expiresAt: NOW } : roll < 0.2 ? { expiresAt: NOW + 1 } : {}),
        });
      }
  return { paths: nodes.map(pathOf), nodes, entries };
}

/** The rules, stated plainly: per subject, the shallowest locked cell on the path is final; otherwise the nearest. */
function spec(
  path: readonly string[],
  entries: readonly AccessEntry[],
  subjects: readonly SubjectKey[],
  now: number,
  requireAncestorList = true,
): number {
  if (path.length === 0) return 0;
  const live = entries.filter((e) => e.expiresAt === undefined || e.expiresAt > now);
  const maskAt = (depth: number): number => {
    let union = 0;
    for (const subject of new Set(subjects)) {
      const cellAt = (d: number) => {
        const cells = live.filter((e) => e.subject === subject && e.nodeId === path[d]);
        return cells.length
          ? {
              mask: cells.reduce((m, e) => m | e.mask, 0),
              locked: cells.some((e) => e.locked === true),
            }
          : undefined;
      };
      let chosen: number | undefined;
      for (let d = 0; d <= depth && chosen === undefined; d++)
        if (cellAt(d)?.locked) chosen = cellAt(d)!.mask;
      for (let d = depth; d >= 0 && chosen === undefined; d--) chosen = cellAt(d)?.mask;
      union |= chosen ?? 0;
    }
    return union;
  };
  if (requireAncestorList)
    for (let depth = 0; depth < path.length - 1; depth++)
      if ((maskAt(depth) & Capability.LIST) === 0) return 0;
  return maskAt(path.length - 1);
}

function subjectSets(seed: number): SubjectKey[][] {
  const random = prng(seed);
  return [
    [],
    [...allSubjects],
    allSubjects.filter(() => random.next() < 0.5),
    [random.pick(allSubjects)],
  ];
}

describe('resolveAccess properties', () => {
  it('matches the written rules on random trees', () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { paths, entries } = world(round);
      for (const subjects of subjectSets(round))
        for (const path of paths)
          for (const requireAncestorList of [true, false])
            expect(resolveAccess({ path, entries, subjects, now: NOW, requireAncestorList })).toBe(
              spec(path, entries, subjects, NOW, requireAncestorList),
            );
    }
  });

  it('gives the same answers through an access index', () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { paths, entries } = world(round);
      for (const subjects of subjectSets(round)) {
        const index = createAccessIndex({ entries, subjects, now: NOW });
        for (const path of paths) {
          expect(index.pathMasks(path)).toEqual(
            resolvePathMasks({ path, entries, subjects, now: NOW }),
          );
          for (const requireAncestorList of [true, false])
            expect(index.resolve(path, { requireAncestorList })).toBe(
              resolveAccess({ path, entries, subjects, now: NOW, requireAncestorList }),
            );
        }
      }
    }
  });

  it('never grants more with breadcrumbs required than without', () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { paths, entries } = world(round);
      for (const path of paths) {
        const strict = resolveAccess({ path, entries, subjects: allSubjects, now: NOW });
        const loose = resolveAccess({
          path,
          entries,
          subjects: allSubjects,
          now: NOW,
          requireAncestorList: false,
        });
        expect(strict === 0 || strict === loose).toBe(true);
      }
    }
  });

  it('ignores the order and repetition of subjects, and entries off the path', () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { paths, entries } = world(round);
      const shuffled = [...allSubjects].reverse();
      const noise: AccessEntry[] = [
        { nodeId: 'unrelated', subject: allSubjects[0]!, mask: Capability.LIST, locked: true },
      ];
      for (const path of paths) {
        const base = resolveAccess({ path, entries, subjects: allSubjects, now: NOW });
        expect(
          resolveAccess({ path, entries, subjects: [...shuffled, ...shuffled], now: NOW }),
        ).toBe(base);
        expect(
          resolveAccess({ path, entries: [...noise, ...entries], subjects: allSubjects, now: NOW }),
        ).toBe(base);
      }
    }
  });

  it('keeps a prefix of the path resolving the same way (a folder does not depend on its children)', () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { paths, entries } = world(round);
      for (const path of paths) {
        const full = resolvePathMasks({ path, entries, subjects: allSubjects, now: NOW });
        for (let depth = 0; depth < path.length; depth++)
          expect(
            resolvePathMasks({
              path: path.slice(0, depth + 1),
              entries,
              subjects: allSubjects,
              now: NOW,
            })[depth],
          ).toBe(full[depth]);
      }
    }
  });

  it('makes a locked cell final: entries beneath it for the same subject change nothing', () => {
    for (let round = 0; round < ROUNDS; round++) {
      const random = prng(round + 7);
      const { paths, entries } = world(round);
      const subject = random.pick(allSubjects);
      for (const path of paths) {
        const lockedAt = path.findIndex((id) =>
          entries.some(
            (e) =>
              e.nodeId === id &&
              e.subject === subject &&
              e.locked &&
              (e.expiresAt === undefined || e.expiresAt > NOW),
          ),
        );
        if (lockedAt < 0 || lockedAt === path.length - 1) continue;
        const before = resolvePathMasks({ path, entries, subjects: [subject], now: NOW });
        const extra = path.slice(lockedAt + 1).map(
          (nodeId): AccessEntry => ({
            nodeId,
            subject,
            mask: random.pick(masks),
            locked: random.next() < 0.5,
          }),
        );
        expect(
          resolvePathMasks({
            path,
            entries: [...entries, ...extra],
            subjects: [subject],
            now: NOW,
          }),
        ).toEqual(before);
      }
    }
  });

  it('resolves a large listing through an index in linear time', () => {
    // 20 folders × 500 documents, a cell for every group on every folder: the engine's listing shape.
    const groups = Array.from({ length: 50 }, (_, i) => subjectKey('group', `g${i}`));
    const entries: AccessEntry[] = [];
    const paths: string[][] = [];
    for (let f = 0; f < 20; f++) {
      for (const subject of groups)
        entries.push({ nodeId: `f${f}`, subject, mask: Capability.LIST | Capability.VIEW });
      for (let d = 0; d < 500; d++) paths.push(['root', `f${f}`, `d${f}-${d}`]);
    }
    for (const subject of groups) entries.push({ nodeId: 'root', subject, mask: Capability.LIST });
    const started = performance.now();
    const index = createAccessIndex({ entries, subjects: groups.slice(0, 10), now: NOW });
    for (const path of paths) expect(index.resolve(path)).toBe(Capability.LIST | Capability.VIEW);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
