import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '@better-files/cli';
import { createBetterFilesClient } from '@better-files/client';
import {
  fanOut,
  routes,
  signToken,
  storageCluster,
  type StorageClusterEvent,
} from '@better-files/storage-cluster';
import { storageNode, type StorageNode } from '@better-files/storage-node';
import { memoryDatabase } from '@better-files/testing';
import { storageConformanceCases } from '@better-files/core/conformance';
import { as, fixture, TENANT } from '../fixtures.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step().catch(() => undefined);
});

async function setup(count = 3, options: { replicas?: number } = {}) {
  const clock = { current: Date.now() };
  const clusterDb = memoryDatabase();
  const events: StorageClusterEvent[] = [];
  const cluster = storageCluster({
    onEvent: (event) => void events.push(event),
    database: clusterDb,
    secret: 'a-cluster-secret-with-more-than-32-characters',
    operatorTenant: TENANT,
    replicas: options.replicas ?? 2,
    reserveBytes: 0,
    heartbeatMs: 60_000,
    disconnectedAfterMs: 2_000,
    lostAfterMs: 4_000,
    clock: { now: () => clock.current },
    logger: {},
  });
  await cluster.initialize();
  const f = await fixture({
    storageAdapter: cluster.storage,
    plugins: [cluster.plugin],
    partSize: 64 * 1024,
  });
  const control = (input: string | URL | Request, init?: RequestInit) =>
    f.dr.handler(new Request(input, init));
  const api = f.dr.api.storage;

  const nodes: StorageNode[] = [];
  const dirs: string[] = [];
  const makeNode = async (index: number, joinToken?: string, dir?: string) => {
    const dataDir = dir ?? (await mkdtemp(join(tmpdir(), `better-files-node-${index}-`)));
    const node = storageNode({
      dataDir,
      controlPlane: 'http://app.test/api/better-files',
      tenantId: TENANT,
      ...(joinToken ? { joinToken } : {}),
      name: `node-${index}`,
      zone: `zone-${index % 2}`,
      capacityBytes: 100 * 1024 * 1024,
      fetch: control,
      logger: {},
    });
    await node.start();
    cleanup.push(() => node.stop());
    return { node, dataDir };
  };
  for (let index = 0; index < count; index++) {
    const { token } = await api.createJoinToken(as('alice'), { tenantId: TENANT });
    const { node, dataDir } = await makeNode(index, token);
    nodes.push(node);
    dirs.push(dataDir);
    cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  }
  const heartbeatAll = async () => {
    for (const node of nodes) await node.heartbeat().catch(() => undefined);
  };
  const keys = async () =>
    (await clusterDb.findMany<{ key: string }>('objects', { where: { tenantId: 'cluster' } })).map(
      (o) => o.key,
    );
  const holders = async (key: string) => {
    const [object] = await clusterDb.findMany<{ id: string }>('objects', {
      where: { tenantId: 'cluster', key },
    });
    const replicas = await clusterDb.findMany<{ nodeId: string; state: string }>('replicas', {
      where: { tenantId: 'cluster', objectId: object!.id, state: 'stored' },
    });
    return replicas.map((replica) => replica.nodeId).sort();
  };
  const room = await f.room();
  const upload = (filename: string, content: Uint8Array) =>
    f.upload('alice', { parentId: room.rootNodeId, filename, content });
  const download = async (nodeId: string) => {
    const ticket = await f.dr.api.documents.requestOriginal(as('alice'), {
      tenantId: TENANT,
      nodeId,
    });
    return (await f.download(ticket.url)).body;
  };
  return {
    f,
    cluster,
    clusterDb,
    api,
    nodes,
    dirs,
    clock,
    events,
    heartbeatAll,
    keys,
    holders,
    room,
    upload,
    download,
    makeNode,
  };
}

describe('storage cluster conformance', () => {
  for (const testCase of storageConformanceCases())
    it(testCase.name, async () => {
      const s = await setup(2);
      await testCase.run(s.cluster.storage);
    });
});

