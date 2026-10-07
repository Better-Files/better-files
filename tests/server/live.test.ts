import { describe, expect, it } from 'vitest';
import { createBetterFilesClient, type RoomActivity } from '@better-files/client';
import { createBetterFilesSvelte, type QueryState } from '@better-files/svelte';
import { as, fixture, TENANT } from '../fixtures.js';

async function until(check: () => boolean, timeout = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function setup() {
  const f = await fixture();
  const room = await f.room();
  const finance = await f.dr.api.folders.create(as('alice'), {
    tenantId: TENANT,
    parentId: room.rootNodeId,
    name: 'Finance',
  });
  const hr = await f.dr.api.folders.create(as('alice'), {
    tenantId: TENANT,
    parentId: room.rootNodeId,
    name: 'HR',
  });
  const team = await f.dr.api.groups.create(as('alice'), {
    tenantId: TENANT,
    roomId: room.id,
    name: 'Buyers',
    preset: 'view',
  });
  await f.dr.api.permissions.setEntries(as('alice'), {
    tenantId: TENANT,
    nodeId: hr.id,
    entries: [{ subject: { type: 'group', id: team.id }, preset: 'hidden' }],
  });
  await f.dr.api.members.invite(as('alice'), {
    tenantId: TENANT,
    roomId: room.id,
    email: 'bob@acme.test',
    groupIds: [team.id],
  });
  const client = (who: string) =>
    createBetterFilesClient<typeof f.dr>({
      baseURL: 'http://app.test',
      tenantId: TENANT,
      headers: () => ({ authorization: `Bearer ${who}` }),
      fetch: (input, init) => f.dr.handler(new Request(input, init)),
    });
  return { f, room, finance, hr, client };
}

describe('live room activity', () => {
  it('streams what each person may see, and resumes after the last entry', async () => {
    const { f, room, finance, hr, client } = await setup();
    const owner: RoomActivity[] = [];
    const buyer: RoomActivity[] = [];
    const ownerStream = client('alice').subscribe(room.id, {
      after: 0,
      onActivity: (a) => void owner.push(a),
    });
    const buyerStream = client('bob').subscribe(room.id, {
      after: 0,
      onActivity: (a) => void buyer.push(a),
    });

    await f.upload('alice', {
      parentId: finance.id,
      filename: 'model.xlsx',
      content: f.bytes(100),
    });
    await f.upload('alice', { parentId: hr.id, filename: 'salaries.csv', content: f.bytes(50) });
    await until(() => owner.some((a) => a.metadata?.filename === 'salaries.csv'));
    await until(() => buyer.some((a) => a.metadata?.filename === 'model.xlsx'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The owner (activity access) sees everything, in order, with full metadata.
    expect(owner.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'room.created',
        'group.created',
        'member.invited',
        'document.uploaded',
      ]),
    );
    expect(owner.map((a) => a.sequence)).toEqual(
      [...owner.map((a) => a.sequence)].sort((x, y) => x - y),
    );
    expect(owner.find((a) => a.metadata?.filename === 'model.xlsx')!.metadata).toHaveProperty(
      'sha256',
    );
    // The buyer sees document changes in folders they can see, trimmed to names; nothing about people or HR.
    expect(
      buyer.map((a) => a.action).every((action) => /^(folder|document|version)\./.test(action)),
    ).toBe(true);
    expect(buyer.map((a) => a.metadata?.filename ?? a.metadata?.name)).toEqual([
      'Finance',
      'model.xlsx',
    ]);
    expect(buyer[1]!.metadata).not.toHaveProperty('sha256');
    ownerStream.close();
    buyerStream.close();

    // Resuming after an entry returns only what came later.
    const resumed: RoomActivity[] = [];
    const last = owner.at(-1)!.sequence;
    const again = client('alice').subscribe(room.id, {
      after: last,
      onActivity: (a) => void resumed.push(a),
    });
    await f.dr.api.folders.create(as('alice'), {
      tenantId: TENANT,
      parentId: room.rootNodeId,
      name: 'Legal',
    });
    await until(() => resumed.length === 1);
    expect(resumed[0]).toMatchObject({ action: 'folder.created', sequence: last + 1 });
    again.close();
  });

  it('refuses outsiders and untrusted origins', async () => {
    const { f, room, client } = await setup();
    let revoked = false;
    client('dave').subscribe(room.id, { onActivity() {}, onRevoked: () => (revoked = true) });
    await until(() => revoked);
    const crossSite = await f.dr.handler(
      new Request(`http://app.test/api/better-files/rooms/${room.id}/events?tenantId=${TENANT}`, {
        headers: { authorization: 'Bearer alice', origin: 'http://evil.test' },
      }),
    );
    expect(crossSite.status).toBe(403);
  });

  it('keeps UI stores live when others change the room', async () => {
    const { f, room, finance, client } = await setup();
    const rooms = createBetterFilesSvelte<typeof f.dr>(client('bob'));
    let index: QueryState<unknown[]> | undefined;
    const stopIndex = rooms
      .roomIndex(room.id)
      .subscribe((value) => (index = value as QueryState<unknown[]>));
    const stopLive = rooms.live(room.id).subscribe(() => undefined);
    await until(() => index?.data?.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Someone else uploads on the server: only the live stream can tell this client.
    await f.upload('alice', { parentId: finance.id, filename: 'new.pdf', content: f.bytes(10) });
    await until(() => index?.data?.length === 2);
    stopIndex();
    stopLive();
  });
});
