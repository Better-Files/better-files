import { describe, expect, it } from 'vitest';
import { reviewsPlugin } from '@better-files/plugin-reviews';
import { as, fixture, TENANT } from '../fixtures.js';

const DAY = 86_400_000;

async function reviewRoom(options: Parameters<typeof reviewsPlugin>[0] = {}) {
  const f = await fixture({ plugins: [reviewsPlugin(options)] });
  const room = await f.room();
  const buyers = await f.dr.api.groups.create(as('alice'), {
    tenantId: TENANT,
    roomId: room.id,
    name: 'Buyer A',
    kind: 'external',
    preset: 'view',
  });
  for (const email of ['bob@acme.test', 'carol@acme.test'])
    await f.dr.api.members.invite(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      email,
      groupIds: [buyers.id],
    });
  // Carol is an auditor of the room as well, so she may read reviews.
  await f.dr.api.members.invite(as('alice'), {
    tenantId: TENANT,
    roomId: room.id,
    email: 'carol@acme.test',
    relation: 'auditor',
  });
  // Someone from outside who never accepted.
  await f.dr.api.members.invite(as('alice'), {
    tenantId: TENANT,
    roomId: room.id,
    email: 'zed@partner.test',
    groupIds: [buyers.id],
  });
  const { document } = await f.upload('alice', {
    parentId: room.rootNodeId,
    filename: 'teaser.pdf',
    content: f.bytes(100),
  });
  await f.dr.api.permissions.setEntries(as('alice'), {
    tenantId: TENANT,
    nodeId: document.id,
    entries: [{ subject: { type: 'group', id: buyers.id }, preset: 'downloadOriginal' }],
  });
  /** Activity by `who` in the room's log: a download. */
  const use = async (who: string) => {
    const ticket = await f.dr.api.documents.requestOriginal(as(who), {
      tenantId: TENANT,
      nodeId: document.id,
    });
    await f.download(ticket.url);
  };
  return { f, room, buyers, use };
}

