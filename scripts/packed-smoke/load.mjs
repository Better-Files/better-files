// Imports every subpath of the installed umbrella package in a clean app. A subpath may only fail for want of an
// optional peer it declares (react for /react, say); anything else is a packaging bug.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Manifests are read from disk: packages export only their entry points, not package.json.
const manifestOf = async (name) =>
  JSON.parse(await readFile(join(process.cwd(), 'node_modules', name, 'package.json'), 'utf8'));
const umbrellaManifest = await manifestOf('better-files');
const optionalPeers = new Set();
for (const name of ['better-files', ...Object.keys(umbrellaManifest.dependencies ?? {})]) {
  const manifest = await manifestOf(name);
  for (const [peer, meta] of Object.entries(manifest.peerDependenciesMeta ?? {}))
    if (meta.optional) optionalPeers.add(peer);
}

const missingPackage = (error) =>
  /Cannot find (?:package|module) '((?:@[^/']+\/)?[^/']+)/.exec(String(error?.message))?.[1];

const failures = [];
const needsPeer = [];
for (const subpath of Object.keys(umbrellaManifest.exports)) {
  if (subpath === './package.json') continue;
  const specifier = `better-files${subpath.slice(1)}`;
  try {
    await import(specifier);
  } catch (error) {
    const missing = missingPackage(error);
    if (missing && optionalPeers.has(missing)) needsPeer.push(`${specifier} (needs ${missing})`);
    else failures.push(`${specifier}: ${error?.message ?? error}`);
  }
}
console.log(
  `loaded ${Object.keys(umbrellaManifest.exports).length - failures.length - needsPeer.length} subpaths`,
);
if (needsPeer.length)
  console.log(`need an optional peer at import time:\n  ${needsPeer.join('\n  ')}`);
if (failures.length) {
  console.error(`subpaths that fail to load:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
