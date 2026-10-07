import { access, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createBetterFilesClient } from '@better-files/client';
import type { BetterFiles } from '@better-files/server';
import { createMirror, type MirrorReport } from './mirror.js';
import { reconcileIam } from './reconcile.js';

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
  /** Loads the instance; tests pass one directly. Default: import the config module. */
  load?: (path: string | undefined) => Promise<BetterFiles>;
  fetch?: typeof fetch;
}

const usage = `better-files <command> [options]

Instance commands (load your betterFiles() instance from a config module):
  migrate                         Create or upgrade the Better Files tables
  maintain [--every <seconds>]    Run maintenance once, or on an interval
  verify --tenant <id> --room <id>  Verify a room's activity hash chain
  doctor [--tenant <id>]          Check the secret, database, storage and key provider
  reconcile --tenant <id> [--room <id>] [--repair] [--revoke-orphans] [--json]
                                  Compare room relations and group memberships in the identity
                                  system with the room rosters; --repair fixes the differences
  openapi [--out <file>]          Write the OpenAPI 3.1 document for the protocol (stdout by default)
  generate --format <sql|prisma|drizzle> [--dialect <postgres|sqlite>] [--out <file>]
                                  The Better Files tables for your migration tool (core, plugins, your fields)

  --config <file>   Module whose default (or \`dr\`) export is the instance.
                    Default: better-files.config.{ts,mts,js,mjs} in the current folder.

Storage cluster commands (over HTTP, as an operator-tenant administrator; needs storageCluster):
  storage nodes | status | join-token [--zone z] | reconcile | sync
  storage drain | activate | cordon | uncordon | remove [--force] --node <id>

Sync commands (talk to a running app over HTTP; needs the sync plugin):
  sync pull     Download remote changes into the folder
  sync push     Pull, then upload new and edited files (--delete also deletes remote files removed locally)
  sync status   Show local and remote changes

  --dir <path>      Local folder (default: current folder)
  --url <url>       Protocol URL, such as https://app.example.com/api/better-files   [BETTER_FILES_URL]
  --token <token>   Bearer token for the API                                     [BETTER_FILES_TOKEN]
  --tenant <id>     Tenant                                                        [BETTER_FILES_TENANT]
  --room <id>       Room to mirror`;

const configNames = [
  'better-files.config.ts',
  'better-files.config.mts',
  'better-files.config.js',
  'better-files.config.mjs',
];

/** Imports the host's config module and returns its instance. TypeScript configs need Node 22.18+ (or a loader such as tsx). */
export async function loadInstance(cwd: string, path?: string): Promise<BetterFiles> {
  let file = path ? resolve(cwd, path) : undefined;
  if (!file)
    for (const name of configNames) {
      const candidate = resolve(cwd, name);
      if (
        await access(candidate).then(
          () => true,
          () => false,
        )
      ) {
        file = candidate;
        break;
      }
    }
  if (!file)
    throw new Error(
      `No config found: create better-files.config.ts exporting your betterFiles() instance, or pass --config`,
    );
  const module = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  const candidate = (module.default ?? module.dr ?? module.betterFiles) as
    | BetterFiles
    | (() => BetterFiles | Promise<BetterFiles>)
    | undefined;
  const instance = typeof candidate === 'function' ? await candidate() : candidate;
  if (
    !instance ||
    typeof instance !== 'object' ||
    !('api' in instance) ||
    !('initialize' in instance)
  )
    throw new Error(`${file} must export a betterFiles() instance as default or as \`dr\``);
  return instance;
}

function printReport(report: MirrorReport, out: (line: string) => void) {
  for (const path of report.downloaded) out(`  ↓ ${path}`);
  for (const path of report.uploaded) out(`  ↑ ${path}`);
  for (const move of report.moved) out(`  → ${move}`);
  for (const path of report.removed) out(`  ✕ ${path}`);
  for (const path of report.conflicts) out(`  ! conflict, kept ${path}`);
  for (const name of report.skipped) out(`  · ${name} (view only)`);
  const total = Object.values(report).reduce((sum, list) => sum + list.length, 0);
  out(total ? `${total} change${total === 1 ? '' : 's'}` : 'Up to date');
}

