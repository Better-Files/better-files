import { createSign } from 'node:crypto';
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
} from './provider.js';

export interface DocusignOptions {
  /** The account's API base, e.g. `https://demo.docusign.net/restapi` or `https://na4.docusign.net/restapi`. */
  basePath: string;
  accountId: string;
  /** A current OAuth access token; `docusignJwtAuth()` gets and refreshes one with the JWT grant. */
  accessToken: () => Promise<string>;
  /**
   * DocuSign Connect HMAC keys. Webhooks are refused unless one of them signed the body. Configure Connect to send
   * JSON (SIM) messages with "Include Envelope Custom Fields" and "Include Recipients" checked.
   */
  connectKeys: readonly string[];
  /** Sent per envelope as `eventNotification`, when you do not use an account-level Connect configuration. */
  webhookUrl?: string;
  fetch?: FetchLike;
}

const TAB: Record<string, string> = {
  signature: 'signHereTabs',
  initials: 'initialHereTabs',
  date: 'dateSignedTabs',
  text: 'textTabs',
  checkbox: 'checkboxTabs',
};

const EVENTS: Record<string, ProviderEventType> = {
  'recipient-delivered': 'recipient.viewed',
  'recipient-completed': 'recipient.signed',
  'recipient-declined': 'recipient.declined',
  'envelope-completed': 'envelope.completed',
  'envelope-voided': 'envelope.voided',
};

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/**
 * Access tokens through DocuSign's JWT grant (service integrations): signs an assertion with the integration's RSA
 * key, caches the token, and refreshes it a minute before it expires. The user must have granted consent once.
 */
export function docusignJwtAuth(options: {
  integrationKey: string;
  /** The API user id (GUID) to act as. */
  userId: string;
  /** PEM-encoded RSA private key. */
  privateKey: string;
  /** `account-d.docusign.com` (demo, default) or `account.docusign.com`. */
  oauthHost?: string;
  fetch?: FetchLike;
}): () => Promise<string> {
  const host = options.oauthHost ?? 'account-d.docusign.com';
  const fetcher = options.fetch ?? fetch;
  let cached: { token: string; expiresAt: number } | undefined;
  let pending: Promise<string> | undefined;
  const obtain = async () => {
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64url(
      JSON.stringify({
        iss: options.integrationKey,
        sub: options.userId,
        aud: host,
        iat: now,
        exp: now + 3600,
        scope: 'signature impersonation',
      }),
    );
    const signature = createSign('RSA-SHA256')
      .update(`${header}.${claims}`)
      .sign(options.privateKey)
      .toString('base64url');
    const response = await fetcher(`https://${host}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${header}.${claims}.${signature}`,
      }).toString(),
    });
    if (!response.ok) throw await providerFailure('DocuSign', 'token request', response);
    const body = (await response.json()) as { access_token: string; expires_in: number };
    cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
    return body.access_token;
  };
  return async () => {
    if (cached && cached.expiresAt > Date.now()) return cached.token;
    pending ??= obtain().finally(() => (pending = undefined));
    return pending;
  };
}

interface DocusignRecipient {
  email?: string;
  status?: string;
  deliveredDateTime?: string;
  signedDateTime?: string;
  declinedDateTime?: string;
  declinedReason?: string;
}

interface ConnectRecipient {
  recipientId?: string;
  email?: string;
  declinedReason?: string;
}

interface ConnectMessage {
  event?: string;
  generatedDateTime?: string;
  data?: {
    envelopeId?: string;
    recipientId?: string;
    envelopeSummary?: {
      voidedReason?: string;
      customFields?: { textCustomFields?: { name?: string; value?: string }[] };
      recipients?: Record<string, ConnectRecipient[] | undefined>;
    };
  };
}

/**
 * DocuSign eSignature (REST v2.1) as an `esignPlugin` provider, over `fetch` with no SDK. Approvers become
 * certified-delivery recipients (they must open and acknowledge); routing orders follow the envelope's routing.
 */
