import { describe, expect, it } from 'vitest';
import { tasksPlugin } from '@better-files/plugin-tasks';
import { templatesPlugin } from '@better-files/plugin-templates';
import { as, fixture, TENANT } from '../fixtures.js';

describe('room duplication', () => {
  it('copies folders, groups, folder access, settings and checklists, but no documents or people', async () => {
    const f = await fixture({ plugins: [templatesPlugin(), tasksPlugin()] });
    const room = await f.room('Deal 1');
    const legal = await f.dr.api.folders.create(as('alice'), {
      tenantId: TENANT,
      parentId: room.rootNodeId,
      name: 'Legal',
    });
    await f.dr.api.folders.create(as('alice'), {
      tenantId: TENANT,
      parentId: legal.id,
      name: 'Contracts',
    });
    await f.dr.api.folders.create(as('alice'), {
      tenantId: TENANT,
      parentId: room.rootNodeId,
      name: 'Finance',
    });
    await f.upload('alice', { parentId: legal.id, filename: 'spa.pdf', content: f.bytes(10) });
    const buyers = await f.dr.api.groups.create(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      name: 'Buyers',
      kind: 'external',
      preset: 'download',
    });
    await f.dr.api.permissions.setEntries(as('alice'), {
      tenantId: TENANT,
      nodeId: legal.id,
      entries: [{ subject: { type: 'group', id: buyers.id }, preset: 'view', locked: true }],
    });
    await f.dr.api.members.invite(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      email: 'bob@acme.test',
      groupIds: [buyers.id],
    });
    await f.dr.api.rooms.update(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      settings: { downloadsEnabled: false },
    });
    await f.dr.api.tasks.create(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      checklist: 'Closing',
      title: 'Signed SPA',
    });

    const template = await f.dr.api.templates.capture(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      save: true,
    });
    expect(template.folders).toEqual([
      {
        name: 'Legal',
        children: [{ name: 'Contracts' }],
        access: [{ group: 'Buyers', preset: 'view', locked: true }],
      },
      { name: 'Finance' },
    ]);
    expect(template.groups).toEqual([
      { name: 'Buyers', kind: 'external', relation: 'viewer', preset: 'download' },
    ]);
    expect(template.checklists).toEqual([{ name: 'Closing', tasks: [{ title: 'Signed SPA' }] }]);
    expect(
      (await f.dr.api.templates.list(as('alice'), { tenantId: TENANT })).map((t) => t.name),
    ).toContain('Deal 1 (template)');

    const copy = await f.dr.api.templates.duplicateRoom(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      name: 'Deal 2',
    });
    expect(copy).toMatchObject({ folders: 3, groups: 1, access: 1, tasks: 1 });
    const index = await f.dr.api.rooms.index(as('alice'), {
      tenantId: TENANT,
      roomId: copy.room.id,
    });
    expect(index.map((node) => `${node.index} ${node.name}`)).toEqual([
      '1 Legal',
      '1.1 Contracts',
      '2 Finance',
    ]);
    const second = await f.dr.api.rooms.get(as('alice'), {
      tenantId: TENANT,
      roomId: copy.room.id,
    });
    expect(second.settings).toMatchObject({ downloadsEnabled: false });
    const [group] = await f.dr.api.groups.list(as('alice'), {
      tenantId: TENANT,
      roomId: copy.room.id,
    });
    expect(group).toMatchObject({ name: 'Buyers' });
    const legalCopy = index.find((node) => node.name === 'Legal')!;
    const matrix = await f.dr.api.permissions.getMatrix(as('alice'), {
      tenantId: TENANT,
      nodeId: legalCopy.id,
    });
    expect(matrix.entries.find((entry) => entry.nodeId === legalCopy.id)).toMatchObject({
      locked: true,
      capabilities: ['LIST', 'VIEW'],
    });
    const members = await f.dr.api.members.list(as('alice'), {
      tenantId: TENANT,
      roomId: copy.room.id,
    });
    expect(members.some((member) => member.email === 'bob@acme.test')).toBe(false);
  });
});
