import { BetterFilesError } from '@better-files/core';
import {
  digestEquals,
  hmacSha256,
  providerFailure,
  unauthenticated,
  type EsignProvider,
  type FetchLike,
  type ProviderEvent,
  type ProviderEventType,
  type ProviderStatus,
} from './provider.js';

export interface DropboxSignOptions {
  /** The account's API key. It authenticates API calls and signs webhooks (`event_hash`). */
  apiKey: string;
  /** Test mode: requests are free and not legally binding. Default false. */
  testMode?: boolean;
  /** Set as the request's `client_id`, for API apps with their own callback URL and branding. */
  clientId?: string;
  /** Default `https://api.hellosign.com/v3`. */
  baseUrl?: string;
  fetch?: FetchLike;
}

const FIELD_TYPE: Record<string, string> = {
  signature: 'signature',
  initials: 'initials',
  date: 'date_signed',
  text: 'text',
  checkbox: 'checkbox',
};

const EVENTS: Record<string, ProviderEventType> = {
  signature_request_viewed: 'recipient.viewed',
  signature_request_signed: 'recipient.signed',
  signature_request_declined: 'recipient.declined',
  signature_request_all_signed: 'envelope.completed',
  signature_request_canceled: 'envelope.voided',
};

/** Dropbox Sign's `callback_test` and account events still need the acknowledgement, but carry no envelope. */
const REPLY = 'Hello API Event Received';

interface SignatureRequest {
  signature_request_id?: string;
  is_complete?: boolean;
  is_declined?: boolean;
  metadata?: Record<string, string>;
  signatures?: {
    signer_email_address?: string;
    status_code?: string;
    signed_at?: number | null;
    last_viewed_at?: number | null;
    decline_reason?: string | null;
  }[];
}

/**
 * Dropbox Sign (formerly HelloSign, API v3) as an `esignPlugin` provider, over `fetch` with no SDK. Dropbox Sign has
 * no approver role, so approvers sign as signers (with no fields of their own, Dropbox Sign adds a signature line).
 */
