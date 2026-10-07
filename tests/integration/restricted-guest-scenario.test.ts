import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { extractText } from 'unpdf';
import { ndaPlugin } from '@better-files/plugin-nda';
import { networkPlugin } from '@better-files/plugin-network';
import { watermarkPlugin } from '@better-files/plugin-watermark';
import { viewerPlugin } from '@better-files/viewer/server';
import { as, fixture, TENANT } from '../fixtures.js';

/**
 * The Phase 3 exit scenario from PLAN.md §18: a guest in a restricted room sees nothing from outside the allowed
 * network, only the index until they accept the NDA, then watermarked viewer pages; downloads need a second factor
 * and are stamped for them, and originals stay out of reach.
 */

async function pdf(pages: number) {
  const document = await PDFDocument.create();
  for (let i = 1; i <= pages; i++)
    document.addPage([400, 600]).drawText(`Page ${i}`, { x: 50, y: 500, size: 32 });
  return new Uint8Array(await document.save());
}

const OFFICE = { ip: '203.0.113.40' };
const ELSEWHERE = { ip: '192.0.2.10' };

const webp = (bytes: Uint8Array) =>
  new TextDecoder().decode(bytes.subarray(0, 4)) === 'RIFF' &&
  new TextDecoder().decode(bytes.subarray(8, 12)) === 'WEBP';

describe('restricted guest scenario', () => {
  it('gates a guest by network, NDA and MFA, and serves only watermarked content', async () => {
    const f = await fixture({
      plugins: [ndaPlugin(), networkPlugin(), watermarkPlugin(), viewerPlugin({ batch: 2 })],
    });
    // Bob is a guest from the buyer's firm; Dave is an employee of the seller.
    f.principals.bob = { ...f.principals.bob!, guest: true };
    const viewer = f.dr.api as unknown as {
      viewer: {
        open(
          c: unknown,
          i: object,
          r?: object,
        ): Promise<{ supported: boolean; tickets: { page: number; url: string }[] }>;
      };
    };
    const code = (promise: Promise<unknown>) =>
      promise.then(
        () => 'resolved',
        (error: { code?: string }) => error.code ?? String(error),
      );

    // --- The seller restricts the room.
    const room = await f.room('Project Heron');
    await f.dr.api.rooms.update(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      settings: { requireMfaForDownload: true },
    });
    const { document } = await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'cim.pdf',
      content: await pdf(3),
      mimeType: 'application/pdf',
    });
    const bidders = await f.dr.api.groups.create(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      name: 'Bidders',
      preset: 'download',
    });
    for (const email of ['bob@acme.test', 'dave@acme.test'])
      await f.dr.api.members.invite(as('alice'), {
        tenantId: TENANT,
        roomId: room.id,
        email,
        groupIds: [bidders.id],
      });
    await f.dr.api.nda.publish(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      title: 'Heron NDA',
      text: 'Everything in this room is confidential.',
      appliesTo: 'external',
    });
    await f.dr.api.network.set(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      allowedRanges: ['203.0.113.0/24'],
      appliesTo: 'external',
    });
    await f.dr.api.rooms.publish(as('alice'), { tenantId: TENANT, roomId: room.id });
    const list = (who: string, request: { ip: string }) =>
      f.dr.api.folders.list(as(who), { tenantId: TENANT, nodeId: room.rootNodeId }, request).then(
        (result) => result.items.map((item) => item.name),
        (error: { code: string }) => error.code,
      );
    const open = (request: { ip: string }) =>
      viewer.viewer.open(as('bob'), { tenantId: TENANT, nodeId: document.id }, request);

    // --- Outside the allowed network the guest gets nothing, whatever else they have done.
    expect(await list('bob', ELSEWHERE)).toBe('NOT_FOUND');
    expect(await code(open(ELSEWHERE))).toBe('NOT_FOUND');
    expect(
      await f.dr.api.network.status(as('bob'), { tenantId: TENANT, roomId: room.id }, ELSEWHERE),
    ).toMatchObject({ restricted: true, allowed: false });
    // The seller's employee is bound by neither rule.
    expect(await list('dave', ELSEWHERE)).toEqual(['cim.pdf']);

    // --- From the office: the index, but no content until the NDA is accepted.
    expect(await list('bob', OFFICE)).toEqual(['cim.pdf']);
    expect(await code(open(OFFICE))).toBe('FORBIDDEN');
    expect(
      await f.dr.api.nda.get(as('bob'), { tenantId: TENANT, roomId: room.id }, OFFICE),
    ).toMatchObject({ required: true, nda: { version: 1 } });
    const accepted = await f.dr.api.nda.accept(
      as('bob'),
      { tenantId: TENANT, roomId: room.id, version: 1 },
      OFFICE,
    );
    expect(accepted).toMatchObject({ identityId: 'bob', ip: OFFICE.ip });

    // --- Watermarked viewer pages, still only from the office.
    const opened = await open(OFFICE);
    expect(opened.supported).toBe(true);
    const page = await f.download(opened.tickets[0]!.url);
    expect(page.response.headers.get('content-type')).toBe('image/webp');
    expect(webp(page.body)).toBe(true);
    expect(await code(open(ELSEWHERE))).toBe('NOT_FOUND');

    // --- Downloads need a second factor, the folder ZIP included; originals are never available.
    const download = () =>
      f.dr.api.documents.requestDownload(
        as('bob'),
        { tenantId: TENANT, nodeId: document.id },
        OFFICE,
      );
    expect(await code(download())).toBe('MFA_REQUIRED');
    expect(
      await code(
        f.dr.api.folders.requestDownload(
          as('bob'),
          { tenantId: TENANT, nodeId: room.rootNodeId, variant: 'original' },
          OFFICE,
        ),
      ),
    ).toBe('MFA_REQUIRED');
    f.principals.bob = { ...f.principals.bob!, mfa: true };
    const ticket = await download();
    const { body } = await f.download(ticket.url);
    const { text } = await extractText(body, { mergePages: true });
    // Stamped for this download: the address it went to and a forensic code on every page.
    expect(text).toContain(OFFICE.ip);
    expect(text.match(/DRFC:[0-9A-F]+/g)).toHaveLength(3);
    expect(
      await code(
        f.dr.api.documents.requestOriginal(
          as('bob'),
          { tenantId: TENANT, nodeId: document.id },
          OFFICE,
        ),
      ),
    ).toBe('FORBIDDEN');
    // A ZIP of originals leaves out everything Bob may not take.
    expect(
      await f.dr.api.folders.requestDownload(
        as('bob'),
        { tenantId: TENANT, nodeId: room.rootNodeId, variant: 'original' },
        OFFICE,
      ),
    ).toMatchObject({ files: 0, excluded: 1 });

    // --- The trail shows the rules, the acceptance and the reads, and it verifies.
    const actions = (
      await f.dr.api.activity.list(as('alice'), { tenantId: TENANT, roomId: room.id })
    ).map((record) => record.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'nda.published',
        'network.changed',
        'nda.accepted',
        'document.viewed',
      ]),
    );
    expect(
      await f.dr.api.activity.verify(as('alice'), { tenantId: TENANT, roomId: room.id }),
    ).toMatchObject({
      valid: true,
    });
  });
});
