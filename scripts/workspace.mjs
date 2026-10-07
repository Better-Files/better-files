// Reads every package's exports and maps each import specifier to its TypeScript source, so tests, the typecheck
// and tsc project references never need hand-maintained lists.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const root = resolve(import.meta.dirname, '..');

export function packages() {
  return readdirSync(resolve(root, 'packages'))
    .filter((dir) => existsSync(resolve(root, 'packages', dir, 'package.json')))
    .map((dir) => ({
      dir,
      manifest: JSON.parse(readFileSync(resolve(root, 'packages', dir, 'package.json'), 'utf8')),
    }));
}

/** `[specifier, absolute source path]`, most specific first (string aliases also match `{alias}/…`). */
export function sourceEntries() {
  const entries = [];
  for (const { dir, manifest } of packages())
    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      const file = target.import.replace(/^\.\/dist\//, '').replace(/\.js$/, '');
      const base = resolve(root, 'packages', dir, 'src', file);
      const source = existsSync(`${base}.tsx`) ? `${base}.tsx` : `${base}.ts`;
      entries.push([
        subpath === '.' ? manifest.name : `${manifest.name}${subpath.slice(1)}`,
        source,
      ]);
    }
  return entries.sort((a, b) => b[0].length - a[0].length);
}
