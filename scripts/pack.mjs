// Packs every package into artifacts/, or the directory given (run `pnpm build` first). Returns the tarball paths
// when imported.
import { mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');

/** Runs pnpm the way this script was started (`pnpm run …` sets npm_execpath), falling back to `pnpm` on PATH. */
export function pnpm(args, options = {}) {
  const execpath = process.env.npm_execpath;
  const viaNode = execpath && /pnpm\.(c?js|mjs)$/.test(execpath);
  return spawnSync(viaNode ? process.execPath : 'pnpm', viaNode ? [execpath, ...args] : args, {
    stdio: 'inherit',
    shell: !viaNode && process.platform === 'win32',
    ...options,
  });
}

/** Packs the packages in `dirs` (directory names under packages/; default all). */
export async function packAll(destination = resolve(root, 'artifacts'), dirs) {
  await mkdir(destination, { recursive: true });
  const tarballs = [];
  for (const name of dirs ?? (await readdir(resolve(root, 'packages')))) {
    const result = pnpm(['pack', '--json', '--pack-destination', destination], {
      cwd: resolve(root, 'packages', name),
      stdio: ['ignore', 'pipe', 'inherit'],
      encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error(`pnpm pack failed for ${name}`);
    const packed = JSON.parse(result.stdout);
    tarballs.push({ name: packed.name, file: resolve(destination, packed.filename) });
  }
  return tarballs;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const tarballs = await packAll(process.argv[2] ? resolve(process.argv[2]) : undefined);
  for (const { name, file } of tarballs) console.log(`${name} → ${file}`);
}
