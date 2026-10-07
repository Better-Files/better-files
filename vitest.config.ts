import { defineConfig } from 'vitest/config';
// @ts-expect-error: plain ESM helper shared with the workspace scripts.
import { sourceEntries } from './scripts/workspace.mjs';

export default defineConfig({
  // NestJS decorators are the legacy TypeScript form.
  esbuild: { jsx: 'automatic', tsconfigRaw: { compilerOptions: { experimentalDecorators: true } } },
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
  resolve: {
    // Tests run against sources, so no build is needed. Entries are most specific first because string aliases also
    // match `{alias}/...`.
    alias: (sourceEntries() as [string, string][]).map(([find, replacement]) => ({
      find,
      replacement,
    })),
  },
});
