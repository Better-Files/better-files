#!/usr/bin/env node
// Runs the tests that need real backing services (PostgreSQL, S3/MinIO) against tests/docker/compose.yml.
//
//   node scripts/test-services.mjs           start the services, run the tests, stop the services
//   node scripts/test-services.mjs --keep    leave the services running (faster reruns)
//   node scripts/test-services.mjs --down    only stop the services
//   node scripts/test-services.mjs -- <vitest args>   run other test files against the same services
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const compose = ['compose', '-f', join(root, 'tests', 'docker', 'compose.yml')];
const args = process.argv.slice(2);
const separator = args.indexOf('--');
const flags = separator === -1 ? args : args.slice(0, separator);
const files =
  separator === -1
    ? ['tests/conformance', 'tests/integration/real-services.test.ts']
    : args.slice(separator + 1);

const env = {
  ...process.env,
  BETTER_FILES_POSTGRES_URL:
    'postgres://postgres:better-files-test@localhost:54329/better_files_test',
  BETTER_FILES_S3_ENDPOINT: 'http://localhost:59000',
  BETTER_FILES_S3_ACCESS_KEY: 'better-files',
  BETTER_FILES_S3_SECRET_KEY: 'better-files-test-secret',
};

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: 'inherit',
    env,
    // Windows resolves `pnpm`/`npx` shims only through a shell.
    shell: process.platform === 'win32',
    ...options,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

const down = () => run('docker', [...compose, 'down', '--volumes', '--remove-orphans']);

if (flags.includes('--down')) process.exit(down());

if (run('docker', ['info'], { stdio: 'ignore' }) !== 0) {
  console.error(
    'Docker is not running. Start Docker Desktop (or the docker daemon) and try again.',
  );
  process.exit(1);
}

let status = run('docker', [...compose, 'up', '--detach', '--wait']);
if (status === 0) status = run('npx', ['vitest', 'run', ...files]);
if (!flags.includes('--keep')) down();
process.exit(status);
