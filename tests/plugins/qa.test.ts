import { describe, expect, it } from 'vitest';
import { qaPlugin } from '@better-files/plugin-qa';
import { as, fixture, TENANT } from '../fixtures.js';

describe('Q&A plugin', () => {
  it('runs the ask, assign, answer, publish flow with team visibility', async () => {
    const f = await fixture({ plugins: [qaPlugin({ maxOpenPerGroup: 2 })] });
    const room = await f.room();
    const { document } = await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'financials.xlsx',
      content: f.bytes(20),
    });
    const teamA = await f.dr.api.groups.create(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      name: 'Buyer A',
      preset: 'view',
    });
    const teamB = await f.dr.api.groups.create(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      name: 'Buyer B',
      preset: 'view',
    });
    await f.dr.api.members.invite(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      email: 'bob@acme.test',
      groupIds: [teamA.id],
    });
    await f.dr.api.members.invite(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      email: 'dave@acme.test',
      groupIds: [teamB.id],
    });
    const carol = await f.dr.api.members.invite(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      email: 'carol@acme.test',
    });
    await f.dr.api.members.setRole(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      memberId: carol.id,
      relation: 'editor',
    });

    const question = await f.dr.api.qa.ask(as('bob'), {
      tenantId: TENANT,
      roomId: room.id,
      subject: 'Revenue recognition',
      text: 'How is deferred revenue treated?',
      nodeId: document.id,
      priority: 'high',
    });
    expect(question).toMatchObject({ status: 'open', groupIds: [teamA.id], askedBy: 'bob' });

    // Team B cannot see team A's question; the manager sees everything.
    expect(await f.dr.api.qa.list(as('dave'), { tenantId: TENANT, roomId: room.id })).toEqual([]);
    expect(
      (await f.dr.api.qa.list(as('alice'), { tenantId: TENANT, roomId: room.id })).map((q) => q.id),
    ).toEqual([question.id]);

    await expect(
      f.dr.api.qa.assign(as('bob'), {
        tenantId: TENANT,
        questionId: question.id,
        assigneeId: 'carol',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await f.dr.api.qa.assign(as('alice'), {
      tenantId: TENANT,
      questionId: question.id,
      assigneeId: 'carol',
    });
    expect(
      (
        await f.dr.api.qa.list(as('carol'), {
          tenantId: TENANT,
          roomId: room.id,
          assignedToMe: true,
        })
      ).map((q) => q.id),
    ).toEqual([question.id]);

    await f.dr.api.qa.answer(as('carol'), {
      tenantId: TENANT,
      questionId: question.id,
      answer: 'Recognised over the service period.',
    });
    // Not yet published: the asking team sees the status but not the answer.
    const [pending] = await f.dr.api.qa.list(as('bob'), { tenantId: TENANT, roomId: room.id });
    expect(pending).toMatchObject({ status: 'answered' });
    expect(pending).not.toHaveProperty('answer');

    await f.dr.api.qa.publish(as('alice'), {
      tenantId: TENANT,
      questionId: question.id,
      visibility: 'room',
    });
    const [published] = await f.dr.api.qa.list(as('bob'), { tenantId: TENANT, roomId: room.id });
    expect(published).toMatchObject({
      status: 'published',
      answer: 'Recognised over the service period.',
      askedBy: 'bob',
    });
    // Published room-wide: team B sees it, without who asked.
    const [shared] = await f.dr.api.qa.list(as('dave'), { tenantId: TENANT, roomId: room.id });
    expect(shared).toMatchObject({
      subject: 'Revenue recognition',
      answer: 'Recognised over the service period.',
    });
    expect(shared).not.toHaveProperty('askedBy');
    expect(shared).not.toHaveProperty('groupIds');
  });

  it('limits open questions per team and refuses references to hidden documents', async () => {
    const f = await fixture({ plugins: [qaPlugin({ maxOpenPerGroup: 1 })] });
    const room = await f.room();
    const hidden = await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'secret.pdf',
      content: f.bytes(5),
    });
    const team = await f.dr.api.groups.create(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      name: 'Buyer A',
      preset: 'view',
    });
    await f.dr.api.permissions.setEntries(as('alice'), {
      tenantId: TENANT,
      nodeId: hidden.document.id,
      entries: [{ subject: { type: 'group', id: team.id }, preset: 'hidden' }],
    });
    await f.dr.api.members.invite(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      email: 'bob@acme.test',
      groupIds: [team.id],
    });
    await expect(
      f.dr.api.qa.ask(as('bob'), {
        tenantId: TENANT,
        roomId: room.id,
        subject: 'x',
        text: 'y',
        nodeId: hidden.document.id,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await f.dr.api.qa.ask(as('bob'), {
      tenantId: TENANT,
      roomId: room.id,
      subject: 'first',
      text: 'q',
    });
    await expect(
      f.dr.api.qa.ask(as('bob'), {
        tenantId: TENANT,
        roomId: room.id,
        subject: 'second',
        text: 'q',
      }),
    ).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
  });
});
