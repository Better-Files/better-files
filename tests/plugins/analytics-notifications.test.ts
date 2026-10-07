import { describe, expect, it } from 'vitest';
import { analyticsPlugin } from '@better-files/plugin-analytics';
import { notificationsPlugin, type Email } from '@better-files/plugin-notifications';
import { tasksPlugin } from '@better-files/plugin-tasks';
import { as, fixture, TENANT } from '../fixtures.js';

describe('analytics plugin', () => {
  it('reports engagement by person, team and document, and who has not opened a document', async () => {
    const f = await fixture({ plugins: [analyticsPlugin()] });
    const room = await f.room();
    const cim = await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'cim.pdf',
      content: f.bytes(10),
    });
    const model = await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'model.xlsx',
      content: f.bytes(10),
    });
    const bidders = await f.dr.api.groups.create(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      name: 'Bidder A',
      preset: 'downloadOriginal',
    });
    await f.dr.api.members.invite(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      email: 'bob@acme.test',
      groupIds: [bidders.id],
    });
    await f.dr.api.members.invite(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      email: 'dave@acme.test',
      groupIds: [bidders.id],
    });
    for (let i = 0; i < 3; i++)
      await f.dr.api.documents.requestView(as('bob'), {
        tenantId: TENANT,
        nodeId: cim.document.id,
      });
    await f.dr.api.documents.requestOriginal(as('bob'), {
      tenantId: TENANT,
      nodeId: model.document.id,
    });
    f.clock.current += 86_400_000;
    await f.dr.api.documents.requestView(as('dave'), { tenantId: TENANT, nodeId: cim.document.id });

    const report = await f.dr.api.analytics.engagement(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
    });
    expect(report.totals).toEqual({ views: 4, downloads: 1 });
    expect(report.people[0]).toMatchObject({
      identityId: 'bob',
      views: 3,
      downloads: 1,
      documents: 2,
      email: 'bob@acme.test',
    });
    expect(report.groups).toEqual([
      expect.objectContaining({ name: 'Bidder A', views: 4, downloads: 1 }),
    ]);
    expect(report.documents[0]).toMatchObject({ name: 'cim.pdf', views: 4, people: 2 });
    expect(report.series.map((day) => day.views)).toEqual([3, 1]);

    const unseen = await f.dr.api.analytics.unseen(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      nodeId: model.document.id,
    });
    expect(unseen.map((m) => m.identityId).sort()).toEqual(['alice', 'dave']);
    await expect(
      f.dr.api.analytics.engagement(as('bob'), { tenantId: TENANT, roomId: room.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('notifications plugin', () => {
  it('sends assignments at once and batches room activity into daily digests without document names', async () => {
    const sent: Email[] = [];
    const f = await fixture({
      plugins: [
        tasksPlugin(),
        notificationsPlugin({
          mailer: { send: async (email) => void sent.push(email) },
          roomUrl: ({ roomId }) => `https://app.test/rooms/${roomId}`,
        }),
      ],
    });
    const room = await f.room();
    const team = await f.dr.api.groups.create(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      name: 'Team',
      preset: 'view',
    });
    await f.dr.api.members.invite(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      email: 'bob@acme.test',
      groupIds: [team.id],
    });
    await f.dr.api.members.invite(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      email: 'carol@acme.test',
      groupIds: [team.id],
    });
    await f.dr.api.notifications.setPreference(as('carol'), {
      tenantId: TENANT,
      roomId: room.id,
      mode: 'off',
    });

    await f.dr.api.tasks.create(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      title: 'Sign the NDA',
      assigneeId: 'bob',
    });
    expect(sent).toEqual([
      expect.objectContaining({
        to: 'bob@acme.test',
        text: expect.stringContaining('A task was assigned to you: Sign the NDA'),
      }),
    ]);

    await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'secret-merger-plan.pdf',
      content: f.bytes(10),
    });
    await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'second.pdf',
      content: f.bytes(10),
    });
    expect(sent).toHaveLength(1);
    await f.dr.maintain();
    expect(sent).toHaveLength(2);
    const digest = sent[1]!;
    expect(digest.to).toBe('bob@acme.test');
    expect(digest.text).toContain('New documents were added');
    expect(digest.text).toContain('https://app.test/rooms/');
    expect(digest.text).not.toContain('secret-merger-plan');
    await f.dr.maintain();
    expect(sent).toHaveLength(2);
  });
});
