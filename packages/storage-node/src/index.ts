import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  AGENT_VERSION,
  isValidKey,
  objectName,
  signHeartbeat,
  verifyToken,
  type CommandResult,
  type DataOperation,
  type DataToken,
  type HeartbeatBody,
  type NodeCommand,
  type NodeStats,
} from '@better-files/storage-cluster/protocol';

export interface StorageNodeOptions {
  /** Where objects, staged parts and the node identity live. */
  dataDir: string;
  /** The Better Files protocol URL of the control plane, such as `https://app.example.com/api/better-files`. */
  controlPlane: string;
  /** The operator tenant the cluster belongs to. */
  tenantId: string;
  /** Needed on first start only; afterwards the identity in `dataDir/node.json` is used. */
  joinToken?: string;
  /** How the control plane (and, for direct uploads, browsers) reach this node. Default: the listening address. */
  advertiseUrl?: string;
  name?: string;
  zone?: string;
  /** Bytes this node may use. Default: the free space of its disk. */
  capacityBytes?: number;
  listen?: { port?: number; host?: string };
  /** Origins allowed to PUT parts directly from a browser (direct uploads). */
  corsOrigins?: readonly string[] | '*';
  fetch?: typeof fetch;
  logger?: {
    info?(message: string, data?: unknown): void;
    error?(message: string, data?: unknown): void;
  };
}

