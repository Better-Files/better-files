import { describe, expect, it } from 'vitest';
import { annotationsPlugin } from '@better-files/plugin-annotations';
import { as, fixture, TENANT } from '../fixtures.js';

async function setup() {
  const f = await fixture({ plugins: [annotationsPlugin()] });
  const room = await f.room();
  const { document } = await f.upload('alice', {
    parentId: room.rootNodeId,
    filename: 'spa.pdf',
    content: f.bytes(100),
  });
  const bidderA = await f.dr.api.groups.create(as('alice'), {
    tenantId: TENANT,
    roomId: room.id,
    name: 'Bidder A',
    preset: 'view',
  });
  const bidderB = await f.dr.api.groups.create(as('alice'), {
    tenantId: TENANT,
    roomId: room.id,
    name: 'Bidder B',
    preset: 'view',
  });
  await f.dr.api.members.invite(as('alice'), {
    tenantId: TENANT,
    roomId: room.id,
    email: 'bob@acme.test',
    groupIds: [bidderA.id],
  });
  await f.dr.api.members.invite(as('alice'), {
    tenantId: TENANT,
    roomId: room.id,
    email: 'carol@acme.test',
    groupIds: [bidderA.id],
  });
  await f.dr.api.members.invite(as('alice'), {
    tenantId: TENANT,
    roomId: room.id,
    email: 'dave@acme.test',
    groupIds: [bidderB.id],
  });
  const api = f.dr.api.annotations;
  const list = (who: string) => api.list(as(who), { tenantId: TENANT, nodeId: document.id });
  return { f, room, document, bidderA, api, list };
}

describe('annotations', () => {
  it('keeps private notes private, shares group notes within the group, and room notes with everyone', async () => {
    const { f, document, api, list } = await setup();
    await api.create(as('bob'), {
      tenantId: TENANT,
      nodeId: document.id,
      body: 'Check the MAC clause',
      page: 3,
      rect: { x: 0.1, y: 0.2, width: 0.5, height: 0.05 },
      quote: 'Material Adverse Change',
    });
    const shared = await api.create(as('bob'), {
      tenantId: TENANT,
      nodeId: document.id,
      body: 'Ask about earn-out',
      visibility: 'group',
    });
    await api.create(as('alice'), {
      tenantId: TENANT,
      nodeId: document.id,
      body: 'Schedules are in folder 4',
      visibility: 'room',
    });

    expect((await list('bob')).map((note) => note.body).sort()).toEqual([
      'Ask about earn-out',
      'Check the MAC clause',
      'Schedules are in folder 4',
    ]);
    // Carol is in Bidder A: she sees the group note, not Bob's private one.
    expect((await list('carol')).map((note) => note.body).sort()).toEqual([
      'Ask about earn-out',
      'Schedules are in folder 4',
    ]);
    // Dave is another bidder; Alice runs the room: neither sees Bidder A's notes or Bob's private note.
    expect((await list('dave')).map((note) => note.body)).toEqual(['Schedules are in folder 4']);
    expect((await list('alice')).map((note) => note.body)).toEqual(['Schedules are in folder 4']);

    // Replies inherit the thread's audience; resolving hides the thread unless asked for.
    const reply = await api.create(as('carol'), {
      tenantId: TENANT,
      nodeId: document.id,
      body: 'Added to Q&A list',
      parentId: shared.id,
    });
    expect(reply).toMatchObject({ visibility: 'group', parentId: shared.id });
    await api.update(as('carol'), { tenantId: TENANT, annotationId: shared.id, resolved: true });
    expect((await list('bob')).map((note) => note.body)).not.toContain('Added to Q&A list');
    const all = await api.list(as('bob'), {
      tenantId: TENANT,
      nodeId: document.id,
      includeResolved: true,
    });
    expect(all.map((note) => note.body)).toContain('Added to Q&A list');

    // Only the author edits; the activity log never holds the text.
    await expect(
      api.update(as('carol'), { tenantId: TENANT, annotationId: shared.id, body: 'x' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const activity = await f.dr.api.activity.list(as('alice'), {
      tenantId: TENANT,
      roomId: document.roomId,
    });
    const notes = activity.filter((record) => record.action === 'annotation.created');
    expect(notes).toHaveLength(4);
    expect(JSON.stringify(notes)).not.toContain('MAC clause');
  });

  it('checks who may share with a group or the room, and who may remove notes', async () => {
    const { document, bidderA, api } = await setup();
    await expect(
      api.create(as('dave'), {
        tenantId: TENANT,
        nodeId: document.id,
        body: 'x',
        visibility: 'group',
        groupId: bidderA.id,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      api.create(as('bob'), {
        tenantId: TENANT,
        nodeId: document.id,
        body: 'x',
        visibility: 'room',
      }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const secret = await api.create(as('bob'), {
      tenantId: TENANT,
      nodeId: document.id,
      body: 'mine',
    });
    await expect(
      api.delete(as('alice'), { tenantId: TENANT, annotationId: secret.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const shared = await api.create(as('bob'), {
      tenantId: TENANT,
      nodeId: document.id,
      body: 'ours',
      visibility: 'group',
    });
    await expect(
      api.delete(as('carol'), { tenantId: TENANT, annotationId: shared.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await api.delete(as('bob'), { tenantId: TENANT, annotationId: shared.id })).toEqual({
      deleted: true,
    });
  });
});
