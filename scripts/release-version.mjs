// Sets one version on every package: `node scripts/release-version.mjs 0.2.0`.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? ''))
  throw new Error('Usage: node scripts/release-version.mjs <semver>');
const root = resolve(import.meta.dirname, '..');
for (const name of await readdir(resolve(root, 'packages'))) {
  const file = resolve(root, 'packages', name, 'package.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.version = version;
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
}
console.log(`All packages set to ${version}.`);
