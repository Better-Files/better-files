import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { Hono } from 'hono';
import { createBetterFilesClient, BetterFilesClientError } from '@better-files/client';
import { createBetterFilesExpress } from '@better-files/middleware/express';
import { createBetterFilesHono } from '@better-files/middleware/hono';
import { createBetterFilesNext } from '@better-files/next';
import { qaPlugin } from '@better-files/plugin-qa';
import { fixture, TENANT } from '../fixtures.js';
import { unzip } from '../helpers.js';

/**
 * The Phase 4 exit scenario from PLAN.md §18: an M&A sell-side process with three bidder groups, Q&A, staged
 * publishing, closing and an archival export. Every call goes through the typed client and a framework's request
 * path, and the same scenario runs once per framework.
 */

type Fixture = Awaited<ReturnType<typeof makeFixture>>;
const makeFixture = () => fixture({ plugins: [qaPlugin()] });

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

/** Mounts the instance in a framework and returns the base URL and fetch the client should use. */
const frameworks: Record<
  string,
  (f: Fixture) => Promise<{ baseURL: string; fetch: typeof globalThis.fetch }>
> = {
  async express(f) {
    const app = express();
    const drExpress = createBetterFilesExpress(f.dr);
    app.use(express.json());
    app.use(drExpress.middleware);
    app.use(drExpress.errorHandler);
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      fetch: globalThis.fetch,
    };
  },
  async hono(f) {
    const drHono = createBetterFilesHono(f.dr);
    const app = new Hono();
    app.all('/api/better-files/*', (c) => drHono.handler(c as never));
    return {
      baseURL: 'http://deals.test',
      fetch: async (input, init) => app.fetch(new Request(input, init)),
    };
  },
  async next(f) {
    const handlers = createBetterFilesNext(f.dr).handlers();
    return {
      baseURL: 'http://deals.test',
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const route = handlers[request.method as keyof typeof handlers];
        if (!route) return new Response(null, { status: 405 });
        return route(request);
      },
    };
  },
};

