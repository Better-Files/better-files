import { describe, expect, it } from 'vitest';
import { as, fixture, TENANT } from '../fixtures.js';

describe('bulk invitations', () => {
  it('invites from a CSV and a list, reporting each row', async () => {
    const f = await fixture();
    const room = await f.room();
    await f.dr.api.groups.create(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      name: 'Buyers',
      preset: 'view',
    });
    await f.dr.api.groups.create(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      name: 'Advisors',
      preset: 'download',
    });
    const csv = [
      'email,groups,role,days',
      'bob@acme.test,Buyers,,30',
      'carol@acme.test,Buyers;Advisors,,',
      'not-an-email,Buyers,,',
      'dave@acme.test,Lawyers,,',
      'partner@external.test,Advisors,,14',
    ].join('\n');
    const result = await f.dr.api.members.inviteMany(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      csv,
      invitations: [{ email: 'mallory@acme.test', groups: ['Buyers'] }],
    });
    expect(result).toMatchObject({ invited: 4, failed: 2 });
    expect(result.results.map((row) => [row.email, row.ok, row.error?.code])).toEqual([
      ['mallory@acme.test', true, undefined],
      ['bob@acme.test', true, undefined],
      ['carol@acme.test', true, undefined],
      ['not-an-email', false, 'INVALID_INPUT'],
      ['dave@acme.test', false, 'INVALID_INPUT'],
      ['partner@external.test', true, undefined],
    ]);
    const members = await f.dr.api.members.list(as('alice'), { tenantId: TENANT, roomId: room.id });
    const carol = members.find((member) => member.email === 'carol@acme.test')!;
    expect(carol.groupIds).toHaveLength(2);
    expect(members.find((member) => member.email === 'partner@external.test')).toMatchObject({
      status: 'invited',
      guest: true,
    });

    // Rows run as the caller: someone without invite rights gets nothing done.
    await expect(
      f.dr.api.members.inviteMany(as('bob'), {
        tenantId: TENANT,
        roomId: room.id,
        csv: 'x@acme.test,Buyers',
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/FORBIDDEN|NOT_FOUND/) });
  });
});
