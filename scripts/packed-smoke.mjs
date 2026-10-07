// Packed smoke test: what a user gets from `npm install better-files better-iam`.
//
// Packs every package, installs the tarballs with npm into a clean app outside the workspace (better-iam comes from
// the npm registry), then:
//   1. checks a plain install pulls in no heavy optional peers (frameworks, native image or PDF tools, SDKs);
//   2. typechecks scripts/packed-smoke/smoke.ts against the packed type declarations (strict, NodeNext);
//   3. runs it: Better Files on real Better IAM end to end;
//   4. imports every umbrella subpath (scripts/packed-smoke/load.mjs).
//
//   pnpm smoke:packed [--keep] [--no-build]
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { packAll, pnpm } from './pack.mjs';

const root = resolve(import.meta.dirname, '..');
const flags = new Set(process.argv.slice(2));
const work = await mkdtemp(join(tmpdir(), 'better-files-packed-smoke-'));
const app = join(work, 'app');

/** Packages a plain install must not bring in: they are optional peers, loaded only by the features that need them. */
const heavy = [
  'vue',
  'react',
  'react-dom',
  'svelte',
  'next',
  '@nestjs/core',
  '@electric-sql/pglite',
  'sharp',
  '@napi-rs/canvas',
  'unpdf',
  '@anthropic-ai/sdk',
  '@modelcontextprotocol/sdk',
];

function run(command, args, options = {}) {
  console.log(`\n> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: app,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})`);
}

let failed = false;
try {
  if (!flags.has('--no-build')) {
    console.log('> pnpm build');
    if (pnpm(['build'], { cwd: root }).status !== 0) throw new Error('pnpm build failed');
  }
  // The umbrella and what it depends on: what `npm install better-files` brings.
  const umbrella = JSON.parse(
    await readFile(join(root, 'packages/better-files/package.json'), 'utf8'),
  );
  const dirs = [
    'better-files',
    ...Object.keys(umbrella.dependencies)
      .filter((name) => name.startsWith('@better-files/'))
      .map((name) => name.slice('@better-files/'.length)),
  ];
  const tarballs = await packAll(join(work, 'tarballs'), dirs);
  const betterIamRange = JSON.parse(await readFile(join(root, 'packages/iam/package.json'), 'utf8'))
    .peerDependencies['better-iam'];

  await mkdir(app, { recursive: true });
  // Every Better Files package from its tarball (the internal 0.1.0 dependencies included, through overrides), the
  // rest from npm.
  const local = Object.fromEntries(tarballs.map(({ name, file }) => [name, `file:${file}`]));
  await writeFile(
    join(app, 'package.json'),
    `${JSON.stringify(
      {
        name: 'better-files-packed-smoke',
        private: true,
        type: 'module',
        dependencies: {
          'better-files': local['better-files'],
          'better-iam': betterIamRange,
        },
        devDependencies: { typescript: '^5.9.3', '@types/node': '^22.19.0' },
        overrides: local,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(app, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2023',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noUncheckedIndexedAccess: true,
          // Our declarations are checked through what smoke.ts uses; better-iam's own are its business.
          skipLibCheck: true,
          types: ['node'],
          outDir: 'dist',
        },
        files: ['smoke.ts'],
      },
      null,
      2,
    )}\n`,
  );
  await cp(join(root, 'scripts/packed-smoke/smoke.ts'), join(app, 'smoke.ts'));
  await cp(join(root, 'scripts/packed-smoke/load.mjs'), join(app, 'load.mjs'));

  run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error']);

  // Who required each heavy package: a Better Files package's required peer fails the run; better-iam's own
  // packaging is reported, not ours to fix here.
  const ours = [];
  const upstream = [];
  for (const name of heavy) {
    if (!existsSync(join(app, 'node_modules', name, 'package.json'))) continue;
    const explained = spawnSync('npm', ['explain', name, '--json'], {
      cwd: app,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    const edges = JSON.parse(explained.stdout || '[]').flatMap((node) => node.dependents ?? []);
    const from = (edge) => edge.from?.name || 'the app';
    const required = edges.filter((edge) => edge.type === 'peer' || edge.type === 'prod');
    const own = required
      .map(from)
      .filter((by) => by === 'better-files' || by.startsWith('@better-files/'));
    if (own.length) ours.push(`${name} (required by ${own.join(', ')})`);
    else
      upstream.push(
        `${name} (${required.length ? 'required' : 'optionally installed'} by ${[
          ...new Set((required.length ? required : edges).map(from)),
        ].join(', ')})`,
      );
  }
  if (upstream.length)
    console.warn(
      `\nwarning: heavy packages a plain install gets from outside Better Files:\n  ${upstream.join('\n  ')}`,
    );
  if (ours.length)
    throw new Error(
      `Better Files packages pull in ${ours.join('; ')}: make them optional peers (peerDependenciesMeta)`,
    );
  console.log('\nno heavy packages required by Better Files');

  run(process.execPath, [join(app, 'node_modules/typescript/bin/tsc'), '-p', '.'], {
    shell: false,
  });
  run(process.execPath, ['dist/smoke.js'], { shell: false });
  run(process.execPath, ['load.mjs'], { shell: false });
  console.log('\npacked smoke passed');
} catch (error) {
  failed = true;
  console.error(`\npacked smoke failed: ${error instanceof Error ? error.message : error}`);
} finally {
  if (flags.has('--keep') || failed) console.log(`the app is kept in ${app}`);
  else await rm(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
