import { describe, expect, it } from 'vitest';
import { createMcpAuthorizer } from 'better-iam/mcp';
import { betterIamToolRules, mcpPlugin, sessionTenant } from '@better-files/mcp';
import { qaPlugin } from '@better-files/plugin-qa';
import { betterIamTenant } from '../integration/better-iam-tenant.js';

async function setup() {
  const plugins = [mcpPlugin(), qaPlugin()];
  const f = await betterIamTenant({ plugins });
  const room = await f.dr.api.rooms.create(f.owner, { tenantId: f.tenantId, name: 'Falcon' });
  const buyers = await f.dr.api.groups.create(f.owner, {
    tenantId: f.tenantId,
    roomId: room.id,
    name: 'Buyers',
    preset: 'view',
  });
  const dana = await f.member('dana');
  const erin = await f.member('erin');
  await f.dr.api.members.invite(f.owner, {
    tenantId: f.tenantId,
    roomId: room.id,
    email: 'dana@acme.test',
    groupIds: [buyers.id],
  });
  const rules = betterIamToolRules(f.dr, { tenantId: f.tenantId, write: true });
  const authorizer = createMcpAuthorizer({ iam: f.iam, tools: rules, tenantId: f.tenantId });
  const caller = async (token: string) =>
    (await authorizer.authenticate(
      new Request('http://localhost:3000/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      }),
    ))!;
  return { f, room, rules, authorizer, caller, dana, erin };
}

describe('Better Files MCP tools behind better-iam/mcp', () => {
  it('maps each tool to the Better Files action and resource Better Files authorizes', async () => {
    const { f, rules } = await setup();
    expect(rules.list_rooms).toMatchObject({
      action: 'better-files:rooms:read',
      resource: { type: 'iam', id: f.tenantId },
    });
    const resource = (name: string, args: Record<string, unknown>) =>
      (rules[name]!.resource as (a: Record<string, unknown>) => unknown)(args);
    expect(resource('get_room_index', { roomId: 'r1' })).toEqual({
      type: 'better-files-room',
      id: 'r1',
    });
    expect(resource('read_document', { documentId: 'd1' })).toEqual({
      type: 'better-files-document',
      id: 'd1',
    });
    expect(resource('upload_text_document', { parentId: 'f1' })).toEqual({
      type: 'better-files-folder',
      id: 'f1',
    });
    // read_document is checked as viewing (the MCP plugin's text endpoint, or the viewer ticket path).
    expect(rules.read_document!.action).toBe('better-files:documents:view');
    // Tools whose arguments do not name the resource are left to Better Files' own checks.
    expect(rules.explain_access).toEqual({ public: true });
    expect(rules.answer_question).toEqual({ public: true });
    // Tools whose plugin is missing are not offered at all.
    expect(rules.search).toBeUndefined();
  });

  it('lets Better IAM decide tool calls per caller, in line with the room roster', async () => {
    const { f, room, authorizer, caller, dana, erin } = await setup();
    const owner = await caller(f.owner.token);
    const member = await caller(dana.credential.token);
    const outsider = await caller(erin.credential.token);
    const index = { roomId: room.id };
    const upload = { parentId: room.rootNodeId, filename: 'notes.md', content: 'hi' };

    expect((await authorizer.canCall(owner, 'get_room_index', index)).allowed).toBe(true);
    expect((await authorizer.canCall(owner, 'upload_text_document', upload)).allowed).toBe(true);
    expect((await authorizer.canCall(member, 'get_room_index', index)).allowed).toBe(true);
    expect(await authorizer.canCall(member, 'upload_text_document', upload)).toMatchObject({
      allowed: false,
      reason: 'ACCESS_DENIED',
    });
    expect((await authorizer.canCall(outsider, 'get_room_index', index)).allowed).toBe(false);
    expect((await authorizer.canCall(outsider, 'explain_access', {})).reason).toBe('PUBLIC');
    // Tools on a fixed resource are listed by decision: someone in no room holds no Better Files role in Better IAM
    // (the participant role is bound only to people given a room role), so list_rooms is hidden from them. Tools on
    // a derived resource are listed for everyone and decided per call; unknown tools are hidden.
    const tools = [{ name: 'list_rooms' }, { name: 'get_room_index' }, { name: 'not_a_tool' }];
    expect((await authorizer.visibleTools(member, tools)).map((tool) => tool.name)).toEqual([
      'list_rooms',
      'get_room_index',
    ]);
    expect((await authorizer.visibleTools(outsider, tools)).map((tool) => tool.name)).toEqual([
      'get_room_index',
    ]);
  });

  it('takes the tenant from the caller session', async () => {
    const { f, dana } = await setup();
    await expect(sessionTenant(f.iam)(dana.credential)).resolves.toBe(f.tenantId);
  });
});
