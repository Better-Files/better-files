import { bench, describe } from 'vitest';
import {
  Capability,
  createAccessIndex,
  resolveAccess,
  subjectKey,
  type AccessEntry,
} from '@better-files/core';

// A 500-item folder three levels down, 50 groups with cells on the ancestors (the PLAN §9.3 listing shape).
const groups = Array.from({ length: 50 }, (_, i) => subjectKey('group', `g${i}`));
const subjects = [subjectKey('identity', 'bob'), ...groups];
const ancestors = ['root', 'top', 'sub'];
const entries: AccessEntry[] = [
  { nodeId: 'root', subject: groups[0]!, mask: Capability.LIST | Capability.VIEW },
  ...groups.map((subject, g) => ({ nodeId: 'top', subject, mask: g % 2 ? 3 : 1 })),
  ...groups
    .filter((_, g) => g % 3 === 0)
    .map((subject, g) => ({ nodeId: 'sub', subject, mask: g % 2 ? 1 : 3 })),
  // Noise: cells elsewhere in the room, which a good resolver skips cheaply.
  ...Array.from({ length: 2000 }, (_, i) => ({
    nodeId: `other-${i}`,
    subject: groups[i % groups.length]!,
    mask: 3,
  })),
];
const paths = Array.from({ length: 500 }, (_, i) => [...ancestors, `doc-${i}`]);
const now = Date.now();

describe('resolving 500 paths for one principal (50 groups, 2,000+ entries)', () => {
  bench('resolveAccess per path', () => {
    for (const path of paths) resolveAccess({ path, entries, subjects, now });
  });
  bench('createAccessIndex once, then resolve', () => {
    const index = createAccessIndex({ entries, subjects, now });
    for (const path of paths) index.resolve(path);
  });
});
