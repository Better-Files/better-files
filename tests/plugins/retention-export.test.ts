import { describe, expect, it } from 'vitest';
import { retentionPlugin } from '@better-files/plugin-retention';
import { as, fixture, TENANT } from '../fixtures.js';

/** Reads a stored (uncompressed) ZIP through its central directory. */
function unzip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.byteLength - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const files = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(offset, true)).toBe(0x02014b50);
    const size = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const local = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    const localName = view.getUint16(local + 26, true);
    const start = local + 30 + localName + view.getUint16(local + 28, true);
    files.set(name, bytes.subarray(start, start + size));
    offset += 46 + nameLength;
  }
  return files;
}

describe('legal holds', () => {
  it('blocks deleting held items, purging them from the trash and deleting the room', async () => {
    const f = await fixture({ plugins: [retentionPlugin()] });
    const room = await f.room();
    const legal = await f.dr.api.folders.create(as('alice'), {
      tenantId: TENANT,
      parentId: room.rootNodeId,
      name: 'Legal',
    });
    const other = await f.dr.api.folders.create(as('alice'), {
      tenantId: TENANT,
      parentId: room.rootNodeId,
      name: 'Other',
    });
    const contract = await f.upload('alice', {
      parentId: legal.id,
      filename: 'contract.pdf',
      content: f.bytes(10),
    });
    const scratch = await f.upload('alice', {
      parentId: other.id,
      filename: 'scratch.txt',
      content: f.bytes(10),
    });

    // Trash first, then place the hold: the purge must wait.
    await f.dr.api.documents.delete(as('alice'), { tenantId: TENANT, nodeId: scratch.document.id });
    const hold = await f.dr.api.retention.place(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      nodeId: legal.id,
      name: 'Smith v. Acme',
      reason: 'Litigation',
    });
    await expect(
      f.dr.api.documents.delete(as('alice'), { tenantId: TENANT, nodeId: contract.document.id }),
    ).rejects.toMatchObject({
      code: 'LEGAL_HOLD',
    });
    await expect(
      f.dr.api.folders.delete(as('alice'), { tenantId: TENANT, nodeId: legal.id }),
    ).rejects.toMatchObject({ code: 'LEGAL_HOLD' });
    await expect(
      f.dr.api.folders.delete(as('alice'), { tenantId: TENANT, nodeId: other.id }),
    ).resolves.toBeDefined();
    await expect(
      f.dr.api.retention.place(as('bob'), {
        tenantId: TENANT,
        roomId: room.id,
        name: 'x',
        reason: 'y',
      }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    const roomHold = await f.dr.api.retention.place(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      name: 'Regulator',
      reason: 'Inquiry',
    });
    await f.dr.api.rooms.archive(as('alice'), { tenantId: TENANT, roomId: room.id });
    await expect(
      f.dr.api.rooms.delete(as('alice'), {
        tenantId: TENANT,
        roomId: room.id,
        confirmName: 'Project Falcon',
      }),
    ).rejects.toMatchObject({ code: 'LEGAL_HOLD' });
    f.clock.current += 31 * 86_400_000;
    expect((await f.dr.maintain()).purged).toBe(0);

    await f.dr.api.retention.release(as('alice'), { tenantId: TENANT, holdId: roomHold.id });
    expect((await f.dr.maintain()).purged).toBe(2);
    await f.dr.api.retention.release(as('alice'), { tenantId: TENANT, holdId: hold.id });
    expect(
      await f.dr.api.retention.list(as('alice'), { tenantId: TENANT, roomId: room.id }),
    ).toEqual([]);
    await expect(
      f.dr.api.rooms.delete(as('alice'), {
        tenantId: TENANT,
        roomId: room.id,
        confirmName: 'Project Falcon',
      }),
    ).resolves.toEqual({ deleted: true });
  });
});

describe('room export', () => {
  it('exports what the caller may download, with an index, a manifest and the activity log', async () => {
    const f = await fixture();
    const room = await f.room();
    const finance = await f.dr.api.folders.create(as('alice'), {
      tenantId: TENANT,
      parentId: room.rootNodeId,
      name: 'Finance',
    });
    const model = f.bytes(70_000, 4);
    await f.upload('alice', { parentId: finance.id, filename: 'model.xlsx', content: model });
    await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'readme.txt',
      content: new TextEncoder().encode('hello'),
    });
    const result = await f.dr.api.rooms.export(as('alice'), { tenantId: TENANT, roomId: room.id });
    expect(result).toMatchObject({ files: 2, excluded: 0, bytes: 70_005 });
    const { response, body } = await f.download(result.url);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(response.headers.get('content-disposition')).toContain('project-falcon-export.zip');
    const files = unzip(body);
    expect([...files.keys()]).toEqual([
      'manifest.json',
      'index.csv',
      'documents/1 Finance/1.1 model.xlsx',
      'documents/2 readme.txt',
      'activity.jsonl',
    ]);
    expect(
      Buffer.from(files.get('documents/1 Finance/1.1 model.xlsx')!).equals(Buffer.from(model)),
    ).toBe(true);
    const manifest = JSON.parse(new TextDecoder().decode(files.get('manifest.json')));
    expect(manifest).toMatchObject({
      room: { name: 'Project Falcon' },
      activity: { valid: true },
      excluded: 0,
    });
    expect(manifest.files[0].sha256).toBe(f.sha256(model));
    const activity = new TextDecoder()
      .decode(files.get('activity.jsonl'))
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(activity[0]).toMatchObject({ sequence: 1, action: 'room.created' });

    // Viewers without download rights cannot export.
    await expect(
      f.dr.api.rooms.export(as('bob'), { tenantId: TENANT, roomId: room.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
