import { describe, expect, it } from 'vitest';
import { meilisearchBackend, meilisearchId, searchPlugin } from '@better-files/plugin-search';
import { as, fixture, TENANT } from '../fixtures.js';

const text = (value: string) => new TextEncoder().encode(value);

type Doc = Record<string, unknown> & { id: string };

/**
 * Just enough of Meilisearch's HTTP API for the backend: indexes, settings, tasks, document writes (merged, as
 * PUT does), filter deletes and searches. Filters on attributes that are not yet filterable fail, as the real one does.
 */
function fakeMeilisearch(apiKey = 'master-key') {
  const indexes = new Map<string, { docs: Map<string, Doc>; filterable: string[] }>();
  const requests: { method: string; path: string; body?: unknown }[] = [];
  let taskUid = 0;
  const tasks = new Map<number, string>();
  const task = (status = 'succeeded') => {
    tasks.set(++taskUid, status);
    return Response.json({ taskUid }, { status: 202 });
  };
  const fail = (status: number, code: string, message: string) =>
    Response.json({ code, message }, { status });

  /** `a = "x" AND b = "y"`, as the backend writes them. */
  function matches(doc: Doc, filter: string, filterable: string[]): boolean | Response {
    for (const clause of filter.split(' AND ')) {
      const match = /^(\w+) = "((?:[^"\\]|\\.)*)"$/.exec(clause);
      if (!match) return fail(400, 'invalid_search_filter', `Bad filter ${clause}`);
      const [, attribute, raw] = match;
      if (!filterable.includes(attribute!))
        return fail(400, 'invalid_search_filter', `Attribute ${attribute} is not filterable`);
      if (doc[attribute!] !== raw!.replace(/\\(.)/g, '$1')) return false;
    }
    return true;
  }

  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, path: url.pathname, body });
    if (new Headers(init?.headers).get('authorization') !== `Bearer ${apiKey}`)
      return fail(401, 'invalid_api_key', 'The provided API key is invalid.');
    const parts = url.pathname.split('/').filter(Boolean);

    if (parts[0] === 'tasks') return Response.json({ status: tasks.get(Number(parts[1])) });
    if (parts[0] === 'indexes' && parts.length === 1 && method === 'POST') {
      if (indexes.has(body.uid)) return task('failed');
      indexes.set(body.uid, { docs: new Map(), filterable: [] });
      return task();
    }
    const index = indexes.get(decodeURIComponent(parts[1] ?? ''));
    if (!index) return fail(404, 'index_not_found', 'Index not found');
    const rest = parts.slice(2).join('/');
    if (rest === 'settings' && method === 'PATCH') {
      index.filterable = body.filterableAttributes;
      return task();
    }
    if (rest === 'documents' && method === 'PUT') {
      for (const doc of body as Doc[]) {
        if (!/^[A-Za-z0-9_-]{1,511}$/.test(doc.id)) return fail(400, 'invalid_document_id', doc.id);
        index.docs.set(doc.id, { ...index.docs.get(doc.id), ...doc });
      }
      return task();
    }
    if (rest === 'documents/delete' && method === 'POST') {
      for (const [id, doc] of index.docs) {
        const result = matches(doc, body.filter, index.filterable);
        if (result instanceof Response) return result;
        if (result) index.docs.delete(id);
      }
      return task();
    }
    if (rest === 'search' && method === 'POST') {
      const words = String(body.q).toLowerCase().split(/\s+/).filter(Boolean);
      const hits = [];
      for (const doc of index.docs.values()) {
        const result = matches(doc, body.filter, index.filterable);
        if (result instanceof Response) return result;
        if (!result) continue;
        const name = String(doc.name).toLowerCase();
        const content = String(doc.text ?? '');
        // Prefix matching on words, as Meilisearch does for the last word.
        const tokens = `${name} ${content.toLowerCase()}`.split(/[^\p{L}\p{N}]+/u);
        if (!words.every((word) => tokens.some((token) => token.startsWith(word)))) continue;
        const inName = words.filter((word) => name.includes(word)).length;
        const at = content.toLowerCase().indexOf(words[0]!);
        hits.push({
          nodeId: doc.nodeId,
          _rankingScore: 0.5 + inName / (2 * words.length),
          _formatted: at >= 0 ? { text: `…${content.slice(Math.max(0, at - 20), at + 40)}…` } : {},
        });
      }
      hits.sort((a, b) => b._rankingScore - a._rankingScore);
      return Response.json({ hits: hits.slice(0, body.limit) });
    }
    return fail(404, 'not_found', `${method} ${url.pathname}`);
  };
  return { fetch: fetch as typeof globalThis.fetch, indexes, requests };
}

