import { scanningPlugin, type Scanner } from '@better-files/plugin-scan';
import { describe, expect, it } from 'vitest';
import { as, fixture, TENANT } from '../fixtures.js';

describe('background scans as durable jobs', () => {
  it('retries a scan the scanner could not take, then releases the version', async () => {
    let calls = 0;
    const flaky: Scanner = {
      id: 'flaky',
      async scan(content) {
        await new Response(content).arrayBuffer();
        if (++calls === 1) throw new Error('scanner unreachable');
        return { clean: true };
      },
    };
    const f = await fixture({ plugins: [scanningPlugin({ scanner: flaky })] });
    const scanned: string[] = [];
    f.dr.events.subscribe('version.scanned', (event) => void scanned.push(event.type));
    const room = await f.room();
    const doc = await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'a.txt',
      content: f.bytes(10),
    });
    expect(doc.version.status).toBe('quarantined');

    await f.dr.jobs.drain();
    const [job] = await f.dr.jobs.list(TENANT, { name: 'scanning.scan' });
    expect(job).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'scanner unreachable',
      payload: { versionId: doc.version.id },
    });

    f.clock.current += 30_000;
    expect(await f.dr.jobs.work()).toMatchObject({ completed: 1 });
    const versions = await f.dr.api.versions.list(as('alice'), {
      tenantId: TENANT,
      nodeId: doc.document.id,
    });
    expect(versions[0]!.status).toBe('ready');
    expect(scanned).toEqual(['version.scanned']);
    expect(calls).toBe(2);

    // maintain()'s own rescan of stale quarantined versions finds nothing left to do.
    f.clock.current += 60 * 60_000;
    await f.dr.maintain();
    expect(calls).toBe(2);
  });
});
