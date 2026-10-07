// Regenerates tsconfig.json project references and tests/tsconfig.json paths from the packages' exports.
// Run after adding a package or an export: `node scripts/sync-workspace.mjs`.
import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { packages, root, sourceEntries } from './workspace.mjs';

const ordered = [];
const byDir = new Map(packages().map((entry) => [entry.dir, entry]));
const visit = (dir, seen = new Set()) => {
  if (ordered.includes(dir) || seen.has(dir)) return;
  seen.add(dir);
  const tsconfig = JSON.parse(
    readFileSync(resolve(root, 'packages', dir, 'tsconfig.json'), 'utf8'),
  );
  for (const reference of tsconfig.references ?? []) visit(reference.path.replace('../', ''), seen);
  ordered.push(dir);
};
for (const dir of [...byDir.keys()].sort()) visit(dir);

writeFileSync(
  resolve(root, 'tsconfig.json'),
  `${JSON.stringify({ files: [], references: ordered.map((dir) => ({ path: `./packages/${dir}` })) }, null, 2)}\n`,
);

const testsConfigPath = resolve(root, 'tests', 'tsconfig.json');
const testsConfig = JSON.parse(readFileSync(testsConfigPath, 'utf8'));
testsConfig.compilerOptions.paths = Object.fromEntries(
  sourceEntries().map(([specifier, source]) => [
    specifier,
    [relative(resolve(root, 'tests'), source).replaceAll('\\', '/')],
  ]),
);
writeFileSync(testsConfigPath, `${JSON.stringify(testsConfig, null, 2)}\n`);
console.log(`Synchronized ${ordered.length} packages.`);
