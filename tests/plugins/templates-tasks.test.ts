import { describe, expect, it } from 'vitest';
import { tasksPlugin } from '@better-files/plugin-tasks';
import { templatesPlugin } from '@better-files/plugin-templates';
import { as, fixture, TENANT } from '../fixtures.js';

describe('templates and tasks', () => {
  it('creates a room from a built-in template with folders, groups, settings and checklists', async () => {
    const f = await fixture({ plugins: [templatesPlugin(), tasksPlugin()] });
    const templates = await f.dr.api.templates.list(as('alice'), { tenantId: TENANT });
    expect(templates.map((t) => t.id)).toContain('m-and-a-sell-side');

    const { room, folders, groups, tasks } = await f.dr.api.templates.createRoom(as('alice'), {
      tenantId: TENANT,
      templateId: 'm-and-a-sell-side',
      name: 'Project Orion',
    });
    expect({ folders, groups, tasks }).toEqual({ folders: 20, groups: 4, tasks: 4 });
    const index = await f.dr.api.rooms.index(as('alice'), { tenantId: TENANT, roomId: room.id });
    expect(index.slice(0, 4).map((n) => `${n.index} ${n.name}`)).toEqual([
      '1 Corporate',
      '1.1 Constitutional documents',
      '1.2 Board and shareholder minutes',
      '1.3 Group structure',
    ]);
    const roomGroups = await f.dr.api.groups.list(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
    });
    expect(roomGroups.map((g) => g.name)).toEqual([
      'Advisors',
      'Bidder A',
      'Bidder B',
      'Sell side',
    ]);
    const got = await f.dr.api.rooms.get(as('alice'), { tenantId: TENANT, roomId: room.id });
    expect(got.settings).toMatchObject({
      requireMfaForDownload: true,
      classification: 'confidential',
    });

    // Applying again is idempotent.
    expect(
      await f.dr.api.templates.apply(as('alice'), {
        tenantId: TENANT,
        roomId: room.id,
        templateId: 'm-and-a-sell-side',
      }),
    ).toEqual({
      folders: 0,
      groups: 0,
      tasks: 4,
      access: 0,
    });

    const list = await f.dr.api.tasks.list(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      checklist: 'Closing',
    });
    expect(list.progress).toEqual([{ checklist: 'Closing', total: 8, done: 0 }]);
  });

  it('saves tenant templates and refuses people without room administration', async () => {
    const f = await fixture({ plugins: [templatesPlugin()] });
    const saved = await f.dr.api.templates.save(as('alice'), {
      tenantId: TENANT,
      definition: {
        name: 'Vendor due diligence',
        folders: [{ name: 'Security', children: [{ name: 'Pen tests' }] }],
      },
    });
    expect(saved.id).toMatch(/^tpl_/);
    const room = await f.room();
    // Tasks plugin absent: checklists are skipped, the rest applies.
    expect(
      await f.dr.api.templates.apply(as('alice'), {
        tenantId: TENANT,
        roomId: room.id,
        templateId: saved.id,
      }),
    ).toEqual({
      folders: 2,
      groups: 0,
      tasks: 0,
      access: 0,
    });
    await expect(
      f.dr.api.templates.apply(as('bob'), {
        tenantId: TENANT,
        roomId: room.id,
        templateId: saved.id,
      }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      f.dr.api.templates.delete(as('alice'), { tenantId: TENANT, templateId: 'fundraising' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('tracks tasks with assignees, completion and overdue events', async () => {
    const f = await fixture({ plugins: [tasksPlugin()] });
    const overdue: unknown[] = [];
    f.dr.events.subscribe('task.overdue', (event) => void overdue.push(event.data));
    const room = await f.room();
    const carol = await f.dr.api.members.invite(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      email: 'carol@acme.test',
    });
    const task = await f.dr.api.tasks.create(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      title: 'Upload the lease',
      assigneeId: carol.identityId!,
      dueAt: f.clock.current + 86_400_000,
    });
    await expect(
      f.dr.api.tasks.create(as('carol'), { tenantId: TENANT, roomId: room.id, title: 'x' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(
      (await f.dr.api.tasks.list(as('carol'), { tenantId: TENANT, roomId: room.id, mine: true }))
        .tasks,
    ).toHaveLength(1);
    f.clock.current += 2 * 86_400_000;
    await f.dr.maintain();
    await f.dr.maintain();
    expect(overdue).toEqual([expect.objectContaining({ taskId: task.id, assigneeId: 'carol' })]);
    await f.dr.api.tasks.complete(as('carol'), { tenantId: TENANT, taskId: task.id });
    const done = await f.dr.api.tasks.list(as('alice'), { tenantId: TENANT, roomId: room.id });
    expect(done.tasks[0]).toMatchObject({ status: 'done', completedBy: 'carol' });
    await expect(
      f.dr.api.tasks.complete(as('carol'), { tenantId: TENANT, taskId: task.id }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
