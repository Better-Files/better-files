import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  docusignProvider,
  dropboxSignProvider,
  esignPlugin,
  esignWebhook,
  type Delivery,
  type FetchLike,
} from '@better-files/plugin-esign';
import { as, fixture, TENANT } from '../fixtures.js';

async function pdf(pages: number, label: string) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++)
    doc.addPage([595, 842]).drawText(`${label} ${i + 1}`, { x: 50, y: 780 });
  return new Uint8Array(await doc.save());
}

const API_KEY = 'dropbox-sign-test-api-key';

/** A stand-in for Dropbox Sign's API v3: records what it is sent and answers from `state`. */
function fakeDropboxSign() {
  const calls: { method: string; path: string; form?: FormData }[] = [];
  const state = {
    signatures: [] as {
      signer_email_address: string;
      status_code: string;
      signed_at?: number;
      last_viewed_at?: number;
      decline_reason?: string;
    }[],
    complete: false,
    declined: false,
    canceled: false,
    signed: new Uint8Array(),
    statusReads: 0,
  };
  const fetcher: FetchLike = async (url, init) => {
    const { pathname } = new URL(url);
    const path = pathname.replace(/^\/v3/, '');
    const method = init?.method ?? 'GET';
    if (
      init?.headers &&
      new Headers(init.headers).get('authorization') !==
        `Basic ${Buffer.from(`${API_KEY}:`).toString('base64')}`
    )
      return new Response('{}', { status: 401 });
    calls.push({ method, path, ...(init?.body instanceof FormData ? { form: init.body } : {}) });
    if (method === 'POST' && path === '/signature_request/send')
      return Response.json({ signature_request: { signature_request_id: 'sr_0123456789abcdef' } });
    if (path === '/signature_request/sr_0123456789abcdef') {
      state.statusReads++;
      if (state.canceled) return new Response('{}', { status: 410 });
      return Response.json({
        signature_request: {
          signature_request_id: 'sr_0123456789abcdef',
          is_complete: state.complete,
          is_declined: state.declined,
          signatures: state.signatures,
        },
      });
    }
    if (path === '/signature_request/files/sr_0123456789abcdef')
      return new Response(state.signed, { headers: { 'content-type': 'application/pdf' } });
    if (
      path.startsWith('/signature_request/cancel/') ||
      path.startsWith('/signature_request/remind/')
    )
      return new Response(null, { status: 200 });
    return new Response('{}', { status: 404 });
  };
  return { fetcher, calls, state };
}

/** A Dropbox Sign callback, signed (or not) the way Dropbox Sign signs them. */
function callback(
  type: string,
  envelopeId: string,
  options: { key?: string; requestId?: string } = {},
) {
  const time = String(Math.floor(Date.now() / 1000));
  const form = new FormData();
  form.set(
    'json',
    JSON.stringify({
      event: {
        event_time: time,
        event_type: type,
        event_hash: createHmac('sha256', options.key ?? API_KEY)
          .update(`${time}${type}`)
          .digest('hex'),
      },
      signature_request: {
        signature_request_id: options.requestId ?? 'sr_0123456789abcdef',
        metadata: { better_files_tenant: TENANT, better_files_envelope: envelopeId },
      },
    }),
  );
  return new Request('https://app.example.test/api/esign/webhook', { method: 'POST', body: form });
}

async function setup() {
  const api = fakeDropboxSign();
  const provider = dropboxSignProvider({ apiKey: API_KEY, fetch: api.fetcher, testMode: true });
  const deliveries: Delivery[] = [];
  const f = await fixture({
    plugins: [esignPlugin({ provider, deliver: async (d) => void deliveries.push(d) })],
  });
  const room = await f.room();
  const { document } = await f.upload('alice', {
    parentId: room.rootNodeId,
    filename: 'spa.pdf',
    content: await pdf(2, 'Agreement'),
    mimeType: 'application/pdf',
  });
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
      { recipient: 1, type: 'text', page: 2, x: 300, y: 500, width: 200, height: 20 },
    ],
  });
  return { f, api, provider, room, document, envelope, deliveries };
}