async function setup() {
  const meili = fakeMeilisearch();
  const backend = meilisearchBackend({
    host: 'http://meili.test:7700/',
    apiKey: 'master-key',
    index: 'rooms',
    waitForWrites: true,
    fetch: meili.fetch,
  });
  const f = await fixture({ plugins: [searchPlugin({ indexContent: true, backend })] });
  const room = await f.room();
  const query = (who: string, q: string, kind?: 'folder' | 'document') =>
    f.dr.api.search.query(as(who), {
      tenantId: TENANT,
      roomId: room.id,
      q,
      ...(kind ? { kind } : {}),
    });
  return { f, room, meili, query };
}

describe('search plugin with Meilisearch', () => {
  it('indexes names and text in Meilisearch, never in the database, and filters by permission', async () => {
    const { f, room, meili, query } = await setup();
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
      filename: 'revenue-model.csv',
      mimeType: 'text/csv',
      content: text('quarter,revenue\nNote: deferred revenue recognised over the contract term.'),
    });
    await f.upload('alice', {
      parentId: hr.id,
      filename: 'bonuses.txt',
      content: text('Employee retention bonus schedule'),
    });

    // The index was created and configured before the first write, and the text lives only in Meilisearch.
    const index = meili.indexes.get('rooms')!;
    expect(index.filterable).toEqual(['tenantId', 'roomId', 'kind']);
    expect([...index.docs.values()].map((doc) => doc.name).sort()).toEqual([
      'Finance',
      'HR',
      'bonuses.txt',
      'revenue-model.csv',
    ]);
    expect(await f.database.count('searchEntries')).toBe(0);

    const results = await query('alice', 'revenue');
    expect(results.map((r) => r.name)).toEqual(['revenue-model.csv']);
    expect(results[0]!.snippet).toContain('deferred revenue');
    // Prefix matching comes from Meilisearch.
    expect((await query('alice', 'retent')).map((r) => r.name)).toEqual(['bonuses.txt']);
    expect((await query('alice', 'finance', 'folder')).map((r) => r.kind)).toEqual(['folder']);

    // Bob may list Finance only, and never gets snippets.
    const team = await f.dr.api.groups.create(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      name: 'Buyers',
      preset: 'hidden',
    });
    await f.dr.api.permissions.setEntries(as('alice'), {
      tenantId: TENANT,
      nodeId: room.rootNodeId,
      entries: [{ subject: { type: 'group', id: team.id }, capabilities: ['LIST'] }],
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
    expect(await query('bob', 'bonus')).toEqual([]);
    const limited = await query('bob', 'deferred');
    expect(limited).toEqual([expect.objectContaining({ name: 'revenue-model.csv' })]);
    expect(limited[0]).not.toHaveProperty('snippet');

    // Every request authenticated with the key, and searches always filter by tenant and room.
    const searches = meili.requests.filter((r) => r.path === '/indexes/rooms/search');
    expect(searches.length).toBeGreaterThan(0);
    for (const search of searches)
      expect((search.body as { filter: string }).filter).toMatch(
        new RegExp(`^tenantId = "${TENANT}" AND roomId = "${room.id}"`),
      );
  });

  it('keeps text across renames, hides trashed items and forgets deleted rooms', async () => {
    const { f, room, meili, query } = await setup();
    const doc = await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'draft.txt',
      content: text('secret merger codename falcon'),
    });
    await f.dr.api.documents.rename(as('alice'), {
      tenantId: TENANT,
      nodeId: doc.document.id,
      name: 'Final agreement.txt',
    });
    const stored = meili.indexes.get('rooms')!.docs.get(meilisearchId(TENANT, doc.document.id))!;
    expect(stored).toMatchObject({
      name: 'Final agreement.txt',
      text: 'secret merger codename falcon',
    });
    expect((await query('alice', 'codename')).map((r) => r.name)).toEqual(['Final agreement.txt']);

    // A stale index entry for a trashed document is filtered out by Better Files.
    await f.dr.api.documents.delete(as('alice'), { tenantId: TENANT, nodeId: doc.document.id });
    expect(await query('alice', 'codename')).toEqual([]);

    expect(
      await f.dr.api.search.reindex(as('alice'), { tenantId: TENANT, roomId: room.id }),
    ).toEqual({ indexed: 0 });

    const call = { tenantId: TENANT, roomId: room.id };
    await f.dr.api.rooms.publish(as('alice'), call);
    await f.dr.api.rooms.close(as('alice'), call);
    await f.dr.api.rooms.archive(as('alice'), call);
    await f.dr.api.rooms.delete(as('alice'), { ...call, confirmName: 'Project Falcon' });
    const deletes = meili.requests.filter((r) => r.path === '/indexes/rooms/documents/delete');
    expect(deletes.map((r) => r.body)).toEqual([
      { filter: `tenantId = "${TENANT}" AND roomId = "${room.id}"` },
    ]);
    expect(meili.indexes.get('rooms')!.docs.size).toBe(0);
  });

  it('escapes filter values and produces valid document ids for any id', async () => {
    const meili = fakeMeilisearch();
    const backend = meilisearchBackend({
      host: 'http://meili.test:7700',
      apiKey: 'master-key',
      waitForWrites: true,
      fetch: meili.fetch,
    });
    const odd = { tenantId: 'tenant "a"\\b', roomId: 'room/1', nodeId: 'node:ü+/=' };
    const db = (await fixture()).database;
    await backend.upsert(
      { ...odd, kind: 'document', name: 'Plan.pdf', text: 'alpha beta', updatedAt: 1 },
      { db },
    );
    expect(meilisearchId(odd.tenantId, odd.nodeId)).toMatch(/^[A-Za-z0-9_-]+$/);
    const hits = await backend.query(
      { tenantId: odd.tenantId, roomId: odd.roomId, q: 'alpha', words: ['alpha'], limit: 10 },
      { db },
    );
    expect(hits).toEqual([expect.objectContaining({ nodeId: odd.nodeId })]);
    // Another tenant with the same room id sees nothing.
    expect(
      await backend.query(
        { tenantId: 'other', roomId: odd.roomId, q: 'alpha', words: ['alpha'], limit: 10 },
        { db },
      ),
    ).toEqual([]);
    // The index is created once per process.
    expect(meili.requests.filter((r) => r.path === '/indexes').length).toBe(1);
  });

  it('reports Meilisearch errors and retries index setup after a failure', async () => {
    const meili = fakeMeilisearch('right-key');
    const backend = meilisearchBackend({
      host: 'http://meili.test:7700',
      apiKey: 'wrong-key',
      fetch: meili.fetch,
    });
    const db = (await fixture()).database;
    const query = { tenantId: 't', roomId: 'r', q: 'x', words: ['x'], limit: 1 };
    await expect(backend.query(query, { db })).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      message: expect.stringContaining('(401)'),
    });
    await expect(backend.query(query, { db })).rejects.toThrow('(401)');
    expect(meili.requests.filter((r) => r.path === '/indexes').length).toBe(2);
  });
});
