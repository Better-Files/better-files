// Chooses the Better IAM the workspace develops against: the npm release (the default, what users install) or a
// local checkout (to try unreleased Better IAM changes; CI's compatibility job uses Better IAM's main branch).
//
//   node scripts/better-iam.mjs npm [range]        # default range ^0.2.0
//   node scripts/better-iam.mjs link ../better-iam # a checkout built with `pnpm build`
//
// Rewrites the `better-iam` devDependency of the root and of every package that declares it as a peer, then run
// `pnpm install` (with `--no-frozen-lockfile` for a link). Peer ranges are left alone: they are what users get.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const [mode, argument] = process.argv.slice(2);
if (mode !== 'npm' && mode !== 'link') {
  console.error(
    'Usage: node scripts/better-iam.mjs npm [range] | link <path to the better-iam checkout>',
  );
  process.exit(1);
}
let target;
if (mode === 'link') {
  if (!argument) throw new Error('link needs the path of a better-iam checkout');
  target = resolve(process.cwd(), argument, 'packages/better-iam');
  if (!existsSync(resolve(target, 'dist/index.js')))
    throw new Error(
      `${target} has no dist/index.js: run \`pnpm build\` in the better-iam checkout first`,
    );
}
const spec = (directory) =>
  mode === 'npm'
    ? (argument ?? '^0.2.0')
    : `link:${relative(directory, target).replaceAll('\\', '/')}`;

const manifests = [
  root,
  ...readdirSync(resolve(root, 'packages')).map((dir) => resolve(root, 'packages', dir)),
].filter((directory) => existsSync(resolve(directory, 'package.json')));
for (const directory of manifests) {
  const file = resolve(directory, 'package.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  if (directory !== root && !manifest.peerDependencies?.['better-iam']) continue;
  manifest.devDependencies = { ...manifest.devDependencies, 'better-iam': spec(directory) };
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${relative(root, file) || 'package.json'}: better-iam ${spec(directory)}`);
}
console.log(
  mode === 'link'
    ? 'Now run: pnpm install --no-frozen-lockfile (and switch back with `node scripts/better-iam.mjs npm` before committing)'
    : 'Now run: pnpm install',
);
