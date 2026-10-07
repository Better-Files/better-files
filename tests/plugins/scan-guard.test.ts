import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { clamavScanner, scanningPlugin, type Scanner } from '@better-files/plugin-scan';
import { guardPlugin, type DownloadAnomaly } from '@better-files/plugin-guard';
import { as, fixture, TENANT } from '../fixtures.js';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

/** A fake clamd that speaks INSTREAM and flags the EICAR test string. */
async function fakeClamd(): Promise<{ port: number; scans: number[] }> {
  const scans: number[] = [];
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let body = Buffer.alloc(0);
    let started = false;
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!started) {
        const command = 'zINSTREAM\0';
        if (buffer.length < command.length) return;
        if (buffer.subarray(0, command.length).toString() !== command)
          return socket.end('UNKNOWN COMMAND\0');
        buffer = buffer.subarray(command.length);
        started = true;
      }
      while (buffer.length >= 4) {
        const size = buffer.readUInt32BE(0);
        if (size === 0) {
          scans.push(body.length);
          const infected = body.toString('latin1').includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE');
          socket.end(infected ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
          return;
        }
        if (buffer.length < 4 + size) return;
        body = Buffer.concat([body, buffer.subarray(4, 4 + size)]);
        buffer = buffer.subarray(4 + size);
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, scans };
}

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

describe('scanning plugin', () => {
  it('quarantines uploads until ClamAV clears them and rejects infected files', async () => {
    const clamd = await fakeClamd();
    const f = await fixture({
      plugins: [scanningPlugin({ scanner: clamavScanner({ port: clamd.port }), mode: 'inline' })],
    });
    const threats: unknown[] = [];
    f.dr.events.subscribe('document.threat-detected', (event) => void threats.push(event.data));
    const room = await f.room();

    const clean = await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'clean.txt',
      content: f.bytes(200_000),
    });
    // The upload response reports the quarantine; the inline scan has cleared it by the time the call returns.
    expect(clean.version.status).toBe('quarantined');
    const cleared = await f.dr.api.documents.get(as('alice'), {
      tenantId: TENANT,
      nodeId: clean.document.id,
    });
    expect(cleared.currentVersion).toMatchObject({ status: 'ready' });
    expect(clamd.scans).toEqual([200_000]);

    const infected = await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'eicar.com',
      content: new TextEncoder().encode(EICAR),
    });
    const rejected = await f.dr.api.versions.list(as('alice'), {
      tenantId: TENANT,
      nodeId: infected.document.id,
    });
    expect(rejected[0]).toMatchObject({ status: 'rejected' });
    expect(threats).toEqual([
      expect.objectContaining({ threat: 'Eicar-Test-Signature', filename: 'eicar.com' }),
    ]);
    await expect(
      f.dr.api.documents.requestOriginal(as('alice'), {
        tenantId: TENANT,
        nodeId: infected.document.id,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // A new version stays unavailable while quarantined; the previous clean one keeps serving.
    const slow: Scanner = { id: 'never', scan: () => new Promise(() => undefined) };
    const g = await fixture({ plugins: [scanningPlugin({ scanner: slow })] });
    const room2 = await g.room();
    const doc = await g.upload('alice', {
      parentId: room2.rootNodeId,
      filename: 'a.txt',
      content: g.bytes(10),
    });
    await g.database.transaction((tx) =>
      tx.update('versions', { id: doc.version.id }, { status: 'ready' }),
    );
    await g.database.transaction((tx) =>
      tx.update('documents', { id: doc.document.id }, { currentVersionId: doc.version.id }),
    );
    const v2 = await g.upload('alice', {
      documentId: doc.document.id,
      filename: 'a.txt',
      content: g.bytes(12),
    });
    expect(v2.version.status).toBe('quarantined');
    const current = await g.dr.api.documents.get(as('alice'), {
      tenantId: TENANT,
      nodeId: doc.document.id,
    });
    expect(current.currentVersion?.number).toBe(1);
    await expect(
      g.dr.api.documents.requestOriginal(as('alice'), {
        tenantId: TENANT,
        nodeId: doc.document.id,
        versionId: v2.version.id,
      }),
    ).rejects.toMatchObject({ code: 'QUARANTINED' });
  });

  it('reports an unreachable scanner and leaves the file quarantined for maintain() to retry', async () => {
    const f = await fixture({
      plugins: [
        scanningPlugin({
          scanner: clamavScanner({ port: 1, timeoutMs: 2000 }),
          mode: 'inline',
          retryAfterMs: 0,
        }),
      ],
    });
    const room = await f.room();
    const doc = await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'a.txt',
      content: f.bytes(10),
    });
    const versions = await f.dr.api.versions.list(as('alice'), {
      tenantId: TENANT,
      nodeId: doc.document.id,
    });
    expect(versions[0]!.status).toBe('quarantined');
  });
});

describe('guard plugin', () => {
  it('stops bulk downloads and reports the anomaly once', async () => {
    const anomalies: DownloadAnomaly[] = [];
    const f = await fixture({
      plugins: [
        guardPlugin({
          maxDownloads: 3,
          windowMs: 60_000,
          onAnomaly: (a) => void anomalies.push(a),
        }),
      ],
    });
    const events: unknown[] = [];
    f.dr.events.subscribe('security.*', (event) => void events.push(event.type));
    const room = await f.room();
    const buyers = await f.dr.api.groups.create(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      name: 'Buyers',
      preset: 'downloadOriginal',
    });
    await f.dr.api.members.invite(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      email: 'bob@acme.test',
      groupIds: [buyers.id],
    });
    const { document } = await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'a.bin',
      content: f.bytes(10),
    });
    const download = () =>
      f.dr.api.documents.requestOriginal(as('bob'), { tenantId: TENANT, nodeId: document.id });
    for (let i = 0; i < 3; i++) await download();
    await expect(download()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await expect(download()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(anomalies).toEqual([
      expect.objectContaining({ principalId: 'bob', count: 4, limit: 3 }),
    ]);
    expect(events).toEqual(['security.download-anomaly']);
    // Owners are exempt, and the window slides.
    for (let i = 0; i < 5; i++)
      await f.dr.api.documents.requestOriginal(as('alice'), {
        tenantId: TENANT,
        nodeId: document.id,
      });
    f.clock.current += 61_000;
    await expect(download()).resolves.toBeDefined();
  });
});
