// Regenerates the umbrella package (better-files): one subpath per published part, each a one-line
// re-export, plus its dependencies and tsconfig references. The root export (src/index.ts) is curated by hand.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { packages, root } from './workspace.mjs';

const umbrellaDir = resolve(root, 'packages', 'better-files');
const manifestPath = resolve(umbrellaDir, 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
// Parts that are not re-exported through the umbrella.
const excluded = new Set(['better-files', 'nuxt']);
// Private packages are work in progress: not published, so not part of the umbrella either.
const parts = packages().filter(({ dir, manifest: part }) => !excluded.has(dir) && !part.private);

const exportsMap = { '.': { types: './dist/index.d.ts', import: './dist/index.js' } };
const dependencies = {};
const references = [];
mkdirSync(resolve(umbrellaDir, 'src'), { recursive: true });
for (const { dir, manifest: part } of parts) {
  dependencies[part.name] = 'workspace:*';
  references.push({ path: `../${dir}` });
  for (const subpath of Object.keys(part.exports ?? {})) {
    const suffix = subpath === '.' ? '' : subpath.slice(1);
    const published = `./${dir}${suffix}`;
    const file = `${dir}${suffix.replaceAll('/', '-')}`;
    exportsMap[published] = { types: `./dist/${file}.d.ts`, import: `./dist/${file}.js` };
    const source = `${part.name}${suffix}`;
    writeFileSync(resolve(umbrellaDir, 'src', `${file}.ts`), `export * from '${source}';\n`);
  }
}
manifest.exports = exportsMap;
manifest.dependencies = Object.fromEntries(Object.entries(dependencies).sort());
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
const tsconfigPath = resolve(umbrellaDir, 'tsconfig.json');
const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf8'));
tsconfig.references = references;
writeFileSync(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`);
console.log(`Umbrella exports ${Object.keys(exportsMap).length} entry points.`);