describe('access reviews', () => {
  it('snapshots the roster with recommendations, refuses self-review and revokes on completion', async () => {
    const { f, room, use } = await reviewRoom({ inactiveDays: 30 });
    // Bob keeps using the room; everyone else goes quiet for two months.
    f.clock.current += 60 * DAY;
    await use('bob');

    const started = await f.dr.api.reviews.start(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      name: 'Q3 review',
      dueAt: f.clock.current + 14 * DAY,
    });
    const byEmail = Object.fromEntries(started.items.map((item) => [item.email, item]));
    expect(Object.keys(byEmail).sort()).toEqual([
      'alice@acme.test',
      'bob@acme.test',
      'carol@acme.test',
      'zed@partner.test',
    ]);
    expect(byEmail['alice@acme.test']).toMatchObject({ recommendation: 'keep', reason: 'owner' });
    expect(byEmail['zed@partner.test']).toMatchObject({
      recommendation: 'revoke',
      reason: 'invitation-pending',
      memberStatus: 'invited',
    });
    expect(byEmail['carol@acme.test']).toMatchObject({
      recommendation: 'revoke',
      reason: 'inactive',
      relation: 'auditor',
    });
    expect(started.progress).toEqual({ total: 4, pending: 4, keep: 0, revoke: 0 });

    // One open review per room.
    await expect(
      f.dr.api.reviews.start(as('alice'), { tenantId: TENANT, roomId: room.id }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // Viewers cannot see reviews; auditors can read but not decide.
    await expect(
      f.dr.api.reviews.get(as('bob'), { tenantId: TENANT, reviewId: started.review.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      f.dr.api.reviews.get(as('carol'), { tenantId: TENANT, reviewId: started.review.id }),
    ).resolves.toMatchObject({ review: { name: 'Q3 review' } });
    await expect(
      f.dr.api.reviews.decide(as('carol'), {
        tenantId: TENANT,
        reviewId: started.review.id,
        decisions: [{ itemId: byEmail['bob@acme.test']!.id, decision: 'revoke' }],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Nobody decides on their own access.
    await expect(
      f.dr.api.reviews.decide(as('alice'), {
        tenantId: TENANT,
        reviewId: started.review.id,
        decisions: [{ itemId: byEmail['alice@acme.test']!.id, decision: 'keep' }],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Completing with people undecided is refused unless the review revokes them.
    await expect(
      f.dr.api.reviews.complete(as('alice'), { tenantId: TENANT, reviewId: started.review.id }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const accepted = await f.dr.api.reviews.acceptRecommendations(as('alice'), {
      tenantId: TENANT,
      reviewId: started.review.id,
    });
    expect(accepted).toMatchObject({ decided: 3, progress: { pending: 1, keep: 1, revoke: 2 } });
    // Alice's own entry stays for someone else: hand her room to a second owner first.
    await expect(
      f.dr.api.reviews.complete(as('alice'), { tenantId: TENANT, reviewId: started.review.id }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await f.dr.api.reviews.decide(as('alice'), {
      tenantId: TENANT,
      reviewId: started.review.id,
      decisions: [
        { itemId: byEmail['carol@acme.test']!.id, decision: 'keep', note: 'Counsel until closing' },
      ],
    });
    // Alice's entry is decided by an administrator who is not Alice: Bob is promoted for the purpose.
    await f.dr.api.members.setRole(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      memberId: (
        await f.dr.api.members.list(as('alice'), { tenantId: TENANT, roomId: room.id })
      ).find((m) => m.identityId === 'bob')!.id,
      relation: 'admin',
    });
    await f.dr.api.reviews.decide(as('bob'), {
      tenantId: TENANT,
      reviewId: started.review.id,
      decisions: [{ itemId: byEmail['alice@acme.test']!.id, decision: 'keep' }],
    });

    const completed = await f.dr.api.reviews.complete(as('alice'), {
      tenantId: TENANT,
      reviewId: started.review.id,
    });
    expect(completed.summary).toEqual({ kept: 3, revoked: 1, gone: 0, failed: 0, flagged: 0 });
    const members = await f.dr.api.members.list(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      includeRemoved: true,
    });
    expect(members.find((m) => m.email === 'zed@partner.test')?.status).toBe('removed');
    expect(members.find((m) => m.email === 'carol@acme.test')?.status).toBe('active');

    const final = await f.dr.api.reviews.get(as('alice'), {
      tenantId: TENANT,
      reviewId: started.review.id,
    });
    expect(final.review).toMatchObject({ status: 'completed', completedBy: 'alice' });
    expect(final.items.find((i) => i.email === 'zed@partner.test')).toMatchObject({
      decision: 'revoke',
      outcome: 'revoked',
    });
    const activity = await f.dr.api.activity.list(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      limit: 20,
    });
    expect(activity.map((a) => a.action)).toEqual(
      expect.arrayContaining(['review.started', 'review.completed', 'member.removed']),
    );
    // A new review may start once the last one is closed.
    await expect(
      f.dr.api.reviews.start(as('alice'), { tenantId: TENANT, roomId: room.id, scope: 'guests' }),
    ).resolves.toMatchObject({ review: { scope: 'guests' } });
  });

  it('revokes undecided people when asked to, and scopes reviews to inactive people', async () => {
    const { f, room, use } = await reviewRoom({ inactiveDays: 30 });
    f.clock.current += 45 * DAY;
    await use('bob');
    const started = await f.dr.api.reviews.start(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      scope: 'inactive',
      revokeUndecided: true,
    });
    // Bob is active and alice owns the room: only carol and the pending invitation are under review.
    expect(started.items.map((i) => i.email).sort()).toEqual([
      'carol@acme.test',
      'zed@partner.test',
    ]);
    const completed = await f.dr.api.reviews.complete(as('alice'), {
      tenantId: TENANT,
      reviewId: started.review.id,
    });
    expect(completed.summary).toEqual({ kept: 0, revoked: 2, gone: 0, failed: 0, flagged: 0 });
    expect((await f.dr.api.rooms.list(as('carol'), { tenantId: TENANT })).map((r) => r.id)).toEqual(
      [],
    );
  });

  it('starts scheduled reviews from maintain and reports overdue ones', async () => {
    const { f, room } = await reviewRoom({ schedule: { everyDays: 90, dueInDays: 7 } });
    await f.dr.api.rooms.publish(as('alice'), { tenantId: TENANT, roomId: room.id });
    const events: { type: string; data: Record<string, unknown> }[] = [];
    f.dr.events.subscribe('review.*', (event) => void events.push(event));

    await f.dr.maintain();
    const [scheduled] = await f.dr.api.reviews.list(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
    });
    expect(scheduled).toMatchObject({ origin: 'schedule', status: 'open', startedBy: 'system' });
    expect(events.find((e) => e.type === 'review.started')?.data).toMatchObject({
      reviewId: scheduled!.id,
      origin: 'schedule',
    });

    // Running again does not start another; a week later the open one is overdue, reported once.
    await f.dr.maintain();
    f.clock.current += 8 * DAY;
    await f.dr.maintain();
    await f.dr.maintain();
    expect(events.filter((e) => e.type === 'review.started')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'review.overdue')).toHaveLength(1);
    expect(events.find((e) => e.type === 'review.overdue')?.data).toMatchObject({ pending: 4 });

    // After cancelling it, the next one waits for the cadence.
    await f.dr.api.reviews.cancel(as('alice'), { tenantId: TENANT, reviewId: scheduled!.id });
    await f.dr.maintain();
    expect(events.filter((e) => e.type === 'review.started')).toHaveLength(1);
    f.clock.current += 91 * DAY;
    await f.dr.maintain();
    expect(events.filter((e) => e.type === 'review.started')).toHaveLength(2);
  });

  it('lists access granted outside the roster and flags revoked entries for the identity system', async () => {
    const lookups: { tenantId: string; roomId: string }[] = [];
    const { f, room, use } = await reviewRoom({
      inactiveDays: 30,
      iamAccess: async (query) => {
        lookups.push(query);
        // alice and bob are on the roster; dave and mallory reach the room through tenant policies.
        return [
          { identityId: 'alice', reason: 'owner' },
          { identityId: 'bob', reason: 'participant role' },
          {
            identityId: 'dave',
            name: 'Dave Outsider',
            email: 'dave@acme.test',
            reason: 'Deal desk role',
          },
          { identityId: 'erin', email: 'erin@acme.test', reason: 'tenant administrator' },
        ];
      },
    });
    f.clock.current += 40 * DAY;
    await use('bob');
    const events: { type: string; data: Record<string, unknown> }[] = [];
    f.dr.events.subscribe('review.*', (event) => void events.push(event));
    const started = await f.dr.api.reviews.start(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
    });
    expect(lookups).toEqual([{ tenantId: TENANT, roomId: room.id }]);
    const outside = started.items.filter((item) => item.source === 'iam');
    expect(outside.map((item) => item.identityId).sort()).toEqual(['dave', 'erin']);
    expect(outside.find((item) => item.identityId === 'dave')).toMatchObject({
      reason: 'outside-roster',
      access: 'Deal desk role',
      recommendation: 'revoke',
      memberStatus: 'not-a-member',
    });

    const itemOf = (id: string) => started.items.find((item) => item.identityId === id)!.id;
    await f.dr.api.reviews.decide(as('alice'), {
      tenantId: TENANT,
      reviewId: started.review.id,
      decisions: [
        { itemId: itemOf('dave'), decision: 'revoke' },
        { itemId: itemOf('erin'), decision: 'keep', note: 'Tenant administrator' },
        { itemId: itemOf('bob'), decision: 'keep' },
        { itemId: itemOf('carol'), decision: 'keep' },
        {
          itemId: started.items.find((item) => item.email === 'zed@partner.test')!.id,
          decision: 'revoke',
        },
      ],
    });
    // Alice cannot decide on her own entry: carol becomes a room administrator and decides it.
    const members = await f.dr.api.members.list(as('alice'), { tenantId: TENANT, roomId: room.id });
    await f.dr.api.members.setRole(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      memberId: members.find((m) => m.identityId === 'carol')!.id,
      relation: 'admin',
    });
    await f.dr.api.reviews.decide(as('carol'), {
      tenantId: TENANT,
      reviewId: started.review.id,
      decisions: [{ itemId: itemOf('alice'), decision: 'keep' }],
    });
    const completed = await f.dr.api.reviews.complete(as('alice'), {
      tenantId: TENANT,
      reviewId: started.review.id,
    });
    expect(completed.summary).toEqual({ kept: 4, revoked: 1, gone: 0, failed: 0, flagged: 1 });
    expect(completed.flagged).toEqual([
      { identityId: 'dave', email: 'dave@acme.test', access: 'Deal desk role' },
    ]);
    expect(events.find((e) => e.type === 'review.iam-access-flagged')?.data).toMatchObject({
      identities: [{ identityId: 'dave' }],
    });
  });
});
