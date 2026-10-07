import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { esignPlugin, type Delivery } from '@better-files/plugin-esign';
import { as, fixture, TENANT } from '../fixtures.js';

async function contract() {
  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]).drawText('Share purchase agreement', { x: 50, y: 780, size: 20 });
  pdf.addPage([595, 842]).drawText('Signatures', { x: 50, y: 780, size: 16 });
  return new Uint8Array(await pdf.save());
}

async function setup() {
  const deliveries: Delivery[] = [];
  const f = await fixture({
    plugins: [esignPlugin({ deliver: async (d) => void deliveries.push(d) })],
  });
  const room = await f.room();
  const { document } = await f.upload('alice', {
    parentId: room.rootNodeId,
    filename: 'spa.pdf',
    content: await contract(),
    mimeType: 'application/pdf',
  });
  return { f, room, document, deliveries };
}

const tokenFor = (deliveries: Delivery[], email: string) =>
  [...deliveries].reverse().find((d) => d.recipient.email === email && d.token)?.token;

describe('e-signature plugin', () => {
  it('routes signatures in order and produces a signed PDF with a certificate of completion', async () => {
    const { f, room, document, deliveries } = await setup();
    const envelope = await f.dr.api.esign.create(as('alice'), {
      tenantId: TENANT,
      nodeId: document.id,
      title: 'SPA signature',
      routing: 'sequential',
      recipients: [
        { email: 'seller@target.test', name: 'Sam Seller' },
        { email: 'buyer@acquirer.test', name: 'Bea Buyer' },
        { email: 'counsel@law.test', name: 'Counsel', role: 'cc' },
      ],
      fields: [
        { recipient: 0, type: 'signature', page: 2, x: 50, y: 600, width: 200, height: 40 },
        { recipient: 0, type: 'date', page: 2, x: 300, y: 600, width: 120, height: 20 },
        { recipient: 1, type: 'signature', page: 2, x: 50, y: 500, width: 200, height: 40 },
        { recipient: 1, type: 'text', page: 2, x: 300, y: 500, width: 200, height: 20 },
      ],
    });
    expect(envelope).toMatchObject({
      status: 'draft',
      recipients: [{ order: 1 }, { order: 2 }, { role: 'cc' }],
    });
    await expect(
      f.dr.api.esign.create(as('alice'), {
        tenantId: TENANT,
        nodeId: document.id,
        recipients: [{ email: 'x@y.test', name: 'X' }],
        fields: [{ recipient: 0, type: 'signature', page: 3, x: 0, y: 0, width: 10, height: 10 }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    await f.dr.api.esign.send(as('alice'), { tenantId: TENANT, envelopeId: envelope.id });
    // Sequential: only the first signer is invited.
    expect(deliveries.map((d) => [d.kind, d.recipient.email])).toEqual([
      ['sign', 'seller@target.test'],
    ]);

    const sellerToken = tokenFor(deliveries, 'seller@target.test')!;
    const opened = await f.dr.api.esign.open({}, { tenantId: TENANT, token: sellerToken });
    expect(opened).toMatchObject({
      yourTurn: true,
      recipient: { role: 'signer', status: 'viewed' },
      envelope: { title: 'SPA signature' },
    });
    expect(opened.fields).toHaveLength(2);
    const doc = await f.download(opened.document.url);
    expect(Buffer.from(doc.body.subarray(0, 5)).toString()).toBe('%PDF-');

    expect(
      await f.dr.api.esign.sign(
        {},
        { tenantId: TENANT, token: sellerToken, signatureName: 'Sam Seller', consent: true },
      ),
    ).toEqual({ status: 'signed' });
    await expect(
      f.dr.api.esign.sign(
        {},
        { tenantId: TENANT, token: sellerToken, signatureName: 'Sam Seller', consent: true },
      ),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    const buyerToken = tokenFor(deliveries, 'buyer@acquirer.test')!;
    expect(buyerToken).toBeDefined();
    const buyerFields = (await f.dr.api.esign.open({}, { tenantId: TENANT, token: buyerToken }))
      .fields;
    const textField = buyerFields.find((field) => field.type === 'text')!;
    await expect(
      f.dr.api.esign.sign(
        {},
        { tenantId: TENANT, token: buyerToken, signatureName: 'Bea Buyer', consent: true },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const done = await f.dr.api.esign.sign(
      {},
      {
        tenantId: TENANT,
        token: buyerToken,
        signatureName: 'Bea Buyer',
        consent: true,
        values: { [textField.id]: 'Acquirer Holdings Ltd' },
      },
    );
    expect(done.status).toBe('completed');

    // Everyone hears about completion; the signed copy sits next to the original.
    expect(deliveries.filter((d) => d.kind === 'completed').map((d) => d.recipient.email)).toEqual([
      'seller@target.test',
      'buyer@acquirer.test',
      'counsel@law.test',
    ]);
    const index = await f.dr.api.rooms.index(as('alice'), { tenantId: TENANT, roomId: room.id });
    expect(index.map((n) => n.name)).toEqual(['spa.pdf', 'spa (signed).pdf']);
    const signedTicket = await f.dr.api.documents.requestOriginal(as('alice'), {
      tenantId: TENANT,
      nodeId: (done as { signedDocumentId: string }).signedDocumentId,
    });
    const signed = await PDFDocument.load((await f.download(signedTicket.url)).body);
    expect(signed.getPageCount()).toBe(3);

    const details = await f.dr.api.esign.get(as('alice'), {
      tenantId: TENANT,
      envelopeId: envelope.id,
    });
    expect(details.status).toBe('completed');
    expect(details.verification).toMatchObject({ valid: true });
    expect(details.events.map((e) => e.type)).toEqual([
      'envelope.created',
      'envelope.sent',
      'recipient.notified',
      'recipient.viewed',
      'recipient.signed',
      'recipient.notified',
      'recipient.viewed',
      'recipient.signed',
      'envelope.completed',
    ]);
    expect(details.recipients.every((r) => !('tokenHash' in r))).toBe(true);
  });

  it('handles declines and voids, and keeps outsiders out', async () => {
    const { f, document, deliveries } = await setup();
    const make = () =>
      f.dr.api.esign.create(as('alice'), {
        tenantId: TENANT,
        nodeId: document.id,
        recipients: [
          { email: 'a@x.test', name: 'A' },
          { email: 'b@x.test', name: 'B' },
        ],
        fields: [],
      });
    const first = await make();
    await f.dr.api.esign.send(as('alice'), { tenantId: TENANT, envelopeId: first.id });
    await f.dr.api.esign.decline(
      {},
      { tenantId: TENANT, token: tokenFor(deliveries, 'a@x.test')!, reason: 'Wrong entity name' },
    );
    expect(
      (await f.dr.api.esign.get(as('alice'), { tenantId: TENANT, envelopeId: first.id })).status,
    ).toBe('declined');
    await expect(
      f.dr.api.esign.open({}, { tenantId: TENANT, token: tokenFor(deliveries, 'b@x.test')! }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const second = await make();
    await f.dr.api.esign.send(as('alice'), { tenantId: TENANT, envelopeId: second.id });
    const token = tokenFor(deliveries, 'b@x.test')!;
    await f.dr.api.esign.void(as('alice'), {
      tenantId: TENANT,
      envelopeId: second.id,
      reason: 'Superseded',
    });
    await expect(f.dr.api.esign.open({}, { tenantId: TENANT, token })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    await expect(
      f.dr.api.esign.list(as('bob'), { tenantId: TENANT, roomId: first.roomId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      f.dr.api.esign.open({}, { tenantId: TENANT, token: 'not-a-real-token-at-all' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