export function docusignProvider(options: DocusignOptions): EsignProvider {
  if (options.connectKeys.length === 0)
    throw new BetterFilesError(
      'INVALID_CONFIG',
      'docusignProvider needs at least one Connect HMAC key',
    );
  const fetcher = options.fetch ?? fetch;
  const api = `${options.basePath.replace(/\/+$/, '')}/v2.1/accounts/${encodeURIComponent(options.accountId)}`;

  async function call(method: string, path: string, action: string, body?: unknown) {
    const response = await fetcher(`${api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await options.accessToken()}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw await providerFailure('DocuSign', action, response);
    return response;
  }

  return {
    id: 'docusign',
    async send(envelope) {
      const signers: object[] = [];
      const certifiedDeliveries: object[] = [];
      const carbonCopies: object[] = [];
      envelope.recipients.forEach((recipient, index) => {
        const base = {
          email: recipient.email,
          name: recipient.name,
          recipientId: String(index + 1),
          routingOrder: String(envelope.routing === 'parallel' ? 1 : recipient.order),
        };
        if (recipient.role === 'cc') return carbonCopies.push(base);
        if (recipient.role === 'approver') return certifiedDeliveries.push(base);
        const tabs: Record<string, object[]> = {};
        for (const field of envelope.fields.filter((f) => f.recipient === index))
          (tabs[TAB[field.type]!] ??= []).push({
            documentId: '1',
            pageNumber: String(field.page),
            xPosition: String(Math.round(field.x)),
            yPosition: String(Math.round(field.top)),
            ...(field.type === 'text' || field.type === 'date'
              ? { width: String(Math.round(field.width)), height: String(Math.round(field.height)) }
              : {}),
            ...(field.type === 'text' || field.type === 'checkbox'
              ? {
                  required: String(field.required),
                  tabLabel: `field-${field.page}-${field.x}-${field.top}`,
                }
              : {}),
          });
        signers.push({ ...base, tabs });
      });
      const response = await call('POST', '/envelopes', 'envelope creation', {
        emailSubject: envelope.title.slice(0, 100),
        ...(envelope.message ? { emailBlurb: envelope.message.slice(0, 10000) } : {}),
        status: 'sent',
        documents: [
          {
            documentId: '1',
            name: envelope.document.name,
            fileExtension: 'pdf',
            documentBase64: Buffer.from(envelope.document.content).toString('base64'),
          },
        ],
        recipients: { signers, certifiedDeliveries, carbonCopies },
        customFields: {
          textCustomFields: [
            { name: 'better_files_tenant', value: envelope.tenantId, show: 'false' },
            { name: 'better_files_envelope', value: envelope.envelopeId, show: 'false' },
          ],
        },
        ...(options.webhookUrl
          ? {
              eventNotification: {
                url: options.webhookUrl,
                requireAcknowledgment: 'true',
                deliveryMode: 'SIM',
                eventData: {
                  version: 'restv2.1',
                  format: 'json',
                  includeData: ['custom_fields', 'recipients'],
                },
                events: Object.keys(EVENTS),
              },
            }
          : {}),
      });
      const created = (await response.json()) as { envelopeId?: string };
      if (!created.envelopeId)
        throw new BetterFilesError('INTERNAL_ERROR', 'DocuSign returned no envelope id');
      return { externalId: created.envelopeId };
    },
    async status(externalId) {
      const response = await call(
        'GET',
        `/envelopes/${encodeURIComponent(externalId)}?include=recipients`,
        'status',
      );
      const body = (await response.json()) as {
        status?: string;
        voidedReason?: string;
        recipients?: Record<string, DocusignRecipient[] | undefined>;
      };
      const time = (value?: string) => {
        const at = value ? Date.parse(value) : NaN;
        return Number.isFinite(at) ? at : undefined;
      };
      const recipients = Object.values(body.recipients ?? {})
        .flatMap((list) => (Array.isArray(list) ? list : []))
        .filter((r) => r.email)
        .map((r) => {
          const declined = r.status === 'declined';
          const signed = r.status === 'completed' || r.status === 'signed';
          const viewed = r.status === 'delivered';
          const at = declined
            ? time(r.declinedDateTime)
            : signed
              ? time(r.signedDateTime ?? r.deliveredDateTime)
              : viewed
                ? time(r.deliveredDateTime)
                : undefined;
          return {
            email: r.email!.toLowerCase(),
            status: declined
              ? ('declined' as const)
              : signed
                ? ('signed' as const)
                : viewed
                  ? ('viewed' as const)
                  : ('sent' as const),
            ...(at === undefined ? {} : { at }),
            ...(declined && r.declinedReason ? { reason: r.declinedReason } : {}),
          };
        });
      const declinedBy = recipients.find((r) => r.status === 'declined');
      return body.status === 'completed'
        ? { status: 'completed', recipients }
        : body.status === 'voided'
          ? {
              status: 'voided',
              recipients,
              ...(body.voidedReason ? { reason: body.voidedReason } : {}),
            }
          : body.status === 'declined'
            ? {
                status: 'declined',
                recipients,
                ...(declinedBy?.reason ? { reason: declinedBy.reason } : {}),
              }
            : { status: 'sent', recipients };
    },
    async void(externalId, reason) {
      await call('PUT', `/envelopes/${encodeURIComponent(externalId)}`, 'void', {
        status: 'voided',
        voidedReason: reason.slice(0, 200),
      });
    },
    async remind(externalId) {
      // DocuSign resends to every recipient whose turn it is.
      await call(
        'PUT',
        `/envelopes/${encodeURIComponent(externalId)}?resend_envelope=true`,
        'reminder',
        {},
      );
    },
    async download(externalId) {
      const path = `/envelopes/${encodeURIComponent(externalId)}/documents`;
      const signed = await call('GET', `${path}/combined`, 'document download');
      const certificate = await call('GET', `${path}/certificate`, 'certificate download');
      return {
        signed: new Uint8Array(await signed.arrayBuffer()),
        certificate: new Uint8Array(await certificate.arrayBuffer()),
      };
    },
    async parseWebhook(request) {
      const raw = new Uint8Array(await request.arrayBuffer());
      const expected = (key: string) => hmacSha256(key, raw);
      const signatures: string[] = [];
      for (let i = 1; i <= 100; i++) {
        const value = request.headers.get(`x-docusign-signature-${i}`);
        if (!value) break;
        signatures.push(value);
      }
      if (
        !signatures.some((signature) =>
          options.connectKeys.some((key) => digestEquals(signature, expected(key), 'base64')),
        )
      )
        throw unauthenticated('DocuSign');
      let message: ConnectMessage;
      try {
        message = JSON.parse(new TextDecoder().decode(raw)) as ConnectMessage;
      } catch {
        throw new BetterFilesError('INVALID_INPUT', 'DocuSign Connect messages must be JSON (SIM)');
      }
      const type = message.event ? EVENTS[message.event] : undefined;
      const externalId = message.data?.envelopeId;
      if (!type || !externalId) return { events: [] };
      const summary = message.data?.envelopeSummary;
      const custom = Object.fromEntries(
        (summary?.customFields?.textCustomFields ?? []).map((f) => [f.name, f.value]),
      );
      const recipient = Object.values(summary?.recipients ?? {})
        .flatMap((list) => (Array.isArray(list) ? list : []))
        .find((r) => r.recipientId === message.data?.recipientId);
      const at = message.generatedDateTime ? Date.parse(message.generatedDateTime) : NaN;
      const reason =
        type === 'recipient.declined'
          ? recipient?.declinedReason
          : type === 'envelope.voided'
            ? summary?.voidedReason
            : undefined;
      const event: ProviderEvent = {
        type,
        externalId,
        ...(custom.better_files_tenant ? { tenantId: custom.better_files_tenant } : {}),
        ...(custom.better_files_envelope ? { envelopeId: custom.better_files_envelope } : {}),
        ...(recipient?.email ? { email: recipient.email.toLowerCase() } : {}),
        ...(reason ? { reason } : {}),
        ...(Number.isFinite(at) ? { at } : {}),
      };
      return { events: [event] };
    },
  };
}
