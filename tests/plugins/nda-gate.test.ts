import { describe, expect, it } from 'vitest';
import { ndaPlugin } from '@better-files/plugin-nda';
import { qaPlugin } from '@better-files/plugin-qa';
import { as, fixture, TENANT } from '../fixtures.js';

describe('NDA gate on room features', () => {
  it('keeps plugin room features (Q&A) closed until the NDA is accepted', async () => {
    const f = await fixture({ plugins: [ndaPlugin(), qaPlugin()] });
    const room = await f.room();
    const buyers = await f.dr.api.groups.create(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      name: 'Buyers',
      preset: 'view',
    });
    await f.dr.api.members.invite(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      email: 'bob@acme.test',
      groupIds: [buyers.id],
    });
    const question = await f.dr.api.qa.ask(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      subject: 'Working capital',
      text: 'What is the peg?',
    });
    await f.dr.api.qa.answer(as('alice'), {
      tenantId: TENANT,
      questionId: question.id,
      answer: 'The peg is 4.2m.',
    });
    await f.dr.api.qa.publish(as('alice'), {
      tenantId: TENANT,
      questionId: question.id,
      visibility: 'room',
    });
    expect(await f.dr.api.qa.list(as('bob'), { tenantId: TENANT, roomId: room.id })).toHaveLength(
      1,
    );

    await f.dr.api.nda.publish(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      title: 'Project NDA',
      text: 'Keep it secret.',
    });

    // Published answers are room content: not before the NDA.
    await expect(
      f.dr.api.qa.list(as('bob'), { tenantId: TENANT, roomId: room.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('Project NDA') });
    await expect(
      f.dr.api.qa.ask(as('bob'), { tenantId: TENANT, roomId: room.id, subject: 'x', text: 'y' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // The NDA itself, the room and its index stay reachable.
    expect(await f.dr.api.nda.get(as('bob'), { tenantId: TENANT, roomId: room.id })).toMatchObject({
      required: true,
    });
    await expect(
      f.dr.api.rooms.get(as('bob'), { tenantId: TENANT, roomId: room.id }),
    ).resolves.toBeDefined();
    // Administrators are exempt.
    expect(await f.dr.api.qa.list(as('alice'), { tenantId: TENANT, roomId: room.id })).toHaveLength(
      1,
    );

    await f.dr.api.nda.accept(as('bob'), { tenantId: TENANT, roomId: room.id, version: 1 });
    expect(await f.dr.api.qa.list(as('bob'), { tenantId: TENANT, roomId: room.id })).toHaveLength(
      1,
    );
  });
});
