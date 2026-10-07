import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
// @ts-expect-error: plain ESM helper shared with the workspace scripts.
import { sourceEntries } from '../scripts/workspace.mjs';

// Benchmarks are kept out of `pnpm check`: `pnpm bench` runs the comparisons (*.bench.ts) and `pnpm bench:targets`
// checks the PLAN's performance targets (*.test.ts) against a seeded 100,000-node room.
export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  test: {
    include: ['bench/**/*.test.ts'],
    benchmark: { include: ['bench/**/*.bench.ts'] },
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
  resolve: {
    alias: (sourceEntries() as [string, string][]).map(([find, replacement]) => ({
      find,
      replacement,
    })),
  },
});
