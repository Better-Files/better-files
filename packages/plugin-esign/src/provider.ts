import { createHmac, timingSafeEqual } from 'node:crypto';
import { BetterFilesError } from '@better-files/core';

/** A field as the provider places it: PDF points from the page's top-left corner (DocuSign and Dropbox Sign). */
export interface ProviderField {
  /** Index into `recipients`. */
  recipient: number;
  type: 'signature' | 'initials' | 'date' | 'text' | 'checkbox';
  page: number;
  x: number;
  /** Distance from the top of the page to the field's top edge. */
  top: number;
  width: number;
  height: number;
  required: boolean;
}

/** What `send` hands an external provider. */
export interface ProviderEnvelope {
  tenantId: string;
  /** The Better Files envelope id; providers echo it back in webhooks as metadata. */
  envelopeId: string;
  title: string;
  message?: string;
  routing: 'parallel' | 'sequential';
  document: { name: string; content: Uint8Array };
  recipients: {
    email: string;
    name: string;
    role: 'signer' | 'approver' | 'cc';
    order: number;
  }[];
  fields: ProviderField[];
}

export type ProviderEventType =
  | 'recipient.viewed'
  | 'recipient.signed'
  | 'recipient.declined'
  | 'envelope.completed'
  | 'envelope.voided';

/** A verified webhook event, normalized across providers. */
export interface ProviderEvent {
  type: ProviderEventType;
  /** The provider's envelope (signature request) id. */
  externalId: string;
  /** From the metadata Better Files attached on send; absent for envelopes created elsewhere. */
  tenantId?: string;
  envelopeId?: string;
  email?: string;
  reason?: string;
  /** When the provider says it happened (ms). */
  at?: number;
}

/** Where an envelope stands at the provider: the source of truth `esign.sync` applies. */
export interface ProviderStatus {
  status: 'sent' | 'completed' | 'declined' | 'voided';
  /** Why it was declined or voided, when the provider says. */
  reason?: string;
  recipients: {
    email: string;
    status: 'sent' | 'viewed' | 'signed' | 'declined';
    /** When it reached that status (ms), when the provider says. */
    at?: number;
    reason?: string;
  }[];
}

/**
 * An external e-signature service. Envelopes sent while a provider is configured go through it: the provider emails
 * the recipients and hosts the ceremony. `esign.sync` reads the outcome back with `status` (and `download` once
 * complete). Webhooks only say which envelope to sync: their contents are never applied, so a replayed or forged
 * message can at most cause a harmless re-read.
 */
export interface EsignProvider {
  /** `docusign`, `dropbox-sign`, or your own. */
  id: string;
  send(envelope: ProviderEnvelope): Promise<{ externalId: string }>;
  status(externalId: string): Promise<ProviderStatus>;
  void(externalId: string, reason: string): Promise<void>;
  /** Re-notifies the recipients whose turn it is (`emails`). */
  remind(externalId: string, emails: readonly string[]): Promise<void>;
  /** The completed, provider-sealed PDF, and the provider's certificate when it is a separate file. */
  download(externalId: string): Promise<{ signed: Uint8Array; certificate?: Uint8Array }>;
  /**
   * Verifies a webhook request (throws `UNAUTHENTICATED` when the signature does not match) and returns its events.
   * `reply` is the body the provider expects back, when it expects something particular.
   */
  parseWebhook(request: Request): Promise<{ events: ProviderEvent[]; reply?: string }>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Throws a `BetterFilesError` describing a failed provider call, without echoing credentials. */
export async function providerFailure(provider: string, action: string, response: Response) {
  let detail = '';
  try {
    detail = (await response.text()).slice(0, 500);
  } catch {
    // The body is informational only.
  }
  return new BetterFilesError(
    response.status === 404
      ? 'NOT_FOUND'
      : response.status === 429
        ? 'RATE_LIMITED'
        : 'INTERNAL_ERROR',
    `${provider} ${action} failed with HTTP ${response.status}`,
    { details: { provider, status: response.status, ...(detail ? { body: detail } : {}) } },
  );
}

export const hmacSha256 = (key: string, data: string | Uint8Array) =>
  createHmac('sha256', key).update(data).digest();

/** Constant-time comparison of two encoded digests. */
export function digestEquals(given: string, expected: Buffer, encoding: 'hex' | 'base64'): boolean {
  const decoded = Buffer.from(given.trim(), encoding);
  return decoded.length === expected.length && timingSafeEqual(decoded, expected);
}

export const unauthenticated = (provider: string) =>
  new BetterFilesError('UNAUTHENTICATED', `The ${provider} webhook signature does not match`);