/** Runs one command; returns the exit code. */
export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      every: { type: 'string' },
      tenant: { type: 'string' },
      room: { type: 'string' },
      dir: { type: 'string' },
      url: { type: 'string' },
      token: { type: 'string' },
      delete: { type: 'boolean' },
      out: { type: 'string' },
      format: { type: 'string' },
      dialect: { type: 'string' },
      node: { type: 'string' },
      zone: { type: 'string' },
      force: { type: 'boolean' },
      repair: { type: 'boolean' },
      'revoke-orphans': { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, sub] = positionals;
  if (!command || values.help || command === 'help') {
    io.out(usage);
    return command || values.help ? 0 : 1;
  }
  const load = io.load ?? ((path) => loadInstance(io.cwd, path));

  try {
    switch (command) {
      case 'migrate': {
        const dr = await load(values.config);
        const result = await dr.initialize();
        io.out(JSON.stringify(result));
        await dr.close();
        return 0;
      }
      case 'maintain': {
        const dr = await load(values.config);
        const run = async () =>
          io.out(`${new Date().toISOString()} ${JSON.stringify(await dr.maintain())}`);
        await run();
        if (!values.every) {
          await dr.close();
          return 0;
        }
        const seconds = Number(values.every);
        if (!Number.isFinite(seconds) || seconds < 10)
          throw new Error('--every takes at least 10 seconds');
        await new Promise<never>(() => {
          setInterval(
            () => void run().catch((error: unknown) => io.err(String(error))),
            seconds * 1000,
          );
        });
        return 0;
      }
      case 'verify': {
        if (!values.tenant || !values.room) throw new Error('verify needs --tenant and --room');
        const dr = await load(values.config);
        const result = await dr.verifyActivity({ tenantId: values.tenant, roomId: values.room });
        io.out(JSON.stringify(result, null, 2));
        await dr.close();
        return result.valid ? 0 : 2;
      }
      case 'doctor':
        return await doctor(await load(values.config), values.tenant, io);
      case 'reconcile': {
        if (!values.tenant) throw new Error('reconcile needs --tenant');
        const dr = await load(values.config);
        const report = await reconcileIam(dr, {
          tenantId: values.tenant,
          ...(values.room ? { roomId: values.room } : {}),
          repair: values.repair ?? false,
          revokeOrphans: values['revoke-orphans'] ?? false,
        });
        await dr.close();
        if (values.json) io.out(JSON.stringify(report, null, 2));
        else {
          for (const item of report.drift)
            io.out(
              `${item.repaired === true ? '✓' : item.repaired === false ? '✗' : '!'} ${item.kind}  room ${item.roomId}: ${item.message}${item.error ? ` (${item.error})` : ''}`,
            );
          const open = report.drift.length - report.repaired;
          io.out(
            report.drift.length === 0
              ? `${report.rooms} room${report.rooms === 1 ? '' : 's'} in sync`
              : `${report.drift.length} difference${report.drift.length === 1 ? '' : 's'} in ${report.rooms} room${report.rooms === 1 ? '' : 's'}` +
                  (values.repair ? `, ${report.repaired} repaired, ${report.failed} failed` : '') +
                  (open && !values.repair ? ' (run with --repair to fix)' : ''),
          );
        }
        return report.drift.length === report.repaired ? 0 : 2;
      }
      case 'generate': {
        const format = values.format ?? 'sql';
        if (!['sql', 'prisma', 'drizzle'].includes(format))
          throw new Error('--format takes sql, prisma or drizzle');
        const dr = await load(values.config);
        const databaseId = dr.options.database.id;
        const dialect =
          values.dialect ?? (/sqlite|libsql/.test(databaseId) ? 'sqlite' : 'postgres');
        if (dialect !== 'postgres' && dialect !== 'sqlite')
          throw new Error('--dialect takes postgres or sqlite');
        const { generateSchema } = await import('@better-files/adapter-sql');
        const text = generateSchema(dr.schema, {
          format: format as 'sql' | 'prisma' | 'drizzle',
          dialect,
        });
        if (values.out) {
          await writeFile(resolve(io.cwd, values.out), text);
          io.out(
            `Wrote ${values.out} (${Object.keys(dr.schema.tables).length} tables, ${dialect})`,
          );
        } else io.out(text);
        return 0;
      }
      case 'openapi': {
        const dr = await load(values.config);
        const text = JSON.stringify(dr.openapi(), null, 2);
        if (values.out) {
          await writeFile(resolve(io.cwd, values.out), `${text}\n`);
          io.out(`Wrote ${values.out}`);
        } else io.out(text);
        return 0;
      }
      case 'storage': {
        const url = values.url ?? io.env.BETTER_FILES_URL;
        const token = values.token ?? io.env.BETTER_FILES_TOKEN;
        const tenantId = values.tenant ?? io.env.BETTER_FILES_TENANT;
        if (!url || !tenantId)
          throw new Error('storage needs --url and --tenant (the operator tenant)');
        const parsed = new URL(url);
        const client = createBetterFilesClient<{ api: object }>({
          baseURL: parsed.origin,
          basePath: parsed.pathname,
          tenantId,
          credentials: 'omit',
          ...(token ? { headers: () => ({ authorization: `Bearer ${token}` }) } : {}),
          ...(io.fetch ? { fetch: io.fetch } : {}),
        });
        const perNode = ['drain', 'activate', 'cordon', 'uncordon', 'remove'];
        if (sub === 'nodes') {
          const nodes = await client.$request<
            {
              id: string;
              name: string;
              zone: string | null;
              state: string;
              cordoned: boolean;
              connectivity: string;
              usedBytes: number;
              capacityBytes: number;
              objects: number;
            }[]
          >('storage/nodes', {});
          const gib = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
          for (const node of nodes)
            io.out(
              `${node.id}  ${node.name.padEnd(16)} ${(node.zone ?? '-').padEnd(10)} ${node.state}${node.cordoned ? ',cordoned' : ''}  ${node.connectivity}  ${gib(node.usedBytes)}/${gib(node.capacityBytes)} GiB  ${node.objects} objects`,
            );
          if (nodes.length === 0)
            io.out(
              'No storage nodes yet: create a join token with better-files storage join-token',
            );
        } else if (sub === 'status')
          io.out(JSON.stringify(await client.$request('storage/status', {}), null, 2));
        else if (sub === 'join-token') {
          const created = await client.$request<{ token: string; expiresAt: number }>(
            'storage/createJoinToken',
            {
              ...(values.zone ? { zone: values.zone } : {}),
            },
          );
          io.out(created.token);
          io.err(
            `Single use, expires ${new Date(created.expiresAt).toISOString()}. Give it to the node as BETTER_FILES_JOIN_TOKEN.`,
          );
        } else if (sub === 'reconcile' || sub === 'sync')
          io.out(JSON.stringify(await client.$request(`storage/${sub}`, {}), null, 2));
        else if (sub && perNode.includes(sub)) {
          if (!values.node) throw new Error(`storage ${sub} needs --node <id>`);
          io.out(
            JSON.stringify(
              await client.$request(`storage/${sub}`, {
                nodeId: values.node,
                ...(sub === 'remove' && values.force ? { force: true } : {}),
              }),
              null,
              2,
            ),
          );
        } else
          throw new Error(
            'storage takes nodes, status, join-token, drain, activate, cordon, uncordon, remove, reconcile or sync',
          );
        return 0;
      }
      case 'sync': {
        const url = values.url ?? io.env.BETTER_FILES_URL;
        const token = values.token ?? io.env.BETTER_FILES_TOKEN;
        const tenantId = values.tenant ?? io.env.BETTER_FILES_TENANT;
        if (!url || !tenantId || !values.room)
          throw new Error(
            'sync needs --url, --tenant and --room (or BETTER_FILES_URL, BETTER_FILES_TENANT)',
          );
        const parsed = new URL(url);
        const client = createBetterFilesClient<{ api: object }>({
          baseURL: parsed.origin,
          basePath: parsed.pathname,
          tenantId,
          credentials: 'omit',
          ...(token ? { headers: () => ({ authorization: `Bearer ${token}` }) } : {}),
          ...(io.fetch ? { fetch: io.fetch } : {}),
        });
        const mirror = createMirror({
          client,
          dir: resolve(io.cwd, values.dir ?? '.'),
          tenantId,
          roomId: values.room,
          baseURL: url,
          log: io.err,
          ...(io.fetch ? { fetch: io.fetch } : {}),
        });
        if (sub === 'pull') printReport(await mirror.pull(), io.out);
        else if (sub === 'push')
          printReport(await mirror.push({ delete: values.delete ?? false }), io.out);
        else if (sub === 'status') {
          const status = await mirror.status();
          if (!status.synced) io.out('Not synced yet: run better-files sync pull');
          else {
            for (const path of status.local.added) io.out(`  + ${path}`);
            for (const path of status.local.modified) io.out(`  M ${path}`);
            for (const path of status.local.deleted) io.out(`  - ${path}`);
            io.out(
              status.remote === 'resync'
                ? 'Remote: full resync needed'
                : `Remote: ${status.remote} pending change(s)`,
            );
          }
        } else throw new Error('sync takes pull, push or status');
        return 0;
      }
      default:
        io.err(`Unknown command ${command}\n\n${usage}`);
        return 1;
    }
  } catch (error) {
    const code = (error as { code?: string }).code;
    io.err(
      `${code && /^[A-Z_]+$/.test(code) ? `${code}: ` : ''}${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

async function doctor(dr: BetterFiles, tenantId: string | undefined, io: CliIo): Promise<number> {
  let failures = 0;
  const check = async (name: string, run: () => Promise<string | void>) => {
    try {
      const detail = await run();
      io.out(`✓ ${name}${detail ? `: ${detail}` : ''}`);
    } catch (error) {
      failures++;
      io.out(`✗ ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const options = dr.options;
  await check('secret', async () => {
    if (options.secret.length < 32) throw new Error('shorter than 32 characters');
  });
  await check('plugins', async () => dr.plugins.map((plugin) => plugin.id).join(', ') || 'none');
  await check('database', async () => {
    await options.database
      .findMany('rooms', { where: { tenantId: '__doctor__' }, limit: 1 })
      .catch((error: unknown) => {
        throw new Error(
          `cannot read the rooms table (run better-files migrate?): ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    return options.database.id;
  });
  await check('storage', async () => {
    const key = `__doctor__/${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const body = new TextEncoder().encode('better-files doctor');
    await options.storage.put(key, body, { contentLength: body.byteLength });
    const read = new Uint8Array(await new Response(await options.storage.get(key)).arrayBuffer());
    await options.storage.delete(key);
    if (new TextDecoder().decode(read) !== 'better-files doctor')
      throw new Error('read back different bytes');
    return `${options.storage.id} (write, read, delete)`;
  });
  await check('encryption', async () => {
    if (!options.encryption) return 'off: files are stored in plain text';
    if (!tenantId)
      return `${options.encryption.keys.id} (pass --tenant to test a data key round trip)`;
    const context = { purpose: 'doctor' };
    const key = await options.encryption.keys.generateDataKey({ tenantId, context });
    const plain = await options.encryption.keys.decryptDataKey({
      tenantId,
      keyRef: key.keyRef,
      wrapped: key.wrapped,
      context,
    });
    if (Buffer.compare(Buffer.from(plain), Buffer.from(key.plaintext)) !== 0)
      throw new Error('data key round trip mismatch');
    return `${options.encryption.keys.id} (data key round trip)`;
  });
  io.out(failures ? `${failures} problem${failures === 1 ? '' : 's'} found` : 'All checks passed');
  return failures ? 1 : 0;
}
