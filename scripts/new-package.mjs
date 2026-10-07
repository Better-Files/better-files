// Scaffolds or refreshes a package's package.json and tsconfig.json with the workspace conventions.
// node scripts/new-package.mjs <dir> "<description>" --deps a,b --peers x@range --optional-peers x --refs core,server
//   --exports ".:index,./express:express" --node --jsx --keywords a,b
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';

const [dir, description, ...rest] = process.argv.slice(2);
if (!dir || !description) throw new Error('Usage: new-package.mjs <dir> "<description>" [options]');
const flags = {};
for (let i = 0; i < rest.length; i++) {
  const key = rest[i].replace(/^--/, '');
  const next = rest[i + 1];
  if (next === undefined || next.startsWith('--')) flags[key] = true;
  else flags[key] = rest[++i];
}
const list = (value) => (typeof value === 'string' && value ? value.split(',') : []);
const root = resolve(import.meta.dirname, '..');
const directory = resolve(root, 'packages', dir);
const workspaceVersion = JSON.parse(
  await readFile(resolve(root, 'packages/core/package.json'), 'utf8'),
).version;
const name = dir === 'better-files' ? 'better-files' : `@better-files/${dir}`;

const exportsMap = {};
for (const entry of list(flags.exports || '.:index')) {
  const [subpath, file] = entry.split(':');
  exportsMap[subpath] = { types: `./dist/${file}.d.ts`, import: `./dist/${file}.js` };
}
const dependencies = {};
for (const dep of list(flags.deps)) {
  if (dep === 'better-files' || dep.startsWith('@better-files/')) dependencies[dep] = 'workspace:*';
  else {
    const at = dep.lastIndexOf('@');
    dependencies[dep.slice(0, at)] = dep.slice(at + 1);
  }
}
const peerDependencies = {};
const devDependencies = {};
for (const peer of list(flags.peers)) {
  const at = peer.lastIndexOf('@');
  const pkg = peer.slice(0, at);
  peerDependencies[pkg] = peer.slice(at + 1);
  // The same Better IAM as the root: the npm release, or a checkout linked by scripts/better-iam.mjs.
  if (pkg === 'better-iam') {
    const rootSpec = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
      .devDependencies['better-iam'];
    devDependencies[pkg] = rootSpec.startsWith('link:')
      ? `link:../${rootSpec.slice('link:'.length)}`
      : rootSpec;
  }
}
for (const dev of list(flags.dev)) {
  const at = dev.lastIndexOf('@');
  devDependencies[dev.slice(0, at)] = dev.slice(at + 1);
}
const optional = list(flags['optional-peers']);

const manifest = {
  name,
  version: workspaceVersion,
  description,
  type: 'module',
  license: 'Apache-2.0',
  author: 'Better Files contributors',
  homepage: `https://github.com/Better-Files/better-files/tree/main/packages/${dir}#readme`,
  repository: {
    type: 'git',
    url: 'git+https://github.com/Better-Files/better-files.git',
    directory: `packages/${dir}`,
  },
  bugs: { url: 'https://github.com/Better-Files/better-files/issues' },
  keywords: ['data-room', 'better-iam', 'typescript', ...list(flags.keywords)],
  publishConfig: { access: 'public' },
  engines: { node: '>=22.12.0' },
  files: ['dist', 'README.md', 'LICENSE'],
  main: exportsMap['.']?.import,
  types: exportsMap['.']?.types,
  exports: exportsMap,
  sideEffects: false,
  scripts: { build: 'tsc -b' },
  dependencies,
  ...(Object.keys(peerDependencies).length ? { peerDependencies } : {}),
  ...(optional.length
    ? { peerDependenciesMeta: Object.fromEntries(optional.map((p) => [p, { optional: true }])) }
    : {}),
  ...(Object.keys(devDependencies).length ? { devDependencies } : {}),
};
if (!manifest.main) {
  delete manifest.main;
  delete manifest.types;
}
const compilerOptions = { rootDir: 'src', outDir: 'dist' };
if (flags.node) compilerOptions.types = ['node'];
if (flags.jsx) compilerOptions.jsx = 'react-jsx';
const tsconfig = {
  extends: '../../tsconfig.base.json',
  compilerOptions,
  include: flags.jsx ? ['src/**/*.ts', 'src/**/*.tsx'] : ['src/**/*.ts'],
  references: list(flags.refs).map((ref) => ({ path: `../${ref}` })),
};
await mkdir(resolve(directory, 'src'), { recursive: true });
await writeFile(resolve(directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(resolve(directory, 'tsconfig.json'), `${JSON.stringify(tsconfig, null, 2)}\n`);
try {
  await access(resolve(directory, 'README.md'));
} catch {
  await writeFile(
    resolve(directory, 'README.md'),
    `# ${name}\n\n${description}\n\nPart of [Better Files](../../README.md). Most applications install \`better-files\` and import this package through its subpaths.\n`,
  );
}
console.log(`${name} scaffolded in packages/${dir}`);
