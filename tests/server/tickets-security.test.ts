import { describe, expect, it } from 'vitest';
import { as, fixture, TENANT } from '../fixtures.js';

/** File tickets (PLAN §16 "Ticket replay"): short-lived, use-capped, signed, and never a way around the matrix. */
async function setup() {
  const f = await fixture();
  const room = await f.room();
  const content = f.bytes(1000, 7);
  const { document } = await f.upload('alice', {
    parentId: room.rootNodeId,
    filename: 'model.xlsx',
    content,
  });
  const original = () =>
    f.dr.api.documents.requestOriginal(as('alice'), { tenantId: TENANT, nodeId: document.id });
  return { f, room, document, content, original };
}

const tokenOf = (url: string) => url.split('/files/')[1]!;

describe('file tickets', () => {
  it('serves an original with headers that keep browsers from rendering or caching it', async () => {
    const { f, content, original } = await setup();
    const { response, body } = await f.download((await original()).url);
    expect(response.status).toBe(200);
    expect(body).toEqual(content);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'referrer-policy': 'no-referrer',
      'content-type': 'application/octet-stream',
    });
    expect(response.headers.get('content-disposition')).toMatch(/^attachment;/);
  });

  it('refuses tampered and made-up tokens without saying whether a ticket exists', async () => {
    const { f, original } = await setup();
    const token = tokenOf((await original()).url);
    const flipped = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    const forged = token.replace(/^[^.]+/, 'tkt_forged');
    for (const bad of [flipped, forged, '', 'x', `${token}x`, token.split('.')[0]!]) {
      const response = await f.dr.files.serve(bad, {});
      expect([bad, response.status]).toEqual([bad, 404]);
      expect(await response.json()).toEqual({
        error: { code: 'NOT_FOUND', message: 'Unknown or expired link' },
      });
    }
    // The genuine token still works: refusals do not burn it.
    expect((await f.dr.files.serve(token, {})).status).toBe(200);
  });

  it('expires after its time to live', async () => {
    const { f, original } = await setup();
    const ticket = await original();
    f.clock.current = ticket.expiresAt;
    expect((await f.download(ticket.url)).response.status).toBe(404);
  });

  it('stops working after its use cap, counting range requests', async () => {
    const { f, original } = await setup();
    const { url } = await original();
    for (let use = 1; use <= 5; use++)
      expect(
        (await f.download(url, use % 2 ? 'bytes=0-9' : undefined)).response.status,
      ).toBeLessThan(300);
    const sixth = await f.download(url);
    expect(sixth.response.status).toBe(410);
    expect(sixth.body.byteLength).toBeLessThan(200);
  });

  it('stops serving a document deleted after the ticket was issued', async () => {
    const { f, document, original } = await setup();
    const { url } = await original();
    await f.dr.api.documents.delete(as('alice'), { tenantId: TENANT, nodeId: document.id });
    const { response } = await f.download(url);
    expect(response.status).toBe(404);
  });

  it('never falls back to the original when no plugin makes the requested copy', async () => {
    const { f, document, content } = await setup();
    // A watermarked download with no watermark plugin installed.
    const ticket = await f.dr.api.documents.requestDownload(as('alice'), {
      tenantId: TENANT,
      nodeId: document.id,
    });
    const { response, body } = await f.download(ticket.url);
    expect(response.status).toBe(501);
    expect(body.byteLength).toBeLessThan(content.byteLength);
  });

  it('answers unsatisfiable ranges with 416 and suffix ranges with the tail', async () => {
    const { f, content, original } = await setup();
    const { url } = await original();
    expect((await f.download(url, 'bytes=5000-')).response.status).toBe(416);
    const tail = await f.download(url, 'bytes=-10');
    expect(tail.response.status).toBe(206);
    expect(tail.response.headers.get('content-range')).toBe('bytes 990-999/1000');
    expect(tail.body).toEqual(content.subarray(990));
  });
});