interface Identity {
  nodeId: string;
  secret: string;
  generation: number;
  controlPlane: string;
  tenantId: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const uploadIdPattern = /^[A-Za-z0-9._~-]{1,160}$/;

/** Counts and hashes bytes on their way to disk, refusing more than `limit`. */
function meter(limit: number) {
  const hash = createHash('sha256');
  let size = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.byteLength;
      if (size > limit) return callback(new HttpError(413, 'Body larger than allowed'));
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  return { stream, result: () => ({ size, sha256: hash.digest('hex') }) };
}

async function readJson<T>(req: IncomingMessage, limit = 1024 * 1024): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.byteLength;
    if (size > limit) throw new HttpError(413, 'Body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as T;
}

/**
 * A storage node: serves the cluster's encrypted objects from a local disk. It dials out to the control plane to
 * join and heartbeat (nothing needs to reach it for control), runs the commands heartbeats return, and answers
 * data requests carrying tokens the control plane signed for it.
 */
export function storageNode(options: StorageNodeOptions) {
  const root = resolve(options.dataDir);
  const dirs = {
    objects: join(root, 'objects'),
    uploads: join(root, 'uploads'),
    tmp: join(root, 'tmp'),
  };
  const identityFile = join(root, 'node.json');
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const log = options.logger ?? {
    info() {},
    error: (message: string, data?: unknown) => console.error(message, data),
  };
  let identity: Identity | undefined;
  let usedBytes = 0;
  let objects = 0;
  let heartbeatMs = 10_000;
  let server: Server | undefined;
  let timer: NodeJS.Timeout | undefined;
  let advertised = options.advertiseUrl;
  let stopped = false;
  const results: CommandResult[] = [];

  const objectPath = (key: string) => {
    const name = objectName(key);
    return join(dirs.objects, name.slice(0, 2), name);
  };
  const temporary = () => join(dirs.tmp, `${Date.now()}-${randomBytes(8).toString('hex')}`);

  async function stats(): Promise<NodeStats> {
    let diskFree = Number.MAX_SAFE_INTEGER;
    try {
      const fs = await statfs(root);
      diskFree = Number(fs.bavail) * Number(fs.bsize);
    } catch {
      /* statfs is unavailable on some platforms; rely on capacityBytes */
    }
    const capacityBytes = options.capacityBytes ?? usedBytes + diskFree;
    return {
      capacityBytes,
      usedBytes,
      freeBytes: Math.max(0, Math.min(capacityBytes - usedBytes, diskFree)),
      objects,
    };
  }

  async function scan() {
    usedBytes = 0;
    objects = 0;
    for (const shard of await readdir(dirs.objects).catch(() => [] as string[]))
      for (const entry of await readdir(join(dirs.objects, shard)).catch(() => [] as string[]))
        if (entry.endsWith('.meta')) {
          const meta = JSON.parse(await readFile(join(dirs.objects, shard, entry), 'utf8')) as {
            size: number;
          };
          usedBytes += meta.size;
          objects++;
        }
  }

  async function control<T>(path: string, input: Record<string, unknown>): Promise<T> {
    const base = (identity?.controlPlane ?? options.controlPlane).replace(/\/+$/, '');
    const response = await doFetch(`${base}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-better-files': '1' },
      body: JSON.stringify({ tenantId: identity?.tenantId ?? options.tenantId, ...input }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      data?: T;
      error?: { code: string; message: string };
    };
    if (!response.ok || body.error)
      throw Object.assign(
        new Error(body.error?.message ?? `Control plane answered ${response.status}`),
        {
          code: body.error?.code,
        },
      );
    return body.data as T;
  }

  async function join_(url: string) {
    if (!options.joinToken)
      throw new Error('This node has no identity yet: start it once with a join token');
    const joined = await control<{
      nodeId: string;
      secret: string;
      generation: number;
      heartbeatMs: number;
    }>('storage/join', {
      token: options.joinToken,
      name: options.name ?? `node-${randomBytes(3).toString('hex')}`,
      ...(options.zone ? { zone: options.zone } : {}),
      url,
      capacityBytes: (await stats()).capacityBytes,
      version: AGENT_VERSION,
    });
    identity = {
      nodeId: joined.nodeId,
      secret: joined.secret,
      generation: joined.generation,
      controlPlane: options.controlPlane,
      tenantId: options.tenantId,
    };
    heartbeatMs = joined.heartbeatMs;
    await writeFile(identityFile, JSON.stringify(identity, null, 2), { mode: 0o600 });
    log.info?.('Joined the storage cluster', { nodeId: joined.nodeId });
  }

  async function execute(command: NodeCommand): Promise<CommandResult> {
    try {
      if (command.type === 'delete') await removeObject(command.key);
      return { id: command.id, ok: true };
    } catch (error) {
      return {
        id: command.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  let lastTimestamp = 0;
  /** One heartbeat: stats and command results up, commands down. */
  async function heartbeat() {
    if (!identity) throw new Error('Not joined');
    // A stopped node must not look alive to the control plane.
    if (stopped || !server) throw new Error('The node is stopped');
    const sending = results.splice(0);
    const payload: HeartbeatBody = {
      stats: await stats(),
      results: sending,
      version: AGENT_VERSION,
    };
    const body = JSON.stringify({ ...payload, ...(advertised ? { url: advertised } : {}) });
    // The control plane refuses a heartbeat no newer than the last (replay protection): two in one millisecond
    // must still differ.
    const timestamp = Math.max(Date.now(), lastTimestamp + 1);
    lastTimestamp = timestamp;
    try {
      const reply = await control<{ heartbeatMs: number; commands: NodeCommand[] }>(
        'storage/heartbeat',
        {
          nodeId: identity.nodeId,
          timestamp,
          body,
          signature: signHeartbeat(identity.secret, identity.nodeId, timestamp, body),
        },
      );
      heartbeatMs = reply.heartbeatMs;
      for (const command of reply.commands) results.push(await execute(command));
    } catch (error) {
      results.unshift(...sending);
      throw error;
    }
  }

  function schedule() {
    if (stopped) return;
    // Jitter spreads a fleet's heartbeats out after a control-plane restart.
    timer = setTimeout(
      () => {
        heartbeat()
          .catch((error: unknown) => log.error?.('Heartbeat failed', { error: String(error) }))
          .finally(schedule);
      },
      heartbeatMs * (0.8 + Math.random() * 0.4),
    );
    timer.unref?.();
  }

  async function writeObject(
    key: string,
    source: AsyncIterable<Uint8Array> | NodeJS.ReadableStream,
    limit: number,
  ) {
    const tmp = temporary();
    const metered = meter(limit);
    await pipeline(source, metered.stream, createWriteStream(tmp, { flags: 'wx' }));
    return { tmp, ...metered.result() };
  }

  async function commit(key: string, tmp: string, size: number, sha256: string) {
    const path = objectPath(key);
    await mkdir(join(path, '..'), { recursive: true });
    const previous = await readFile(`${path}.meta`, 'utf8')
      .then((text) => JSON.parse(text) as { size: number })
      .catch(() => undefined);
    await rename(tmp, path);
    await writeFile(`${path}.meta`, JSON.stringify({ key, size, sha256, storedAt: Date.now() }));
    usedBytes += size - (previous?.size ?? 0);
    if (!previous) objects++;
  }

  async function removeObject(key: string) {
    const path = objectPath(key);
    const meta = await readFile(`${path}.meta`, 'utf8')
      .then((text) => JSON.parse(text) as { size: number })
      .catch(() => undefined);
    await rm(path, { force: true });
    await rm(`${path}.meta`, { force: true });
    if (meta) {
      usedBytes -= meta.size;
      objects--;
    }
  }

  async function hashFile(path: string) {
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
      hash.update(chunk);
      size += chunk.byteLength;
    }
    return { size, sha256: hash.digest('hex') };
  }

  function cors(req: IncomingMessage, res: ServerResponse) {
    const origin = req.headers.origin;
    const allowed = options.corsOrigins;
    if (!origin || !allowed) return;
    if (allowed === '*' || allowed.includes(origin)) {
      res.setHeader('access-control-allow-origin', allowed === '*' ? '*' : origin);
      res.setHeader('access-control-allow-methods', 'GET, HEAD, PUT');
      res.setHeader('access-control-allow-headers', 'content-type, authorization');
      res.setHeader('access-control-expose-headers', 'etag, content-range, content-length');
      res.setHeader('access-control-max-age', '600');
      if (allowed !== '*') res.setHeader('vary', 'origin');
    }
  }

  const json = (
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) => {
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...headers,
    });
    res.end(JSON.stringify(body));
  };

  function authorize(
    req: IncomingMessage,
    url: URL,
    operation: DataOperation,
    expect: Partial<DataToken>,
  ): DataToken {
    const header = req.headers.authorization;
    const raw = header?.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('t');
    const claims = identity && raw ? verifyToken(identity.secret, raw) : undefined;
    if (!claims || claims.n !== identity!.nodeId || claims.o !== operation)
      throw new HttpError(401, 'Invalid token');
    for (const [name, value] of Object.entries(expect))
      if (claims[name as keyof DataToken] !== value)
        throw new HttpError(401, 'Token does not match the request');
    return claims;
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    cors(req, res);
    const url = new URL(req.url ?? '/', 'http://node');
    const method = req.method ?? 'GET';
    if (method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    const parts = url.pathname.split('/').filter(Boolean);
    if (method === 'GET' && url.pathname === '/health')
      return json(res, 200, { ok: true, nodeId: identity?.nodeId ?? null, version: AGENT_VERSION });

    if (parts[0] === 'o' && parts[1]) {
      const key = decodeURIComponent(parts[1]);
      if (!isValidKey(key)) throw new HttpError(400, 'Invalid key');
      const path = objectPath(key);
      if (parts[2] === 'verify' && method === 'POST') {
        authorize(req, url, 'verify', { k: key });
        const meta = await readFile(`${path}.meta`, 'utf8').catch(() => undefined);
        if (!meta) throw new HttpError(404, 'No such object');
        return json(res, 200, await hashFile(path));
      }
      if (parts.length !== 2) throw new HttpError(404, 'Not found');
      if (method === 'PUT') {
        const claims = authorize(req, url, 'put', { k: key });
        const written = await writeObject(key, req, claims.m ?? Number.MAX_SAFE_INTEGER);
        await commit(key, written.tmp, written.size, written.sha256);
        return json(res, 200, { size: written.size, sha256: written.sha256 });
      }
      if (method === 'GET' || method === 'HEAD') {
        authorize(req, url, 'get', { k: key });
        const meta = await readFile(`${path}.meta`, 'utf8')
          .then((text) => JSON.parse(text) as { size: number; sha256: string })
          .catch(() => undefined);
        if (!meta) throw new HttpError(404, 'No such object');
        const headers: Record<string, string> = {
          'content-type': 'application/octet-stream',
          'accept-ranges': 'bytes',
          etag: `"${meta.sha256}"`,
          'cache-control': 'no-store',
        };
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
        let start = 0;
        let end = meta.size - 1;
        let status = 200;
        if (range && (range[1] || range[2]) && meta.size > 0) {
          start = range[1] ? Number(range[1]) : Math.max(0, meta.size - Number(range[2]));
          end = range[1] && range[2] ? Math.min(Number(range[2]), meta.size - 1) : meta.size - 1;
          if (start > end) {
            res.writeHead(416, { 'content-range': `bytes */${meta.size}` }).end();
            return;
          }
          status = 206;
          headers['content-range'] = `bytes ${start}-${end}/${meta.size}`;
        }
        headers['content-length'] = String(meta.size === 0 ? 0 : end - start + 1);
        res.writeHead(status, headers);
        if (method === 'HEAD' || meta.size === 0) return void res.end();
        await pipeline(createReadStream(path, { start, end }), res);
        return;
      }
      if (method === 'DELETE') {
        authorize(req, url, 'delete', { k: key });
        await removeObject(key);
        res.writeHead(204).end();
        return;
      }
    }

    if (parts[0] === 'u' && parts[1]) {
      const uploadId = decodeURIComponent(parts[1]);
      if (!uploadIdPattern.test(uploadId)) throw new HttpError(400, 'Invalid upload id');
      const staging = join(dirs.uploads, uploadId);
      if (parts[2] === 'complete' && method === 'POST') {
        const claims = authorize(req, url, 'complete', { u: uploadId });
        const key = claims.k!;
        const { parts: list } = await readJson<{ parts: { part: number; etag: string }[] }>(req);
        const ordered = [...list].sort((a, b) => a.part - b.part);
        const tmp = temporary();
        const hash = createHash('sha256');
        let size = 0;
        const out = await open(tmp, 'wx');
        try {
          for (const { part, etag } of ordered) {
            const partSha = await readFile(join(staging, `${part}.sha`), 'utf8').catch(
              () => undefined,
            );
            if (!partSha || partSha !== etag.replace(/"/g, ''))
              throw new HttpError(400, `Part ${part} is missing or changed`);
            for await (const chunk of createReadStream(
              join(staging, String(part)),
            ) as AsyncIterable<Buffer>) {
              hash.update(chunk);
              size += chunk.byteLength;
              await out.write(chunk);
            }
          }
        } catch (error) {
          await out.close();
          await rm(tmp, { force: true });
          throw error;
        }
        await out.close();
        const sha256 = hash.digest('hex');
        await commit(key, tmp, size, sha256);
        await rm(staging, { recursive: true, force: true });
        return json(res, 200, { size, sha256 });
      }
      if (parts[2] && method === 'PUT') {
        const part = Number(parts[2]);
        if (!Number.isInteger(part) || part < 1 || part > 10_000)
          throw new HttpError(400, 'Invalid part');
        const claims = authorize(req, url, 'part', { u: uploadId, p: part });
        await mkdir(staging, { recursive: true });
        const written = await writeObject(
          `${uploadId}/${part}`,
          req,
          claims.m ?? Number.MAX_SAFE_INTEGER,
        );
        await rename(written.tmp, join(staging, String(part)));
        await writeFile(join(staging, `${part}.sha`), written.sha256);
        return json(
          res,
          200,
          { size: written.size, etag: `"${written.sha256}"` },
          { etag: `"${written.sha256}"` },
        );
      }
      if (!parts[2] && method === 'DELETE') {
        authorize(req, url, 'abort', { u: uploadId });
        await rm(staging, { recursive: true, force: true });
        res.writeHead(204).end();
        return;
      }
    }

    if (method === 'GET' && url.pathname === '/inventory') {
      authorize(req, url, 'inventory', {});
      const after = url.searchParams.get('after') ?? '';
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 1000) || 1000, 5000);
      const names: string[] = [];
      for (const shard of (await readdir(dirs.objects).catch(() => [] as string[])).sort())
        for (const entry of (
          await readdir(join(dirs.objects, shard)).catch(() => [] as string[])
        ).sort())
          if (entry.endsWith('.meta') && entry > after) names.push(entry);
      names.sort();
      const page = names.slice(0, limit);
      const items = [];
      for (const name of page) {
        const meta = JSON.parse(
          await readFile(join(dirs.objects, name.slice(0, 2), name), 'utf8'),
        ) as {
          key: string;
          size: number;
          sha256: string;
        };
        items.push({ key: meta.key, size: meta.size, sha256: meta.sha256 });
      }
      return json(res, 200, { items, ...(names.length > limit ? { next: page.at(-1) } : {}) });
    }
    if (method === 'GET' && url.pathname === '/stats') {
      authorize(req, url, 'stats', {});
      return json(res, 200, await stats());
    }
    throw new HttpError(404, 'Not found');
  }

  const listener = (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) log.error?.('Storage node request failed', { error: String(error) });
      if (!res.headersSent)
        json(res, status, {
          error: error instanceof Error && status !== 500 ? error.message : 'Internal error',
        });
      else res.destroy();
    });
  };

  return {
    /** Listens, joins on first start, and begins heartbeats. */
    async start(): Promise<{ nodeId: string; url: string }> {
      stopped = false;
      await mkdir(dirs.objects, { recursive: true });
      await mkdir(dirs.uploads, { recursive: true });
      await rm(dirs.tmp, { recursive: true, force: true });
      await mkdir(dirs.tmp, { recursive: true });
      identity = await readFile(identityFile, 'utf8')
        .then((text) => JSON.parse(text) as Identity)
        .catch(() => undefined);
      await scan();
      server = createServer(listener);
      await new Promise<void>((resolve_) =>
        server!.listen(options.listen?.port ?? 0, options.listen?.host ?? '127.0.0.1', resolve_),
      );
      const address = server.address() as AddressInfo;
      advertised ??= `http://${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port}`;
      if (!identity) await join_(advertised);
      await heartbeat().catch((error: unknown) =>
        log.error?.('First heartbeat failed', { error: String(error) }),
      );
      schedule();
      return { nodeId: identity!.nodeId, url: advertised };
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (server) {
        server.closeAllConnections?.();
        await new Promise<void>((resolve_) => server!.close(() => resolve_()));
        server = undefined;
      }
    },
    /** Sends one heartbeat now (tests, scripts). */
    heartbeat,
    stats,
    get nodeId() {
      return identity?.nodeId;
    },
    get url() {
      return advertised;
    },
    /** Where an object's bytes are on disk (operations and tests). */
    pathOf: objectPath,
  };
}

export type StorageNode = ReturnType<typeof storageNode>;
