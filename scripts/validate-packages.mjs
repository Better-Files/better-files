import { readdir, readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { publint } from 'publint';

const root = resolve(import.meta.dirname, '..');
let failures = 0;
const versions = new Set();
// The Better IAM release the workspace installed (npm, or a linked checkout's version).
const testedBetterIam = JSON.parse(
  await readFile(resolve(root, 'node_modules/better-iam/package.json'), 'utf8'),
).version;
/** Enough of semver for the `>=a <b` and `^a` peer ranges used here. */
function satisfiesTested(range) {
  const parse = (v) =>
    v
      .replace(/^[^\d]*/, '')
      .split('-')[0]
      .split('.')
      .map(Number);
  const compare = (a, b) => {
    for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
    return 0;
  };
  const version = parse(testedBetterIam);
  return range.split('||').some((alternative) =>
    alternative
      .trim()
      .split(/\s+/)
      .every((comparator) => {
        const bound = parse(comparator);
        if (comparator.startsWith('>=')) return compare(version, bound) >= 0;
        if (comparator.startsWith('<')) return compare(version, bound) < 0;
        if (comparator.startsWith('^')) {
          const upper = bound[0] > 0 ? [bound[0] + 1, 0, 0] : [0, bound[1] + 1, 0];
          return compare(version, bound) >= 0 && compare(version, upper) < 0;
        }
        return compare(version, bound) === 0;
      }),
  );
}
for (const name of await readdir(resolve(root, 'packages'))) {
  const directory = resolve(root, 'packages', name);
  const manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  // Private packages are unfinished work that `pnpm publish -r` skips; the umbrella leaves them out too.
  if (manifest.private) continue;
  versions.add(manifest.version);
  if (manifest.license !== 'Apache-2.0')
    throw new Error(`${name}: expected a publishable Apache-2.0 package`);
  if (manifest.publishConfig?.access !== 'public' || !manifest.repository?.directory)
    throw new Error(`${name}: expected publishConfig.access "public" and repository.directory`);
  const expectedName = name === 'better-files' ? 'better-files' : `@better-files/${name}`;
  if (manifest.name !== expectedName)
    throw new Error(`${name}: package name must be ${expectedName}`);
  for (const entry of Object.values(manifest.exports))
    for (const target of Object.values(entry)) await access(resolve(directory, target));
  // better-iam is a peer (users bring their own); a linked checkout (scripts/better-iam.mjs) is only ever a dev
  // dependency, and the published peer range must admit the npm release the workspace tests against.
  for (const [dependency, range] of Object.entries(manifest.dependencies ?? {}))
    if (String(range).startsWith('link:'))
      throw new Error(`${name}: runtime dependency ${dependency} must not be a link: path`);
  if (manifest.dependencies?.['better-iam'])
    throw new Error(`${name}: better-iam must be a peer dependency, not a dependency`);
  const peer = manifest.peerDependencies?.['better-iam'];
  if (peer && !manifest.devDependencies?.['better-iam'])
    throw new Error(`${name}: add better-iam as a devDependency too (autoInstallPeers is off)`);
  // The umbrella depends on every package, so a required peer is installed into every app by npm (which installs
  // peers): frameworks, native and SDK peers must be optional and loaded only by the features that need them.
  for (const dependency of Object.keys(manifest.peerDependencies ?? {}))
    if (
      !dependency.startsWith('@better-files/') &&
      dependency !== 'better-iam' &&
      !manifest.peerDependenciesMeta?.[dependency]?.optional
    )
      throw new Error(`${name}: peer ${dependency} must be optional (peerDependenciesMeta)`);
  if (peer && !satisfiesTested(peer))
    throw new Error(`${name}: peer range ${peer} does not admit better-iam ${testedBetterIam}`);
  const result = await publint({ pkgDir: directory });
  for (const message of result.messages) {
    if (message.type === 'error') {
      failures++;
      console.error(name, message.code);
    } else console.log(name, message.code);
  }
}
if (versions.size !== 1) throw new Error('Package versions are not synchronized');
if (failures) throw new Error(`${failures} package validation errors`);
console.log('All packages have valid exports, synchronized versions, and publishable metadata.');