describe('fan-out', () => {
  it('bounds memory to the slowest branch and drops cancelled ones', async () => {
    let produced = 0;
    const chunk = new Uint8Array(64 * 1024);
    const source = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (produced >= 64) return controller.close();
          produced++;
          controller.enqueue(chunk);
        },
      },
      { highWaterMark: 0 },
    );
    const [fast, slow, failing] = fanOut(source, 3, 256 * 1024);
    let slowRead = 0;
    let maxLag = 0;
    const drain = async (
      stream: ReadableStream<Uint8Array>,
      delay: number,
      onChunk?: () => void,
    ) => {
      const reader = stream.getReader();
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return bytes;
        bytes += value.byteLength;
        onChunk?.();
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      }
    };
    await failing!.cancel();
    const [fastBytes, slowBytes] = await Promise.all([
      drain(fast!, 0, () => (maxLag = Math.max(maxLag, produced - slowRead))),
      drain(slow!, 2, () => slowRead++),
    ]);
    expect(fastBytes).toBe(64 * 64 * 1024);
    expect(slowBytes).toBe(64 * 64 * 1024);
    // The fast reader never ran more than the buffer (4 chunks) plus one ahead of the slow one.
    expect(maxLag).toBeLessThanOrEqual(6);
  });
});

describe('storage cluster', () => {
  it('runs one reconciler across control-plane instances and publishes fleet events', async () => {
    const s = await setup(2);
    expect(s.events.filter((event) => event.type === 'storage.node.joined')).toHaveLength(2);
    const other = storageCluster({
      database: s.clusterDb,
      secret: 'a-cluster-secret-with-more-than-32-characters',
      operatorTenant: TENANT,
    });
    const [a, b] = await Promise.all([s.cluster.reconcile(), other.reconcile()]);
    expect([a.skipped ?? false, b.skipped ?? false].sort()).toEqual([false, true]);
    // The lease is released after a run.
    expect((await other.reconcile()).skipped).toBeUndefined();

    // A stopped node is announced as disconnected, then lost; dr.events carries it for webhooks.
    const seen: string[] = [];
    s.f.dr.events.subscribe('storage.*', (event) => void seen.push(event.type));
    await s.nodes[1]!.stop();
    s.clock.current += 3_000;
    await s.nodes[0]!.heartbeat();
    await s.f.dr.maintain();
    s.clock.current += 2_000;
    await s.nodes[0]!.heartbeat();
    await s.f.dr.maintain();
    expect(s.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['storage.node.disconnected', 'storage.node.lost']),
    );
    expect(seen).toEqual(expect.arrayContaining(['storage.node.lost']));
  });

  it('joins nodes, keeps two copies of every file across zones, and reads past a stopped node', async () => {
    const s = await setup();
    const nodes = await s.api.nodes(as('alice'), { tenantId: TENANT });
    expect(nodes.map((node) => [node.name, node.state, node.connectivity])).toEqual([
      ['node-0', 'active', 'connected'],
      ['node-1', 'active', 'connected'],
      ['node-2', 'active', 'connected'],
    ]);

    const small = s.f.bytes(5_000, 1);
    const large = s.f.bytes(200_000, 2); // multipart: four 64 KiB parts
    const { document: first } = await s.upload('small.bin', small);
    const { document: second } = await s.upload('large.bin', large);
    await s.heartbeatAll();
    const status = await s.api.status(as('alice'), { tenantId: TENANT });
    expect(status).toMatchObject({ replicas: 2, writeQuorum: 2, objects: 2, underReplicated: 0 });
    expect(status.nodes).toMatchObject({ total: 3, connected: 3 });

    // Two copies each, on nodes in different zones, holding ciphertext only.
    for (const key of await s.keys()) {
      const holders = await s.holders(key);
      expect(holders).toHaveLength(2);
      const zones = new Set(holders.map((id) => nodes.find((node) => node.id === id)!.zone));
      expect(zones.size).toBe(2);
      const onDisk = await readFile(
        s.nodes.find((node) => node.nodeId === holders[0])!.pathOf(key),
      );
      expect(onDisk.includes(Buffer.from(small.subarray(0, 32)))).toBe(false);
    }

    // Stop one node: everything still reads from the other copy.
    const [key] = await s.keys();
    const stoppedId = (await s.holders(key!))[0]!;
    await s.nodes.find((node) => node.nodeId === stoppedId)!.stop();
    expect(s.f.sha256(await s.download(first.id))).toBe(s.f.sha256(small));
    expect(s.f.sha256(await s.download(second.id))).toBe(s.f.sha256(large));

    // Disconnected is not dead: nothing is copied until the node is lost.
    s.clock.current += 3_000;
    await s.heartbeatAll();
    expect((await s.cluster.reconcile()).replicated).toBe(0);
    s.clock.current += 2_000;
    await s.heartbeatAll();
    const report = await s.cluster.reconcile();
    expect(report.replicated).toBeGreaterThanOrEqual(1);
    expect(report.underReplicated).toBe(0);
    for (const key of await s.keys()) {
      const holders = await s.holders(key);
      expect(holders.filter((id) => id !== stoppedId)).toHaveLength(2);
    }
    expect(s.f.sha256(await s.download(first.id))).toBe(s.f.sha256(small));
  });

  it('drains a node before removing it, and deletes bytes from every node', async () => {
    const s = await setup();
    const { document } = await s.upload('deck.bin', s.f.bytes(100_000, 3));
    await s.upload('notes.bin', s.f.bytes(3_000, 4));
    const [key] = await s.keys();
    const nodeId = (await s.holders(key!))[0]!;
    const busy = s.nodes.find((node) => node.nodeId === nodeId)!;
    const held = async () =>
      (await s.clusterDb.findMany('replicas', { where: { tenantId: 'cluster', nodeId } })).length;

    await expect(s.api.remove(as('alice'), { tenantId: TENANT, nodeId })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await s.api.drain(as('alice'), { tenantId: TENANT, nodeId });
    await s.api.reconcile(as('alice'), { tenantId: TENANT });
    expect(await held()).toBe(0);
    expect(await s.api.remove(as('alice'), { tenantId: TENANT, nodeId })).toMatchObject({
      removed: nodeId,
      droppedCopies: 0,
    });
    // Removal revokes the node: its heartbeats no longer verify.
    await expect(busy.heartbeat()).rejects.toThrow(/Unknown node|bad signature/);
    expect((await s.api.status(as('alice'), { tenantId: TENANT })).underReplicated).toBe(0);
    await s.download(document.id);

    // Deleting a document (purge) removes its bytes from every holder.
    const holders = await s.holders(key!);
    await s.cluster.storage.delete(key!);
    for (const holder of holders)
      await expect(
        readFile(s.nodes.find((node) => node.nodeId === holder)!.pathOf(key!)),
      ).rejects.toThrow();
  });

  it('finds corrupt copies, repairs them, and rebuilds a lost index from the nodes', async () => {
    const s = await setup();
    const content = s.f.bytes(40_000, 5);
    const { document } = await s.upload('ledger.bin', content);
    const [key] = await s.keys();
    const [victim] = await s.holders(key!);
    const path = s.nodes.find((node) => node.nodeId === victim)!.pathOf(key!);
    const bytes = await readFile(path);
    bytes[100] = bytes[100]! ^ 0xff;
    await writeFile(path, bytes);

    const verified = await s.cluster.verify([key!]);
    expect(verified[key!]!.filter((entry) => !entry.ok).map((entry) => entry.nodeId)).toEqual([
      victim,
    ]);
    const report = await s.cluster.reconcile({ verify: 0 });
    expect(report.replicated).toBe(1);
    expect(
      Object.values(await s.cluster.verify([key!]))
        .flat()
        .every((entry) => entry.ok),
    ).toBe(true);
    expect(s.f.sha256(await s.download(document.id))).toBe(s.f.sha256(content));

    // Lose the index: the nodes still know what they hold.
    await s.clusterDb.transaction(async (tx) => {
      await tx.delete('replicas', { tenantId: 'cluster' });
      await tx.delete('objects', { tenantId: 'cluster' });
    });
    await expect(s.download(document.id)).rejects.toThrow();
    const synced = await s.cluster.sync();
    expect(synced.recovered).toBe(1);
    expect(s.f.sha256(await s.download(document.id))).toBe(s.f.sha256(content));
  });

  it('delivers deletions to a node that was offline through its heartbeat', async () => {
    const s = await setup(2);
    await s.upload('temp.bin', s.f.bytes(2_000, 6));
    const [key] = await s.keys();
    const offline = s.nodes[1]!;
    const path = offline.pathOf(key!);
    await offline.stop();
    s.clock.current += 3_000;
    await s.nodes[0]!.heartbeat();
    await s.cluster.storage.delete(key!);
    expect(await readFile(path)).toBeDefined(); // still there: the node was away
    // Back online (same disk, same identity): the next heartbeat carries the deletion.
    const { node } = await s.makeNode(1, undefined, s.dirs[1]!);
    await node.heartbeat();
    await node.heartbeat(); // reports the result
    await expect(readFile(path)).rejects.toThrow();
    expect(await s.clusterDb.count('commands', { tenantId: 'cluster' })).toBe(0);
  });

  it('takes direct uploads straight to a node and replicates them', async () => {
    const s = await setup();
    const client = createBetterFilesClient<typeof s.f.dr>({
      baseURL: 'http://app.test',
      tenantId: TENANT,
      headers: () => ({ authorization: 'Bearer alice' }),
      fetch: (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        return url.startsWith('http://app.test')
          ? s.f.dr.handler(new Request(input, init))
          : fetch(input, init);
      },
    });
    const content = s.f.bytes(150_000, 7);
    const result = await client.upload({
      parentId: s.room.rootNodeId,
      file: new Blob([content]),
      filename: 'direct.bin',
      direct: true,
    });
    expect(s.f.sha256(await s.download(result.document.id))).toBe(s.f.sha256(content));
    const [key] = await s.keys();
    expect(await s.holders(key!)).toHaveLength(2);
  });

  it('is operated from the better-files CLI', async () => {
    const s = await setup(2);
    const lines: string[] = [];
    const run = (...args: string[]) =>
      main(
        [
          'storage',
          ...args,
          '--url',
          'http://app.test/api/better-files',
          '--tenant',
          TENANT,
          '--token',
          'alice',
        ],
        {
          out: (line) => lines.push(line),
          err: (line) => lines.push(line),
          env: {},
          cwd: '.',
          fetch: (input, init) => s.f.dr.handler(new Request(input, init)),
        },
      );
    expect(await run('nodes')).toBe(0);
    expect(lines.filter((line) => line.includes('connected'))).toHaveLength(2);
    lines.length = 0;
    expect(await run('join-token', '--zone', 'eu-1')).toBe(0);
    expect(lines[0]).toMatch(/^bfj_/);
    expect(await run('cordon', '--node', s.nodes[0]!.nodeId!)).toBe(0);
    expect((await s.cluster.nodes()).find((node) => node.id === s.nodes[0]!.nodeId)!.cordoned).toBe(
      true,
    );
    expect(await run('drain')).toBe(1);
    // Other tenants' administrators do not run the fleet.
    expect(
      await main(
        [
          'storage',
          'nodes',
          '--url',
          'http://app.test/api/better-files',
          '--tenant',
          't2',
          '--token',
          'mallory',
        ],
        {
          out() {},
          err: (line) => lines.push(line),
          env: {},
          cwd: '.',
          fetch: (input, init) => s.f.dr.handler(new Request(input, init)),
        },
      ),
    ).toBe(1);
  });

  it('refuses reused join tokens, forged heartbeats and tokens for another node', async () => {
    const s = await setup(2);
    const { token } = await s.api.createJoinToken(as('alice'), { tenantId: TENANT });
    const first = await s.makeNode(9, token);
    await expect(s.makeNode(10, token)).rejects.toThrow(/invalid, used or expired/);
    first.node.stop();

    const heartbeat = await s.f.dr.handler(
      new Request('http://app.test/api/better-files/storage/heartbeat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-better-files': '1' },
        body: JSON.stringify({
          tenantId: TENANT,
          nodeId: s.nodes[0]!.nodeId,
          timestamp: Date.now(),
          body: '{}',
          signature: 'forged-signature-forged-signature',
        }),
      }),
    );
    expect(heartbeat.status).toBe(401);

    // A token signed for node 0's identity is refused by node 1.
    const forged = signToken('not-the-node-secret-not-the-node-secret', {
      n: s.nodes[1]!.nodeId!,
      o: 'inventory',
      e: Date.now() + 60_000,
    });
    const refused = await fetch(`${s.nodes[1]!.url}${routes.inventory}`, {
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(refused.status).toBe(401);
    expect((await fetch(`${s.nodes[1]!.url}${routes.health}`)).status).toBe(200);
  });
});
