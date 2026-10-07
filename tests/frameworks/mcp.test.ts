import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createBetterFilesMcpServer, mcpPlugin, type McpServerOptions } from '@better-files/mcp';
import { searchPlugin } from '@better-files/plugin-search';
import { qaPlugin } from '@better-files/plugin-qa';
import { as, fixture, TENANT } from '../fixtures.js';

type TextResult = { content: { type: string; text: string }[]; isError?: boolean };

async function connect(
  dr: Parameters<typeof createBetterFilesMcpServer>[0],
  options: Omit<McpServerOptions, 'tenantId'>,
) {
  const server = await createBetterFilesMcpServer(dr, { tenantId: TENANT, ...options });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as TextResult;
    return { text: result.content.map((c) => c.text).join(''), isError: result.isError ?? false };
  };
  return { client, tool };
}

async function setup(options: { reader?: boolean } = {}) {
  const f = await fixture({
    plugins: [
      searchPlugin({ indexContent: true }),
      qaPlugin(),
      ...(options.reader === false ? [] : [mcpPlugin()]),
    ],
  });
  const room = await f.room();
  const legal = await f.dr.api.folders.create(as('alice'), {
    tenantId: TENANT,
    parentId: room.rootNodeId,
    name: 'Legal',
  });
  const hr = await f.dr.api.folders.create(as('alice'), {
    tenantId: TENANT,
    parentId: room.rootNodeId,
    name: 'HR',
  });
  const { document } = await f.upload('alice', {
    parentId: legal.id,
    filename: 'terms.md',
    content: new TextEncoder().encode(
      `# Terms\n\nThe purchase price is 40 million.\n${'x'.repeat(120)}`,
    ),
    mimeType: 'text/markdown',
  });
  await f.upload('alice', {
    parentId: hr.id,
    filename: 'payroll.csv',
    content: new TextEncoder().encode('name,salary\nceo,1'),
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
  return { f, room, legal, hr, document };
}

describe('MCP server', () => {
  it('offers read-only tools for installed plugins, acting as the caller', async () => {
    const { f, room, document } = await setup();
    const { client, tool } = await connect(f.dr, { credential: as('bob'), maxChars: 50 });

    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('search');
    expect(names).toContain('list_questions');
    expect(names).not.toContain('ask_room');
    expect(names).not.toContain('create_folder');
    const listRooms = (await client.listTools()).tools.find((t) => t.name === 'list_rooms')!;
    expect(listRooms.annotations).toMatchObject({ readOnlyHint: true });

    expect(JSON.parse((await tool('list_rooms')).text)).toEqual([
      expect.objectContaining({ id: room.id, name: 'Project Falcon' }),
    ]);

    const index = (await tool('get_room_index', { roomId: room.id })).text;
    expect(index).toContain('terms.md');
    expect(index).not.toContain('payroll');

    const page = (await tool('read_document', { documentId: document.id })).text;
    expect(page).toMatch(
      /^<document name="terms.md" chars="0-50 of \d+" nextOffset="50">\n# Terms\n\nThe purchase price is 40 million/,
    );
    const rest = (await tool('read_document', { documentId: document.id, offset: 50 })).text;
    expect(rest).toContain('chars="50-100');

    const hits = JSON.parse(
      (await tool('search', { roomId: room.id, query: 'purchase price' })).text,
    );
    expect(hits).toEqual([expect.objectContaining({ name: 'terms.md' })]);
    expect((await tool('search', { roomId: room.id, query: 'salary' })).text).toBe(
      'Nothing matched.',
    );

    // Reads show up in the room's activity, attributed to the caller.
    const activity = await f.dr.api.activity.list(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      nodeId: document.id,
    });
    expect(activity.some((r) => r.action === 'document.viewed' && r.actorId === 'bob')).toBe(true);

    // Refusals come back as tool errors the model can read.
    const denied = await tool('list_activity', { roomId: room.id });
    expect(denied).toEqual({ text: expect.stringMatching(/^FORBIDDEN: /), isError: true });
    const missing = await tool('read_document', { documentId: 'nod_missing' });
    expect(missing.isError).toBe(true);
  });

  it('adds write tools when enabled and takes the credential from the transport', async () => {
    const { f, room, legal } = await setup();
    const { client, tool } = await connect(f.dr, {
      write: true,
      credential: (request) => ({ token: request.authInfo?.token ?? 'alice' }),
    });
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['create_folder', 'upload_text_document', 'ask_question']),
    );

    const folder = JSON.parse(
      (await tool('create_folder', { parentId: legal.id, name: 'Drafts' })).text,
    );
    const created = JSON.parse(
      (
        await tool('upload_text_document', {
          parentId: folder.id,
          filename: 'memo.md',
          content: '# Memo\nClosing is on Friday.',
        })
      ).text,
    );
    expect(created.document.name).toBe('memo.md');
    const read = (await tool('read_document', { documentId: created.document.id })).text;
    expect(read).toContain('Closing is on Friday.');

    const version = JSON.parse(
      (
        await tool('upload_text_document', {
          documentId: created.document.id,
          filename: 'memo.md',
          content: '# Memo\nClosing moved to Monday.',
        })
      ).text,
    );
    expect(version.version.number).toBe(2);
    expect((await tool('upload_text_document', { filename: 'x.md', content: 'x' })).text).toMatch(
      /^INVALID_INPUT/,
    );

    const question = JSON.parse(
      (
        await tool('ask_question', {
          roomId: room.id,
          subject: 'Closing',
          text: 'When is closing?',
        })
      ).text,
    );
    expect(question.status).toBe('open');
  });

  it('explains how to enable reading when no reader is installed', async () => {
    const { f, document } = await setup({ reader: false });
    const { tool } = await connect(f.dr, { credential: as('bob') });
    expect(await tool('read_document', { documentId: document.id })).toEqual({
      text: expect.stringMatching(/^UNSUPPORTED: .*mcpPlugin/),
      isError: true,
    });
  });

  it('reads only what the caller may view through the plugin endpoint too', async () => {
    const { f, hr } = await setup();
    const payroll = (
      await f.dr.api.rooms.index(as('alice'), { tenantId: TENANT, roomId: hr.roomId })
    ).find((n) => n.name === 'payroll.csv')!;
    await expect(
      f.dr.api.mcp.readText(as('bob'), { tenantId: TENANT, nodeId: payroll.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const text = await f.dr.api.mcp.readText(as('alice'), { tenantId: TENANT, nodeId: payroll.id });
    expect(text).toMatchObject({ readable: true, text: 'name,salary\nceo,1', totalChars: 17 });
  });
});
