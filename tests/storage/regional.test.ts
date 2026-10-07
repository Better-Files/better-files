import { describe, expect, it } from 'vitest';
import { storageConformanceCases } from '@better-files/core/conformance';
import type { BlobRecord, Room } from '@better-files/core';
import { memoryStorage } from '@better-files/testing';
import { moveRoom, regionalStorage, rekey } from '@better-files/storage-regional';
import { as, fixture, TENANT } from '../fixtures.js';

const regions = () => {
  const eu = memoryStorage();
  const us = memoryStorage();
  return { eu, us };
};

describe('regional storage conformance', () => {
  for (const testCase of storageConformanceCases())
    it(testCase.name, () => {
      const { eu, us } = regions();
      return testCase.run(regionalStorage({ regions: { eu, us }, defaultRegion: 'eu' }));
    });
});

describe('regionalStorage', () => {
  it('routes by the g/{region}/ prefix and strips it for the region adapter', async () => {
    const { eu, us } = regions();
    const storage = regionalStorage({ regions: { eu, us }, defaultRegion: 'eu' });
    await storage.put('g/us/t/a/r/b/blob_1', new Uint8Array([1, 2, 3]));
    await storage.put('t/a/r/b/blob_0', new Uint8Array([4]));
    expect([...us.objects.keys()]).toEqual(['t/a/r/b/blob_1']);
    expect([...eu.objects.keys()]).toEqual(['t/a/r/b/blob_0']);
    expect(await storage.head('g/us/t/a/r/b/blob_1')).toMatchObject({
      key: 'g/us/t/a/r/b/blob_1',
      size: 3,
    });
    expect(storage.regionOf('t/x')).toBe('eu');
    await expect(storage.put('g/mars/t/x', new Uint8Array(1))).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });

  it('copies across regions by streaming', async () => {
    const { eu, us } = regions();
    const storage = regionalStorage({ regions: { eu, us }, defaultRegion: 'eu' });
    await storage.put('g/eu/k', new Uint8Array([9, 8, 7]));
    const copied = await storage.copy!('g/eu/k', rekey('g/eu/k', 'us'));
    expect(copied).toMatchObject({ key: 'g/us/k', size: 3 });
    expect([...us.objects.get('k')!]).toEqual([9, 8, 7]);
  });

  it('refuses bad configuration', () => {
    const { eu } = regions();
    expect(() => regionalStorage({ regions: {}, defaultRegion: 'eu' })).toThrow(/at least one/);
    expect(() => regionalStorage({ regions: { EU: eu }, defaultRegion: 'EU' })).toThrow(
      /lower-case/,
    );
    expect(() => regionalStorage({ regions: { eu }, defaultRegion: 'us' })).toThrow(/not one of/);
    expect(() => regionalStorage({ regions: { eu }, defaultRegion: () => 'eu' })).toThrow(
      /unplacedRegion/,
    );
  });

  it('offers multipart and presigning only when every region does', () => {
    const { eu } = regions();
    const plain = { ...memoryStorage(), multipart: undefined };
    expect(regionalStorage({ regions: { eu }, defaultRegion: 'eu' }).multipart).toBeDefined();
    expect(regionalStorage({ regions: { eu, us: plain }, defaultRegion: 'eu' }).multipart).toBe(
      undefined,
    );
  });
});

