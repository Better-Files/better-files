// Small JSON editor for workspace files: node scripts/json.mjs <file> <dotted.path> <json-value | --delete>
// Rewrites the file with two-space indentation. With only <file>, it just normalizes formatting.
import { readFileSync, writeFileSync } from 'node:fs';

const [file, path, raw, mode] = process.argv.slice(2);
if (!file) throw new Error('Usage: json.mjs <file> [path] [value|--delete]');
const data = JSON.parse(readFileSync(file, 'utf8'));
if (path) {
  const keys = path.split('.').map((key) => key.replaceAll('%2E', '.'));
  let target = data;
  for (const key of keys.slice(0, -1)) target = target[key] ??= {};
  const last = keys.at(-1);
  if (raw === '--delete') delete target[last];
  else target[last] = mode === '--string' ? raw : JSON.parse(raw);
}
writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