describe.each(Object.keys(frameworks))('M&A sell-side scenario through %s', (name) => {
  it('runs bidder groups, Q&A, staged publishing, closing and an archival export', async () => {
    const f = await makeFixture();
    // Two more bidders, so each of the three bidder groups has someone in it (bob has a colleague).
    f.principals.erin = {
      id: 'erin',
      tenantId: TENANT,
      name: 'Erin Bidder',
      email: 'erin@bidc.test',
    };
    f.principals.frank = {
      id: 'frank',
      tenantId: TENANT,
      name: 'Frank Bidder',
      email: 'frank@bida.test',
    };
    const mount = await frameworks[name]!(f);
    const clientFor = (who: string) =>
      createBetterFilesClient<typeof f.dr>({
        baseURL: mount.baseURL,
        tenantId: TENANT,
        headers: () => ({ authorization: `Bearer ${who}` }),
        fetch: mount.fetch,
      });
    const seller = clientFor('alice');
    const counsel = clientFor('carol');
    const bidderA = clientFor('bob');
    const bidderA2 = clientFor('frank');
    const bidderB = clientFor('dave');
    const bidderC = clientFor('erin');
    const codeOf = (promise: Promise<unknown>) =>
      promise.then(
        () => 'resolved',
        (error: unknown) => (error instanceof BetterFilesClientError ? error.code : String(error)),
      );
    const names = async (client: typeof seller, nodeId: string) =>
      (await client.folders.list({ nodeId })).items.map((item) => item.name).sort();

    // --- Set-up: the seller builds the room while it is still a draft.
    const room = await seller.rooms.create({ name: 'Project Falcon' });
    expect(room.status).toBe('draft');
    const teaser = await seller.folders.create({ parentId: room.rootNodeId, name: 'Teaser' });
    const financials = await seller.folders.create({
      parentId: room.rootNodeId,
      name: 'Financials',
    });
    const legal = await seller.folders.create({ parentId: room.rootNodeId, name: 'Legal' });
    const files = {
      teaser: new TextEncoder().encode('Falcon: a profitable widget maker'),
      model: f.bytes(90_000, 7),
      contracts: f.bytes(4_000, 8),
    };
    await seller.upload({
      parentId: teaser.id,
      file: new Blob([files.teaser]),
      filename: 'teaser.pdf',
    });
    await seller.upload({
      parentId: financials.id,
      file: new Blob([files.model]),
      filename: 'model.xlsx',
    });
    const contracts = await seller.upload({
      parentId: legal.id,
      file: new Blob([files.contracts]),
      filename: 'material-contracts.pdf',
    });

    const groups = {
      a: await seller.groups.create({ roomId: room.id, name: 'Bidder A', preset: 'view' }),
      b: await seller.groups.create({ roomId: room.id, name: 'Bidder B', preset: 'view' }),
      c: await seller.groups.create({ roomId: room.id, name: 'Bidder C', preset: 'view' }),
    };
    // Phase 2 material stays hidden from every bidder until the seller releases it.
    await seller.permissions.setEntries({
      nodeId: legal.id,
      entries: Object.values(groups).map((group) => ({
        subject: { type: 'group' as const, id: group.id },
        preset: 'hidden',
      })),
    });
    for (const [email, group] of [
      ['bob@acme.test', groups.a],
      ['frank@bida.test', groups.a],
      ['dave@acme.test', groups.b],
      ['erin@bidc.test', groups.c],
    ] as const)
      await seller.members.invite({ roomId: room.id, email, groupIds: [group.id] });
    const carol = await seller.members.invite({ roomId: room.id, email: 'carol@acme.test' });
    await seller.members.setRole({ roomId: room.id, memberId: carol.id, relation: 'editor' });
    expect((await seller.rooms.publish({ roomId: room.id })).status).toBe('live');

    // --- Phase 1: every bidder sees the teaser and the financials, and nothing of Legal.
    for (const bidder of [bidderA, bidderB, bidderC])
      expect(await names(bidder, room.rootNodeId)).toEqual(['Financials', 'Teaser']);
    expect(await codeOf(bidderB.folders.list({ nodeId: legal.id }))).toBe('NOT_FOUND');
    expect(await codeOf(bidderB.documents.get({ nodeId: contracts.document.id }))).toBe(
      'NOT_FOUND',
    );
    // Viewers can read but neither download originals nor export the room.
    expect(await codeOf(bidderA.rooms.export({ roomId: room.id }))).toBe('FORBIDDEN');
    expect(await names(seller, room.rootNodeId)).toEqual(['Financials', 'Legal', 'Teaser']);

    // --- Q&A: questions stay inside the asking team until the seller publishes the answer.
    const question = await bidderA.qa.ask({
      roomId: room.id,
      subject: 'Working capital',
      text: 'What is the normalised working capital peg?',
    });
    expect(question).toMatchObject({ status: 'open', groupIds: [groups.a.id], askedBy: 'bob' });
    // Bob's colleague in the same team sees it; the other teams do not.
    expect((await bidderA2.qa.list({ roomId: room.id })).map((q) => q.id)).toEqual([question.id]);
    expect(await bidderB.qa.list({ roomId: room.id })).toEqual([]);
    expect(await bidderC.qa.list({ roomId: room.id })).toEqual([]);
    const privateQuestion = await bidderC.qa.ask({
      roomId: room.id,
      subject: 'Management',
      text: 'Will the CFO stay after closing?',
    });
    expect((await seller.qa.list({ roomId: room.id })).map((q) => q.id).sort()).toEqual(
      [question.id, privateQuestion.id].sort(),
    );
    expect(await codeOf(bidderA.qa.assign({ questionId: question.id, assigneeId: 'carol' }))).toBe(
      'FORBIDDEN',
    );
    await seller.qa.assign({ questionId: question.id, assigneeId: 'carol' });
    await counsel.qa.answer({ questionId: question.id, answer: 'The peg is 4.2m, see the model.' });
    const [unpublished] = await bidderA.qa.list({ roomId: room.id });
    expect(unpublished).toMatchObject({ status: 'answered' });
    expect(unpublished).not.toHaveProperty('answer');
    await seller.qa.publish({ questionId: question.id, visibility: 'room' });
    // Published room-wide: every team reads the answer, without learning who asked.
    const [shared] = await bidderB.qa.list({ roomId: room.id });
    expect(shared).toMatchObject({
      subject: 'Working capital',
      answer: 'The peg is 4.2m, see the model.',
    });
    expect(shared).not.toHaveProperty('askedBy');
    expect(shared).not.toHaveProperty('groupIds');
    // Team C's own question is still private to team C.
    expect((await bidderC.qa.list({ roomId: room.id })).map((q) => q.id).sort()).toEqual(
      [question.id, privateQuestion.id].sort(),
    );
    expect((await bidderB.qa.list({ roomId: room.id })).map((q) => q.id)).toEqual([question.id]);

    // --- Phase 2: the seller shortlists A and B and releases Legal to them only.
    await seller.permissions.setEntries({
      nodeId: legal.id,
      entries: [groups.a, groups.b].map((group) => ({
        subject: { type: 'group' as const, id: group.id },
        remove: true,
      })),
    });
    for (const bidder of [bidderA, bidderA2, bidderB])
      expect(await names(bidder, room.rootNodeId)).toEqual(['Financials', 'Legal', 'Teaser']);
    expect(await names(bidderA, legal.id)).toEqual(['material-contracts.pdf']);
    expect(await names(bidderC, room.rootNodeId)).toEqual(['Financials', 'Teaser']);
    expect(await codeOf(bidderC.folders.list({ nodeId: legal.id }))).toBe('NOT_FOUND');
    const caps = await bidderA.permissions.capabilities({
      roomId: room.id,
      nodeIds: [contracts.document.id],
    });
    expect(caps[contracts.document.id]).toContain('VIEW');
    expect(caps[contracts.document.id]).not.toContain('DOWNLOAD_ORIGINAL');

    // --- Closing: the room freezes, and nobody can change it any more.
    expect((await seller.rooms.close({ roomId: room.id })).status).toBe('closed');
    expect(
      await codeOf(seller.folders.create({ parentId: room.rootNodeId, name: 'Late addition' })),
    ).toBe('ROOM_CLOSED');
    // Bidders can still read what they were given.
    expect(await names(bidderB, legal.id)).toEqual(['material-contracts.pdf']);

    // --- Archival export: every document, an index, a manifest and a verifiable activity log.
    expect(await seller.activity.verify({ roomId: room.id })).toMatchObject({ valid: true });
    const exported = await seller.rooms.export({ roomId: room.id });
    expect(exported).toMatchObject({
      files: 3,
      excluded: 0,
      bytes: files.teaser.byteLength + files.model.byteLength + files.contracts.byteLength,
    });
    const download = await mount.fetch(seller.fileUrl(exported.url));
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('application/zip');
    const zip = unzip(new Uint8Array(await download.arrayBuffer()));
    const documents = [...zip.keys()].filter((key) => key.startsWith('documents/'));
    expect(
      documents
        .map((key) =>
          key
            .split('/')
            .at(-1)!
            .replace(/^[\d.]+ /, ''),
        )
        .sort(),
    ).toEqual(['material-contracts.pdf', 'model.xlsx', 'teaser.pdf']);
    const model = documents.find((key) => key.endsWith('model.xlsx'))!;
    expect(Buffer.from(zip.get(model)!).equals(Buffer.from(files.model))).toBe(true);
    const manifest = JSON.parse(new TextDecoder().decode(zip.get('manifest.json')));
    expect(manifest).toMatchObject({ room: { name: 'Project Falcon' }, activity: { valid: true } });
    const actions = new TextDecoder()
      .decode(zip.get('activity.jsonl'))
      .split('\n')
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { action: string }).action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'room.created',
        'room.published',
        'permissions.changed',
        'room.closed',
      ]),
    );

    // --- Archive: the room is kept read-only, and the record stays exportable.
    expect((await seller.rooms.archive({ roomId: room.id })).status).toBe('archived');
    expect(
      await codeOf(bidderA.qa.ask({ roomId: room.id, subject: 'Late', text: 'Too late?' })),
    ).toBe('ROOM_CLOSED');
    expect(await seller.activity.verify({ roomId: room.id })).toMatchObject({ valid: true });
    expect(await seller.rooms.export({ roomId: room.id })).toMatchObject({ files: 3, excluded: 0 });
  });
});