export function dropboxSignProvider(options: DropboxSignOptions): EsignProvider {
  if (!options.apiKey)
    throw new BetterFilesError('INVALID_CONFIG', 'dropboxSignProvider needs an API key');
  const fetcher = options.fetch ?? fetch;
  const base = (options.baseUrl ?? 'https://api.hellosign.com/v3').replace(/\/+$/, '');
  const authorization = `Basic ${Buffer.from(`${options.apiKey}:`).toString('base64')}`;

  async function call(method: string, path: string, action: string, body?: FormData) {
    const response = await fetcher(`${base}${path}`, {
      method,
      headers: { authorization, accept: 'application/json' },
      ...(body ? { body } : {}),
    });
    if (!response.ok) throw await providerFailure('Dropbox Sign', action, response);
    return response;
  }

  return {
    id: 'dropbox-sign',
    async send(envelope) {
      const form = new FormData();
      form.set('title', envelope.title.slice(0, 255));
      form.set('subject', envelope.title.slice(0, 255));
      if (envelope.message) form.set('message', envelope.message.slice(0, 5000));
      if (options.testMode) form.set('test_mode', '1');
      if (options.clientId) form.set('client_id', options.clientId);
      form.set('metadata[better_files_tenant]', envelope.tenantId);
      form.set('metadata[better_files_envelope]', envelope.envelopeId);
      const content = envelope.document.content;
      form.set(
        'files[0]',
        new Blob(
          [
            content.buffer.slice(
              content.byteOffset,
              content.byteOffset + content.byteLength,
            ) as ArrayBuffer,
          ],
          {
            type: 'application/pdf',
          },
        ),
        envelope.document.name,
      );
      // Signer indexes as Dropbox Sign numbers them (cc recipients are not signers).
      const signerIndex = new Map<number, number>();
      let cc = 0;
      envelope.recipients.forEach((recipient, index) => {
        if (recipient.role === 'cc') {
          form.set(`cc_email_addresses[${cc++}]`, recipient.email);
          return;
        }
        const n = signerIndex.size;
        signerIndex.set(index, n);
        form.set(`signers[${n}][email_address]`, recipient.email);
        form.set(`signers[${n}][name]`, recipient.name);
        if (envelope.routing === 'sequential')
          form.set(`signers[${n}][order]`, String(recipient.order - 1));
      });
      if (envelope.fields.length > 0)
        form.set(
          'form_fields_per_document',
          JSON.stringify([
            envelope.fields.map((field, index) => ({
              api_id: `better_files_${index + 1}`,
              name: `${field.type} ${index + 1}`,
              type: FIELD_TYPE[field.type],
              signer: signerIndex.get(field.recipient),
              page: field.page,
              x: Math.round(field.x),
              y: Math.round(field.top),
              width: Math.round(field.width),
              height: Math.round(field.height),
              required: field.required,
            })),
          ]),
        );
      const response = await call('POST', '/signature_request/send', 'request creation', form);
      const created = (await response.json()) as { signature_request?: SignatureRequest };
      const externalId = created.signature_request?.signature_request_id;
      if (!externalId)
        throw new BetterFilesError('INTERNAL_ERROR', 'Dropbox Sign returned no request id');
      return { externalId };
    },
    async status(externalId) {
      const response = await fetcher(
        `${base}/signature_request/${encodeURIComponent(externalId)}`,
        {
          headers: { authorization, accept: 'application/json' },
        },
      );
      // Canceled requests are gone from the API.
      if (response.status === 410) return { status: 'voided', recipients: [] };
      if (!response.ok) throw await providerFailure('Dropbox Sign', 'status', response);
      const request = ((await response.json()) as { signature_request?: SignatureRequest })
        .signature_request;
      const ms = (seconds?: number | null) => (seconds ? seconds * 1000 : undefined);
      const recipients: ProviderStatus['recipients'] = (request?.signatures ?? [])
        .filter((s) => s.signer_email_address)
        .map((s) => {
          const status =
            s.status_code === 'signed'
              ? ('signed' as const)
              : s.status_code === 'declined'
                ? ('declined' as const)
                : s.last_viewed_at
                  ? ('viewed' as const)
                  : ('sent' as const);
          const at =
            status === 'signed'
              ? ms(s.signed_at)
              : status === 'viewed'
                ? ms(s.last_viewed_at)
                : undefined;
          return {
            email: s.signer_email_address!.toLowerCase(),
            status,
            ...(at === undefined ? {} : { at }),
            ...(status === 'declined' && s.decline_reason ? { reason: s.decline_reason } : {}),
          };
        });
      if (request?.is_complete) return { status: 'completed', recipients };
      if (request?.is_declined) {
        const reason = recipients.find((r) => r.status === 'declined')?.reason;
        return { status: 'declined', recipients, ...(reason ? { reason } : {}) };
      }
      return { status: 'sent', recipients };
    },
    async void(externalId) {
      await call('POST', `/signature_request/cancel/${encodeURIComponent(externalId)}`, 'cancel');
    },
    async remind(externalId, emails) {
      for (const email of emails) {
        const form = new FormData();
        form.set('email_address', email);
        await call(
          'POST',
          `/signature_request/remind/${encodeURIComponent(externalId)}`,
          'reminder',
          form,
        );
      }
    },
    async download(externalId) {
      // The PDF comes with Dropbox Sign's audit trail appended.
      const response = await call(
        'GET',
        `/signature_request/files/${encodeURIComponent(externalId)}?file_type=pdf`,
        'document download',
      );
      return { signed: new Uint8Array(await response.arrayBuffer()) };
    },
    async parseWebhook(request) {
      let payload: string | undefined;
      const type = request.headers.get('content-type') ?? '';
      if (
        type.includes('multipart/form-data') ||
        type.includes('application/x-www-form-urlencoded')
      ) {
        const value = (await request.formData()).get('json');
        payload = typeof value === 'string' ? value : undefined;
      } else payload = await request.text();
      let message: {
        event?: { event_time?: string; event_type?: string; event_hash?: string };
        signature_request?: SignatureRequest;
      };
      try {
        message = JSON.parse(payload ?? '') as typeof message;
      } catch {
        throw new BetterFilesError('INVALID_INPUT', 'Dropbox Sign callbacks carry a JSON event');
      }
      const event = message.event;
      if (
        !event?.event_time ||
        !event.event_type ||
        !event.event_hash ||
        !digestEquals(
          event.event_hash,
          hmacSha256(options.apiKey, `${event.event_time}${event.event_type}`),
          'hex',
        )
      )
        throw unauthenticated('Dropbox Sign');
      const kind = EVENTS[event.event_type];
      const externalId = message.signature_request?.signature_request_id;
      if (!kind || !externalId) return { events: [], reply: REPLY };
      const metadata = message.signature_request?.metadata ?? {};
      const at = Number(event.event_time) * 1000;
      const normalized: ProviderEvent = {
        type: kind,
        externalId,
        ...(metadata.better_files_tenant ? { tenantId: metadata.better_files_tenant } : {}),
        ...(metadata.better_files_envelope ? { envelopeId: metadata.better_files_envelope } : {}),
        ...(Number.isFinite(at) ? { at } : {}),
      };
      return { events: [normalized], reply: REPLY };
    },
  };
}
