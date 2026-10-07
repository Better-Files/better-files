#!/usr/bin/env node
/**
 * better-files-node start --data /srv/better-files --control https://app.example.com/api/better-files --tenant ops \
 *   --listen 0.0.0.0:7070 --advertise https://node-1.internal:7070 --zone eu-1a
 *
 * The join token is read from BETTER_FILES_JOIN_TOKEN (or stdin with --token-stdin), never from arguments, so it
 * does not end up in shell history or process listings. It is needed on the first start only.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { storageNode } from './index.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    data: { type: 'string' },
    control: { type: 'string' },
    tenant: { type: 'string' },
    listen: { type: 'string' },
    advertise: { type: 'string' },
    name: { type: 'string' },
    zone: { type: 'string' },
    capacity: { type: 'string' },
    cors: { type: 'string' },
    'token-stdin': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

const usage = `better-files-node start --data <dir> --control <url> --tenant <id> [--listen host:port]
  [--advertise <url>] [--name <name>] [--zone <zone>] [--capacity <bytes|10GiB>] [--cors <origin,origin|*>]
Join token (first start): BETTER_FILES_JOIN_TOKEN, or --token-stdin.`;

if (
  values.help ||
  positionals[0] !== 'start' ||
  !values.data ||
  !values.control ||
  !values.tenant
) {
  process.stdout.write(`${usage}\n`);
  process.exit(values.help ? 0 : 1);
}

const units: Record<string, number> = {
  B: 1,
  KIB: 1024,
  MIB: 1024 ** 2,
  GIB: 1024 ** 3,
  TIB: 1024 ** 4,
};
function bytes(text: string) {
  const match = /^(\d+(?:\.\d+)?)\s*([KMGT]?I?B)?$/i.exec(text.trim());
  if (!match) throw new Error(`Invalid size ${text}`);
  const unit = (match[2] ?? 'B').toUpperCase().replace(/^([KMGT])B$/, '$1IB');
  return Math.floor(Number(match[1]) * (units[unit] ?? 1));
}

const [host, port] = (values.listen ?? '0.0.0.0:7070').split(/:(?=\d+$)/);
const joinToken = values['token-stdin']
  ? readFileSync(0, 'utf8').trim()
  : process.env.BETTER_FILES_JOIN_TOKEN;
const node = storageNode({
  dataDir: values.data,
  controlPlane: values.control,
  tenantId: values.tenant,
  ...(joinToken ? { joinToken } : {}),
  ...(values.advertise ? { advertiseUrl: values.advertise } : {}),
  ...(values.name ? { name: values.name } : {}),
  ...(values.zone ? { zone: values.zone } : {}),
  ...(values.capacity ? { capacityBytes: bytes(values.capacity) } : {}),
  ...(values.cors ? { corsOrigins: values.cors === '*' ? '*' : values.cors.split(',') } : {}),
  listen: { host: host || '0.0.0.0', port: Number(port ?? 7070) },
  logger: {
    info: (message, data) =>
      process.stdout.write(
        `${new Date().toISOString()} ${message} ${data ? JSON.stringify(data) : ''}\n`,
      ),
    error: (message, data) =>
      process.stderr.write(
        `${new Date().toISOString()} ${message} ${data ? JSON.stringify(data) : ''}\n`,
      ),
  },
});

const started = await node.start();
process.stdout.write(`Storage node ${started.nodeId} serving ${started.url}\n`);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void node.stop().then(() => process.exit(0));
  });