describe('e-signature providers', () => {
  it('runs the ceremony at Dropbox Sign and brings the sealed PDF back through the webhook', async () => {
    const { f, api, provider, room, envelope, deliveries } = await setup();
    await f.dr.api.esign.send(as('alice'), { tenantId: TENANT, envelopeId: envelope.id });

    // The provider emails the recipients: no native signing links go out.
    expect(deliveries).toEqual([]);
    const form = api.calls.find((c) => c.path === '/signature_request/send')!.form!;
    expect(form.get('signers[0][email_address]')).toBe('seller@target.test');
    expect(form.get('signers[1][order]')).toBe('1');
    expect(form.get('cc_email_addresses[0]')).toBe('counsel@law.test');
    expect(form.get('metadata[better_files_envelope]')).toBe(envelope.id);
    expect(form.get('test_mode')).toBe('1');
    expect((form.get('files[0]') as File).name).toBe('spa.pdf');
    const [fields] = JSON.parse(String(form.get('form_fields_per_document'))) as {
      type: string;
      signer: number;
      y: number;
    }[][];
    // PDF space (bottom-left) becomes the provider's top-left space: 842 - 600 - 40.
    expect(fields).toMatchObject([
      { type: 'signature', signer: 0, y: 202 },
      { type: 'text', signer: 1, y: 322 },
    ]);
    const sent = await f.dr.api.esign.get(as('alice'), {
      tenantId: TENANT,
      envelopeId: envelope.id,
    });
    expect(sent).toMatchObject({
      status: 'sent',
      provider: 'dropbox-sign',
      externalId: 'sr_0123456789abcdef',
    });

    const webhook = esignWebhook(f.dr, provider);
    // Forged callbacks are refused before anything is read.
    const forged = await webhook(
      callback('signature_request_signed', envelope.id, { key: 'wrong' }),
    );
    expect(forged.status).toBe(401);
    expect(api.state.statusReads).toBe(0);

    // The seller signs at Dropbox Sign.
    const signedAt = Date.UTC(2026, 8, 25, 12, 5);
    api.state.signatures = [
      {
        signer_email_address: 'seller@target.test',
        status_code: 'signed',
        signed_at: signedAt / 1000,
      },
      { signer_email_address: 'buyer@acquirer.test', status_code: 'awaiting_signature' },
    ];
    const ok = await webhook(callback('signature_request_signed', envelope.id));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('Hello API Event Received');
    let details = await f.dr.api.esign.get(as('alice'), {
      tenantId: TENANT,
      envelopeId: envelope.id,
    });
    expect(details.recipients.map((r) => [r.email, r.status])).toEqual([
      ['seller@target.test', 'signed'],
      ['buyer@acquirer.test', 'sent'],
      ['counsel@law.test', 'sent'],
    ]);
    expect(details.recipients[0]!.signedAt).toBe(signedAt);

    // Anonymous syncs are throttled; the webhook (which knows the provider id) is not.
    const reads = api.state.statusReads;
    await f.dr.api.esign.sync({}, { tenantId: TENANT, envelopeId: envelope.id });
    expect(api.state.statusReads).toBe(reads);
    await expect(
      f.dr.api.esign.sync(
        {},
        { tenantId: TENANT, envelopeId: envelope.id, externalId: 'sr_guess' },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // Everyone has signed: a burst of callbacks completes the envelope exactly once.
    api.state.signatures[1] = {
      signer_email_address: 'buyer@acquirer.test',
      status_code: 'signed',
      signed_at: signedAt / 1000 + 60,
    };
    api.state.complete = true;
    api.state.signed = await pdf(3, 'Sealed');
    const burst = await Promise.all([
      webhook(callback('signature_request_signed', envelope.id)),
      webhook(callback('signature_request_all_signed', envelope.id)),
    ]);
    expect(burst.map((r) => r.status)).toEqual([200, 200]);
    details = await f.dr.api.esign.get(as('alice'), { tenantId: TENANT, envelopeId: envelope.id });
    expect(details.status).toBe('completed');
    expect(details.verification).toMatchObject({ valid: true });
    expect(details.events.map((e) => e.type)).toEqual([
      'envelope.created',
      'envelope.sent',
      'recipient.viewed',
      'recipient.signed',
      'recipient.viewed',
      'recipient.signed',
      'envelope.completed',
    ]);
    const index = await f.dr.api.rooms.index(as('alice'), { tenantId: TENANT, roomId: room.id });
    expect(index.map((n) => n.name)).toEqual(['spa.pdf', 'spa (signed).pdf']);
    const ticket = await f.dr.api.documents.requestOriginal(as('alice'), {
      tenantId: TENANT,
      nodeId: details.signedDocumentId!,
    });
    expect((await PDFDocument.load((await f.download(ticket.url)).body)).getPageCount()).toBe(3);
    expect(deliveries.map((d) => [d.kind, d.recipient.email])).toEqual([
      ['completed', 'seller@target.test'],
      ['completed', 'buyer@acquirer.test'],
      ['completed', 'counsel@law.test'],
    ]);
    expect(api.calls.filter((c) => c.path.startsWith('/signature_request/files/'))).toHaveLength(1);
  });

  it('voids and reminds at the provider, and picks up declines', async () => {
    const { f, api, envelope } = await setup();
    await f.dr.api.esign.send(as('alice'), { tenantId: TENANT, envelopeId: envelope.id });
    await f.dr.api.esign.remind(as('alice'), { tenantId: TENANT, envelopeId: envelope.id });
    const remind = api.calls.find((c) => c.path.startsWith('/signature_request/remind/'))!;
    expect(remind.form!.get('email_address')).toBe('seller@target.test');
    await f.dr.api.esign.void(as('alice'), {
      tenantId: TENANT,
      envelopeId: envelope.id,
      reason: 'Superseded',
    });
    expect(api.calls.some((c) => c.path === '/signature_request/cancel/sr_0123456789abcdef')).toBe(
      true,
    );
    expect(
      (await f.dr.api.esign.get(as('alice'), { tenantId: TENANT, envelopeId: envelope.id })).status,
    ).toBe('voided');

    const second = await setup();
    await second.f.dr.api.esign.send(as('alice'), {
      tenantId: TENANT,
      envelopeId: second.envelope.id,
    });
    second.api.state.declined = true;
    second.api.state.signatures = [
      {
        signer_email_address: 'seller@target.test',
        status_code: 'declined',
        decline_reason: 'Wrong entity name',
      },
    ];
    expect(
      await second.f.dr.api.esign.sync(
        {},
        { tenantId: TENANT, envelopeId: second.envelope.id, externalId: 'sr_0123456789abcdef' },
      ),
    ).toEqual({ status: 'declined' });
    const declined = await second.f.dr.api.esign.get(as('alice'), {
      tenantId: TENANT,
      envelopeId: second.envelope.id,
    });
    expect(declined.recipients[0]).toMatchObject({
      status: 'declined',
      declineReason: 'Wrong entity name',
    });
    expect(declined.events.at(-1)).toMatchObject({
      type: 'envelope.declined',
      actor: 'dropbox-sign',
    });
  });

  it('refuses a plugin with neither a mailer nor a provider', () => {
    expect(() => esignPlugin({})).toThrow(/deliver/);
  });
});

describe('DocuSign provider', () => {
  const key = 'docusign-connect-hmac-key';
  function fake() {
    const requests: { method: string; url: string; body?: unknown }[] = [];
    const fetcher: FetchLike = async (url, init) => {
      requests.push({
        method: init?.method ?? 'GET',
        url,
        ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}),
      });
      if (url.endsWith('/envelopes')) return Response.json({ envelopeId: 'ds-env-1' });
      if (url.includes('/envelopes/ds-env-1?include=recipients'))
        return Response.json({
          status: 'sent',
          recipients: {
            signers: [
              {
                email: 'Seller@Target.test',
                status: 'completed',
                signedDateTime: '2026-09-25T12:05:00Z',
              },
              {
                email: 'buyer@acquirer.test',
                status: 'delivered',
                deliveredDateTime: '2026-09-25T12:06:00Z',
              },
            ],
            carbonCopies: [{ email: 'counsel@law.test', status: 'created' }],
          },
        });
      return new Response('{}', { status: 404 });
    };
    const provider = docusignProvider({
      basePath: 'https://demo.docusign.net/restapi/',
      accountId: 'acct-1',
      accessToken: async () => 'access-token',
      connectKeys: [key],
      fetch: fetcher,
    });
    return { provider, requests };
  }

  it('creates envelopes with tabs in top-left coordinates and hidden Better Files ids', async () => {
    const { provider, requests } = fake();
    const { externalId } = await provider.send({
      tenantId: TENANT,
      envelopeId: 'env_1',
      title: 'SPA',
      routing: 'sequential',
      document: { name: 'spa.pdf', content: new Uint8Array([1, 2, 3]) },
      recipients: [
        { email: 'seller@target.test', name: 'Sam', role: 'signer', order: 1 },
        { email: 'cfo@target.test', name: 'Cee', role: 'approver', order: 2 },
        { email: 'counsel@law.test', name: 'Counsel', role: 'cc', order: 3 },
      ],
      fields: [
        {
          recipient: 0,
          type: 'signature',
          page: 2,
          x: 50,
          top: 202,
          width: 200,
          height: 40,
          required: true,
        },
      ],
    });
    expect(externalId).toBe('ds-env-1');
    const body = requests[0]!.body as Record<string, any>;
    expect(requests[0]!.url).toBe(
      'https://demo.docusign.net/restapi/v2.1/accounts/acct-1/envelopes',
    );
    expect(body.recipients.signers[0]).toMatchObject({
      email: 'seller@target.test',
      routingOrder: '1',
      tabs: { signHereTabs: [{ pageNumber: '2', xPosition: '50', yPosition: '202' }] },
    });
    expect(body.recipients.certifiedDeliveries[0]).toMatchObject({ routingOrder: '2' });
    expect(body.recipients.carbonCopies[0]).toMatchObject({ email: 'counsel@law.test' });
    expect(body.customFields.textCustomFields).toContainEqual({
      name: 'better_files_envelope',
      value: 'env_1',
      show: 'false',
    });
    expect(body.documents[0].documentBase64).toBe('AQID');
  });

  it('reports recipient progress and verifies Connect signatures', async () => {
    const { provider } = fake();
    expect(await provider.status('ds-env-1')).toEqual({
      status: 'sent',
      recipients: [
        { email: 'seller@target.test', status: 'signed', at: Date.UTC(2026, 8, 25, 12, 5) },
        { email: 'buyer@acquirer.test', status: 'viewed', at: Date.UTC(2026, 8, 25, 12, 6) },
        { email: 'counsel@law.test', status: 'sent' },
      ],
    });

    const body = JSON.stringify({
      event: 'envelope-completed',
      generatedDateTime: '2026-09-25T12:10:00Z',
      data: {
        envelopeId: 'ds-env-1',
        envelopeSummary: {
          customFields: {
            textCustomFields: [
              { name: 'better_files_tenant', value: TENANT },
              { name: 'better_files_envelope', value: 'env_1' },
            ],
          },
        },
      },
    });
    const signed = (signature: string) =>
      new Request('https://app.example.test/hook', {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/json', 'x-docusign-signature-1': signature },
      });
    const good = createHmac('sha256', key).update(body).digest('base64');
    expect(await provider.parseWebhook(signed(good))).toEqual({
      events: [
        {
          type: 'envelope.completed',
          externalId: 'ds-env-1',
          tenantId: TENANT,
          envelopeId: 'env_1',
          at: Date.UTC(2026, 8, 25, 12, 10),
        },
      ],
    });
    await expect(
      provider.parseWebhook(signed(createHmac('sha256', 'other').update(body).digest('base64'))),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});
