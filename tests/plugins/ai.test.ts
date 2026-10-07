import { describe, expect, it } from 'vitest';
import { aiPlugin, claudeProvider, type AiProvider, type AiSource } from '@better-files/plugin-ai';
import { searchPlugin } from '@better-files/plugin-search';
import { as, fixture, TENANT } from '../fixtures.js';

const text = (value: string) => new TextEncoder().encode(value);

function recordingProvider() {
  const seen: AiSource[][] = [];
  const provider: AiProvider = {
    async answer({ sources }) {
      seen.push([...sources]);
      return {
        text: `Answer from ${sources.length} documents`,
        citations: sources.map((source) => ({
          sourceId: source.id,
          quote: source.text.slice(0, 20),
        })),
        refused: false,
      };
    },
    async summarize({ source }) {
      return { text: `Summary of ${source.title}`, citations: [], refused: false };
    },
  };
  return { provider, seen };
}

describe('AI plugin', () => {
  it('answers only from documents the asker may view, with citations', async () => {
    const { provider, seen } = recordingProvider();
    const f = await fixture({
      plugins: [searchPlugin({ indexContent: true }), aiPlugin({ provider })],
    });
    const room = await f.room();
    const finance = await f.dr.api.folders.create(as('alice'), {
      tenantId: TENANT,
      parentId: room.rootNodeId,
      name: 'Finance',
    });
    const hr = await f.dr.api.folders.create(as('alice'), {
      tenantId: TENANT,
      parentId: room.rootNodeId,
      name: 'HR',
    });
    await f.upload('alice', {
      parentId: finance.id,
      filename: 'revenue.txt',
      content: text('Annual revenue grew to 12 million, driven by renewals.'),
    });
    await f.upload('alice', {
      parentId: hr.id,
      filename: 'salaries.txt',
      content: text('Executive revenue bonus pool: 2 million.'),
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

    const owner = await f.dr.api.ai.ask(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      question: 'What happened to revenue?',
    });
    expect(owner.sources.map((s) => s.name).sort()).toEqual(['revenue.txt', 'salaries.txt']);

    const buyer = await f.dr.api.ai.ask(as('bob'), {
      tenantId: TENANT,
      roomId: room.id,
      question: 'What happened to revenue?',
    });
    expect(buyer.sources.map((s) => s.name)).toEqual(['revenue.txt']);
    expect(seen.at(-1)!.map((s) => s.title)).toEqual(['revenue.txt']);
    expect(buyer.citations).toEqual([
      expect.objectContaining({ name: 'revenue.txt', quote: 'Annual revenue grew ' }),
    ]);

    const nothing = await f.dr.api.ai.ask(as('bob'), {
      tenantId: TENANT,
      roomId: room.id,
      question: 'bonus pool size?',
    });
    expect(nothing.sources).toEqual([]);
    expect(seen).toHaveLength(2);

    const summary = await f.dr.api.ai.summarize(as('bob'), {
      tenantId: TENANT,
      nodeId: buyer.sources[0]!.nodeId,
    });
    expect(summary.summary).toBe('Summary of revenue.txt');
  });

  it('requires the search plugin', async () => {
    await expect(
      fixture({ plugins: [aiPlugin({ provider: recordingProvider().provider })] }),
    ).rejects.toThrow(/needs plugin search/);
  });

  it('builds Claude requests with citations, fallbacks and cited passages mapped back to documents', async () => {
    let request: Record<string, unknown> | undefined;
    const fakeClient = {
      beta: {
        messages: {
          stream(params: Record<string, unknown>) {
            request = params;
            return {
              finalMessage: async () => ({
                model: 'claude-opus-5',
                stop_reason: 'end_turn',
                content: [
                  {
                    type: 'text',
                    text: 'Revenue grew to 12 million.',
                    citations: [
                      {
                        type: 'char_location',
                        document_index: 0,
                        cited_text: 'Annual revenue grew to 12 million',
                      },
                    ],
                  },
                ],
              }),
            };
          },
        },
      },
    };
    const provider = claudeProvider({ client: fakeClient as never });
    const answer = await provider.answer({
      question: 'Revenue?',
      sources: [{ id: 'nod_1', title: 'revenue.txt', text: 'Annual revenue grew to 12 million.' }],
    });
    expect(answer).toEqual({
      text: 'Revenue grew to 12 million.',
      citations: [{ sourceId: 'nod_1', quote: 'Annual revenue grew to 12 million' }],
      refused: false,
      model: 'claude-opus-5',
    });
    expect(request).toMatchObject({
      model: 'claude-opus-5',
      thinking: { type: 'adaptive' },
      fallbacks: 'default',
      betas: ['server-side-fallback-2026-07-01'],
    });
    const content = (request!.messages as { content: Record<string, unknown>[] }[])[0]!.content;
    expect(content[0]).toMatchObject({
      type: 'document',
      title: 'revenue.txt',
      citations: { enabled: true },
      cache_control: { type: 'ephemeral' },
    });
  });
});
