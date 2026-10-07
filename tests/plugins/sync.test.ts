import { describe, expect, it } from 'vitest';
import { syncPlugin, type SyncChange } from '@better-files/plugin-sync';
import { as, fixture, TENANT } from '../fixtures.js';

const text = (value: string) => new TextEncoder().encode(value);

async function setup(pageSize?: number) {
  const f = await fixture({ plugins: [syncPlugin(pageSize ? { pageSize } : {})] });
  const room = await f.room();
  const team = await f.dr.api.groups.create(as('alice'), {
    tenantId: TENANT,
    roomId: room.id,
    name: 'Buyers',
    preset: 'view',
  });
  await f.dr.api.members.invite(as('alice'), {
    tenantId: TENANT,
    roomId: room.id,
    email: 'bob@acme.test',
    groupIds: [team.id],
  });
  const sync = (who: string) => ({
    snapshot: () => f.dr.api.sync.snapshot(as(who), { tenantId: TENANT, roomId: room.id }),
    changes: (cursor: string) =>
      f.dr.api.sync.changes(as(who), { tenantId: TENANT, roomId: room.id, cursor }),
  });
  return { f, room, team, sync };
}

const summary = (changes: SyncChange[]) =>
  changes.map((change) => (change.type === 'upsert' ? `+${change.entry.name}` : `-${change.id}`));

describe('sync plugin', () => {
  it('snapshots the visible tree in order and replays changes from a cursor', async () => {
    const { f, room, sync } = await setup();
    const legal = await f.dr.api.folders.create(as('alice'), {
      tenantId: TENANT,
      parentId: room.rootNodeId,
      name: 'Legal',
    });
    const nested = await f.dr.api.folders.create(as('alice'), {
      tenantId: TENANT,
      parentId: legal.id,
      name: 'Contracts',
    });
    const { document } = await f.upload('alice', {
      parentId: nested.id,
      filename: 'spa.txt',
      content: text('v1'),
    });

    const start = await sync('bob').snapshot();
    expect(start.entries.map((e) => [e.name, e.parentId])).toEqual([
      ['Legal', null],
      ['Contracts', legal.id],
      ['spa.txt', nested.id],
    ]);
    expect(start.entries[2]!.version).toMatchObject({
      number: 1,
      sha256: f.sha256(text('v1')),
      size: 2,
    });
    expect(await sync('bob').changes(start.cursor)).toEqual({
      reset: false,
      cursor: start.cursor,
      changes: [],
      hasMore: false,
    });

    // Views are not changes; content, renames and moves are.
    await f.dr.api.documents.requestOriginal(as('alice'), {
      tenantId: TENANT,
      nodeId: document.id,
    });
    await f.upload('alice', {
      documentId: document.id,
      filename: 'spa.txt',
      content: text('version two'),
    });
    await f.dr.api.folders.rename(as('alice'), {
      tenantId: TENANT,
      nodeId: legal.id,
      name: 'Legal & Tax',
    });
    const step = await sync('bob').changes(start.cursor);
    expect(summary(step.changes)).toEqual(['+Legal & Tax', '+spa.txt']);
    const updated = step.changes.find((c) => c.type === 'upsert' && c.entry.kind === 'document');
    expect(updated).toMatchObject({
      entry: { version: { number: 2, sha256: f.sha256(text('version two')) } },
    });

    // Deleting a folder removes its subtree.
    await f.dr.api.folders.delete(as('alice'), { tenantId: TENANT, nodeId: legal.id });
    const removed = await sync('bob').changes(step.cursor);
    expect(summary(removed.changes).sort()).toEqual(
      [`-${document.id}`, `-${legal.id}`, `-${nested.id}`].sort(),
    );

    // Restoring brings it back, parents first.
    await f.dr.api.folders.restore(as('alice'), { tenantId: TENANT, nodeId: legal.id });
    expect(summary((await sync('bob').changes(removed.cursor)).changes)).toEqual([
      '+Legal & Tax',
      '+Contracts',
      '+spa.txt',
    ]);
  });

  it('turns withdrawn access into removals and membership changes into resets', async () => {
    const { f, room, team, sync } = await setup();
    const hr = await f.dr.api.folders.create(as('alice'), {
      tenantId: TENANT,
      parentId: room.rootNodeId,
      name: 'HR',
    });
    const { document } = await f.upload('alice', {
      parentId: hr.id,
      filename: 'payroll.csv',
      content: text('a,b'),
    });
    const start = await sync('bob').snapshot();
    expect(start.entries.map((e) => e.name)).toEqual(['HR', 'payroll.csv']);

    await f.dr.api.permissions.setEntries(as('alice'), {
      tenantId: TENANT,
      nodeId: hr.id,
      entries: [{ subject: { type: 'group', id: team.id }, preset: 'hidden' }],
    });
    const hidden = await sync('bob').changes(start.cursor);
    expect(summary(hidden.changes).sort()).toEqual([`-${document.id}`, `-${hr.id}`].sort());
    // The owner still sees both.
    expect(summary((await sync('alice').changes(start.cursor)).changes)).toEqual([
      '+HR',
      '+payroll.csv',
    ]);

    await f.dr.api.groups.update(as('alice'), {
      tenantId: TENANT,
      groupId: team.id,
      name: 'Bidders',
    });
    const reset = await sync('bob').changes(hidden.cursor);
    expect(reset).toMatchObject({ reset: true, changes: [] });
    expect((await sync('bob').snapshot()).entries).toEqual([]);

    // A cursor from the future, or garbage, also resets.
    expect(await sync('bob').changes('999999')).toMatchObject({ reset: true });
    expect(await sync('bob').changes('abc')).toMatchObject({ reset: true });
  });

  it('pages through long histories and keeps outsiders out', async () => {
    const { f, room, sync } = await setup(2);
    const start = await sync('alice').snapshot();
    for (const name of ['A', 'B', 'C', 'D', 'E'])
      await f.dr.api.folders.create(as('alice'), {
        tenantId: TENANT,
        parentId: room.rootNodeId,
        name,
      });
    const seen: string[] = [];
    let cursor = start.cursor;
    for (let more = true; more; ) {
      const page = await sync('alice').changes(cursor);
      seen.push(...summary(page.changes));
      cursor = page.cursor;
      more = page.hasMore;
    }
    expect(seen).toEqual(['+A', '+B', '+C', '+D', '+E']);
    await expect(sync('dave').snapshot()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