describe('rooms with a residency region', () => {
  async function setup(options: Partial<Parameters<typeof regionalStorage>[0]> = {}) {
    const { eu, us } = regions();
    const storage = regionalStorage({ regions: { eu, us }, defaultRegion: 'eu', ...options });
    const f = await fixture({ storageAdapter: storage });
    return { f, eu, us, storage };
  }

  it('stores a room’s files in its region and serves them from there', async () => {
    const { f, eu, us } = await setup();
    const room = await f.dr.api.rooms.create(as('alice'), {
      tenantId: TENANT,
      name: 'Zurich deal',
      region: 'us',
    });
    expect(room.region).toBe('us');
    const content = f.bytes(150_000);
    const { document } = await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'model.xlsx',
      content,
    });
    expect(us.objects.size).toBe(1);
    expect(eu.objects.size).toBe(0);
    const ticket = await f.dr.api.documents.requestOriginal(as('alice'), {
      tenantId: TENANT,
      nodeId: document.id,
    });
    expect(Buffer.from((await f.download(ticket.url)).body).equals(Buffer.from(content))).toBe(
      true,
    );
  });

  it('uses the default region, and refuses unknown or disallowed ones', async () => {
    const { f } = await setup({
      defaultRegion: ({ tenantId }) => (tenantId === TENANT ? 'us' : 'eu'),
      unplacedRegion: 'eu',
      allows: ({ region }) => region !== 'eu',
    });
    expect((await f.room()).region).toBe('us');
    await expect(
      f.dr.api.rooms.create(as('alice'), { tenantId: TENANT, name: 'X', region: 'mars' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      f.dr.api.rooms.create(as('alice'), { tenantId: TENANT, name: 'Y', region: 'eu' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a region without regional storage', async () => {
    const f = await fixture();
    await expect(
      f.dr.api.rooms.create(as('alice'), { tenantId: TENANT, name: 'X', region: 'eu' }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect((await f.room()).region).toBeUndefined();
  });

  it('moves a room between regions, resumably, leaving open uploads for a later run', async () => {
    const { f, eu, us, storage } = await setup();
    const room = await f.room();
    expect(room.region).toBe('eu');
    const files = [f.bytes(70_000, 1), f.bytes(1_000, 2)];
    const uploaded = [];
    for (const [i, content] of files.entries())
      uploaded.push(
        await f.upload('alice', { parentId: room.rootNodeId, filename: `f${i}.bin`, content }),
      );
    // An upload that is still open when the move runs.
    const open = await f.dr.api.uploads.create(as('alice'), {
      tenantId: TENANT,
      parentId: room.rootNodeId,
      filename: 'late.bin',
      size: 10,
    });
    expect(eu.objects.size).toBe(2);

    const progress: number[] = [];
    const result = await moveRoom({
      database: f.database,
      storage,
      tenantId: TENANT,
      roomId: room.id,
      to: 'us',
      onProgress: ({ moved }) => progress.push(moved),
    });
    expect(result).toEqual({ from: 'eu', to: 'us', moved: 2, skipped: 0, pendingUploads: 1 });
    expect(progress).toEqual([1, 2]);
    expect(eu.objects.size).toBe(0);
    expect(us.objects.size).toBe(2);
    const stored = await f.database.findOne<Room>('rooms', { tenantId: TENANT, id: room.id });
    expect(stored?.region).toBe('us');
    for (const [i, { document }] of uploaded.entries()) {
      const ticket = await f.dr.api.documents.requestOriginal(as('alice'), {
        tenantId: TENANT,
        nodeId: document.id,
      });
      const body = (await f.download(ticket.url)).body;
      expect(Buffer.from(body).equals(Buffer.from(files[i]!))).toBe(true);
    }

    // The open upload finishes in the old region; a second run picks it up and skips the rest.
    await f.dr.files.upload(as('alice'), {
      tenantId: TENANT,
      uploadId: open.uploadId,
      body: f.bytes(10, 3),
    });
    await f.dr.api.uploads.complete(as('alice'), { tenantId: TENANT, uploadId: open.uploadId });
    expect(eu.objects.size).toBe(1);
    const again = await moveRoom({
      database: f.database,
      storage,
      tenantId: TENANT,
      roomId: room.id,
      to: 'us',
    });
    expect(again).toMatchObject({ moved: 1, skipped: 2, pendingUploads: 0 });
    expect(eu.objects.size).toBe(0);

    // New uploads go straight to the new region.
    await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'new.bin',
      content: f.bytes(5),
    });
    expect(eu.objects.size).toBe(0);
    const blobs = await f.database.findMany<BlobRecord>('blobs', {
      where: { tenantId: TENANT, roomId: room.id },
    });
    expect(blobs.every((blob) => blob.storageKey.startsWith('g/us/'))).toBe(true);
  });

  it('refuses to move to an unknown region', async () => {
    const { f, storage } = await setup();
    const room = await f.room();
    await expect(
      moveRoom({ database: f.database, storage, tenantId: TENANT, roomId: room.id, to: 'mars' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
