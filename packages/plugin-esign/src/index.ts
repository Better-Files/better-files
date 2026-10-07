import { createHash, randomBytes } from 'node:crypto';
import {
  BetterFilesError,
  defineTable,
  definePlugin,
  endpoint,
  field,
  forbidden,
  invalidConfig,
  notFound,
  prefixedId,
  v,
  type DataRoomDocument,
  type DataRoomNode,
  type DocumentVersion,
  type PluginContext,
} from '@better-files/core';
import { describePdf, stampAndCertify, type StampField } from './pdf.js';
import type { EsignProvider, ProviderStatus } from './provider.js';
import { sealPdf, type PdfSealer } from './seal.js';

export type { StampField, CertificateData } from './pdf.js';
export type {
  EsignProvider,
  FetchLike,
  ProviderEnvelope,
  ProviderEvent,
  ProviderEventType,
  ProviderField,
  ProviderStatus,
} from './provider.js';
export { docusignJwtAuth, docusignProvider, type DocusignOptions } from './docusign.js';
export { dropboxSignProvider, type DropboxSignOptions } from './dropbox-sign.js';
export {
  keySealer,
  sealPdf,
  selfSignedSealer,
  verifyPdfSeal,
  type PdfSealer,
  type SealOptions,
  type SealVerification,
} from './seal.js';

type EnvelopeStatus = 'draft' | 'sent' | 'completed' | 'voided' | 'declined';
type RecipientRole = 'signer' | 'approver' | 'cc';
type RecipientStatus = 'pending' | 'sent' | 'viewed' | 'signed' | 'declined';
type FieldType = 'signature' | 'initials' | 'date' | 'text' | 'checkbox';

export interface Envelope {
  id: string;
  tenantId: string;
  roomId: string;
  documentId: string;
  versionId: string;
  title: string;
  message?: string;
  status: EnvelopeStatus;
  routing: 'parallel' | 'sequential';
  originalSha256: string;
  finalSha256?: string;
  signedDocumentId?: string;
  createdBy: string;
  sentAt?: number;
  completedAt?: number;
  voidedAt?: number;
  voidReason?: string;
  evidenceHead?: string;
  evidenceSequence: number;
  /** The external provider that runs the ceremony (`docusign`, `dropbox-sign`); absent for native envelopes. */
  provider?: string;
  /** The provider's envelope or signature request id. */
  externalId?: string;
  /** When `esign.sync` last read the provider. */
  syncedAt?: number;
  updatedAt: number;
  createdAt: number;
}

export interface EnvelopeRecipient {
  id: string;
  tenantId: string;
  envelopeId: string;
  email: string;
  name: string;
  role: RecipientRole;
  order: number;
  status: RecipientStatus;
  tokenHash?: string;
  tokenExpiresAt?: number;
  viewedAt?: number;
  signedAt?: number;
  declinedAt?: number;
  declineReason?: string;
  signatureName?: string;
  ip?: string;
  userAgent?: string;
  createdAt: number;
}

export interface EnvelopeField {
  id: string;
  tenantId: string;
  envelopeId: string;
  recipientId: string;
  type: FieldType;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  required: boolean;
  value?: string;
  createdAt: number;
}

interface EvidenceEvent {
  id: string;
  tenantId: string;
  envelopeId: string;
  sequence: number;
  type: string;
  actor: string;
  ip?: string;
  userAgent?: string;
  detail?: Record<string, unknown>;
  previousHash?: string;
  hash: string;
  createdAt: number;
}

export interface Delivery {
  kind: 'sign' | 'completed' | 'reminder' | 'voided';
  tenantId: string;
  envelopeId: string;
  title: string;
  message?: string;
  recipient: { email: string; name: string; role: RecipientRole };
  /** The signing token (for `sign` and `reminder`): put it in a link to your signing page. Never log it. */
  token?: string;
}

export interface EsignOptions {
  /**
   * Sends signing links and notices; your mailer or Better IAM's delivery. Required for native signing. With a
   * `provider`, the provider emails recipients and this only sends the `completed` notices, when given.
   */
  deliver?: (delivery: Delivery) => Promise<void>;
  /** Days a signing link stays valid. Default 30. */
  linkDays?: number;
  /**
   * Run signing ceremonies at an external provider (`docusignProvider`, `dropboxSignProvider`) instead of natively.
   * Envelopes are still prepared, tracked and stored in the room; the signed PDF the provider seals comes back into
   * the room through `esign.sync`, which `esignWebhook()` calls when the provider reports a change.
   */
  provider?: EsignProvider;
  /** Minimum time between two provider reads of one envelope through `esign.sync`. Default 5 seconds. */
  syncIntervalMs?: number;
  /**
   * Seal natively signed PDFs with a PAdES signature (`keySealer`, or `selfSignedSealer` in development), so any later
   * change to the signed copy shows in PDF readers and `verifyPdfSeal`. Provider-signed PDFs keep the provider's seal.
   */
  seal?: PdfSealer;
  /** The seal's location field, e.g. your company's city. */
  sealLocation?: string;
}

const SEND = 'better-files:esign:send';
const SIGN_PUBLIC = 'better-files:esign:sign';
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Appends to the envelope's own hash-chained evidence trail (the certificate's source). */
async function evidence(
  context: PluginContext,
  envelope: Envelope,
  entry: {
    type: string;
    actor: string;
    ip?: string;
    userAgent?: string;
    detail?: Record<string, unknown>;
  },
) {
  return context.db.transaction(async (tx) => {
    const sequence = await tx.increment(
      'envelopes',
      { id: envelope.id, tenantId: envelope.tenantId },
      'evidenceSequence',
    );
    const current = await tx.findOne<Envelope>('envelopes', {
      id: envelope.id,
      tenantId: envelope.tenantId,
    });
    const base = {
      tenantId: envelope.tenantId,
      envelopeId: envelope.id,
      sequence: sequence!,
      type: entry.type,
      actor: entry.actor,
      createdAt: context.now,
      ...(entry.ip ? { ip: entry.ip } : {}),
      ...(entry.userAgent ? { userAgent: entry.userAgent.slice(0, 256) } : {}),
      ...(entry.detail ? { detail: entry.detail } : {}),
      ...(current?.evidenceHead ? { previousHash: current.evidenceHead } : {}),
    };
    const hash = sha256(canonical(base));
    await tx.insert('envelopeEvents', {
      ...base,
      id: prefixedId('eve', context.now),
      hash,
    } satisfies EvidenceEvent);
    await tx.update(
      'envelopes',
      { id: envelope.id, tenantId: envelope.tenantId },
      { evidenceHead: hash, updatedAt: context.now },
    );
    return hash;
  });
}

export async function verifyEvidence(
  context: Pick<PluginContext, 'db'>,
  tenantId: string,
  envelopeId: string,
) {
  const events = await context.db.findMany<EvidenceEvent>('envelopeEvents', {
    where: { tenantId, envelopeId },
    orderBy: [{ field: 'sequence' }],
  });
  let previous: string | undefined;
  for (const [index, event] of events.entries()) {
    const { id: _id, hash, ...content } = event;
    if (
      event.sequence !== index + 1 ||
      event.previousHash !== previous ||
      sha256(canonical(content)) !== hash
    )
      return { valid: false, events: events.length, brokenAt: event.sequence };
    previous = hash;
  }
  return { valid: true, events: events.length, ...(previous ? { head: previous } : {}) };
}

/** Recipients whose turn it is: everyone (parallel), or the lowest order not yet done (sequential). */
function currentTurn(
  envelope: Envelope,
  recipients: readonly EnvelopeRecipient[],
): EnvelopeRecipient[] {
  const actionable = recipients.filter((r) => r.role !== 'cc' && r.status !== 'signed');
  if (envelope.routing === 'parallel') return actionable;
  const next = Math.min(...actionable.map((r) => r.order));
  return actionable.filter((r) => r.order === next);
}

const envelopeTarget = async (
  input: { envelopeId: string },
  lookup: { db: PluginContext['db']; tenantId: string },
) => {
  const envelope = await lookup.db.findOne<Envelope>('envelopes', {
    id: input.envelopeId,
    tenantId: lookup.tenantId,
  });
  if (!envelope) throw notFound('Envelope');
  return { roomId: envelope.roomId };
};

/**
 * Native e-signature on room documents: envelopes with signer, approver and cc recipients, fields placed on PDF pages,
 * parallel or sequential routing, signing through emailed links (no account needed), a hash-chained evidence trail,
 * and on completion a stamped PDF with a certificate of completion saved back into the room.
 */
export function esignPlugin(options: EsignOptions) {
  const linkMs = (options.linkDays ?? 30) * 86_400_000;
  const provider = options.provider;
  const syncIntervalMs = options.syncIntervalMs ?? 5_000;
  if (!options.deliver && !provider)
    throw invalidConfig('esignPlugin needs `deliver` (native signing) or a `provider`');
  const deliver = async (delivery: Delivery) => {
    await options.deliver?.(delivery);
  };

  async function issueTokens(
    context: PluginContext,
    envelope: Envelope,
    recipients: readonly EnvelopeRecipient[],
    kind: 'sign' | 'reminder',
  ) {
    for (const recipient of recipients) {
      const token = randomBytes(24).toString('base64url');
      await context.db.transaction((tx) =>
        tx.update(
          'envelopeRecipients',
          { id: recipient.id, tenantId: recipient.tenantId },
          {
            tokenHash: sha256(token),
            tokenExpiresAt: context.now + linkMs,
            ...(recipient.status === 'pending' ? { status: 'sent' } : {}),
          },
        ),
      );
      await deliver({
        kind,
        tenantId: envelope.tenantId,
        envelopeId: envelope.id,
        title: envelope.title,
        ...(envelope.message ? { message: envelope.message } : {}),
        recipient: { email: recipient.email, name: recipient.name, role: recipient.role },
        token,
      });
      await evidence(context, envelope, {
        type: kind === 'sign' ? 'recipient.notified' : 'recipient.reminded',
        actor: 'system',
        detail: { email: recipient.email },
      });
    }
  }

  /** Resolves a signing token to its envelope and recipient, refusing stale, finished or out-of-turn links. */
  async function byToken(context: PluginContext, token: string) {
    const recipient = await context.db.findOne<EnvelopeRecipient>('envelopeRecipients', {
      tokenHash: sha256(token),
      tenantId: context.tenantId,
    });
    if (!recipient || !recipient.tokenExpiresAt || recipient.tokenExpiresAt <= context.now)
      throw notFound('Signing link');
    const envelope = await context.db.findOne<Envelope>('envelopes', {
      id: recipient.envelopeId,
      tenantId: context.tenantId,
    });
    if (!envelope) throw notFound('Signing link');
    if (envelope.status !== 'sent')
      throw new BetterFilesError('CONFLICT', `The envelope is ${envelope.status}`);
    return { envelope, recipient };
  }

  async function finalize(context: PluginContext, envelope: Envelope) {
    const [recipients, fields, events] = await Promise.all([
      context.db.findMany<EnvelopeRecipient>('envelopeRecipients', {
        where: { tenantId: envelope.tenantId, envelopeId: envelope.id },
        orderBy: [{ field: 'order' }],
      }),
      context.db.findMany<EnvelopeField>('envelopeFields', {
        where: { tenantId: envelope.tenantId, envelopeId: envelope.id },
      }),
      context.db.findMany<EvidenceEvent>('envelopeEvents', {
        where: { tenantId: envelope.tenantId, envelopeId: envelope.id },
        orderBy: [{ field: 'sequence' }],
      }),
    ]);
    const node = await context.db.findOne<DataRoomNode>('nodes', {
      id: envelope.documentId,
      tenantId: envelope.tenantId,
    });
    if (!node?.parentId) throw notFound('Document');
    const iso = (at?: number) => (at ? new Date(at).toISOString() : undefined);
    const completedAt = context.now;
    const head = await evidence(context, envelope, { type: 'envelope.completed', actor: 'system' });
    const original = await readAll(await context.readVersion(envelope.versionId));
    const stamped = await stampAndCertify(
      original,
      fields.map(
        (f): StampField => ({
          type: f.type,
          page: f.page,
          x: f.x,
          y: f.y,
          width: f.width,
          height: f.height,
          value: f.value ?? '',
        }),
      ),
      {
        envelopeId: envelope.id,
        title: envelope.title,
        documentName: node.name,
        originalSha256: envelope.originalSha256,
        completedAt: iso(completedAt)!,
        recipients: recipients.map((r) => ({
          name: r.name,
          email: r.email,
          role: r.role,
          status: r.status,
          ...(r.signedAt ? { at: iso(r.signedAt)! } : {}),
          ...(r.ip ? { ip: r.ip } : {}),
          method: 'emailed signing link',
        })),
        events: [
          ...events.map((e) => ({
            at: iso(e.createdAt)!,
            type: e.type,
            actor: e.actor,
            ...(e.ip ? { ip: e.ip } : {}),
          })),
          { at: iso(completedAt)!, type: 'envelope.completed', actor: 'system' },
        ],
        evidenceHead: head,
      },
    );
    const sealed = options.seal
      ? await sealPdf(stamped, options.seal, {
          reason: `Signed through envelope ${envelope.id} (evidence ${head.slice(0, 16)})`,
          signedAt: new Date(completedAt),
          ...(options.sealLocation ? { location: options.sealLocation } : {}),
        })
      : stamped;
    const stem = node.name.replace(/\.pdf$/i, '');
    const stored = await context.addDocument({
      parentId: node.parentId,
      filename: `${stem} (signed).pdf`,
      mimeType: 'application/pdf',
      content: sealed,
      comment: `Signed through envelope ${envelope.id}`,
      actorId: envelope.createdBy,
    });
    await context.db.transaction((tx) =>
      tx.update(
        'envelopes',
        { id: envelope.id, tenantId: envelope.tenantId },
        {
          status: 'completed',
          completedAt,
          finalSha256: stored.sha256,
          signedDocumentId: stored.nodeId,
          updatedAt: completedAt,
        },
      ),
    );
    for (const recipient of recipients)
      await deliver({
        kind: 'completed',
        tenantId: envelope.tenantId,
        envelopeId: envelope.id,
        title: envelope.title,
        recipient: { email: recipient.email, name: recipient.name, role: recipient.role },
      });
    await context.activity({
      roomId: envelope.roomId,
      action: 'esign.completed',
      nodeId: stored.nodeId,
      metadata: { envelopeId: envelope.id, sha256: stored.sha256 },
    });
    context.emit('esign.completed', {
      envelopeId: envelope.id,
      signedDocumentId: stored.nodeId,
      sha256: stored.sha256,
    });
    return stored;
  }

  /** Hands a draft envelope to the provider: the document, recipients and fields in its top-left coordinates. */
  async function sendExternal(
    context: PluginContext,
    envelope: Envelope,
    recipients: readonly EnvelopeRecipient[],
  ) {
    const [fields, node] = await Promise.all([
      context.db.findMany<EnvelopeField>('envelopeFields', {
        where: { tenantId: envelope.tenantId, envelopeId: envelope.id },
      }),
      context.db.findOne<DataRoomNode>('nodes', {
        id: envelope.documentId,
        tenantId: envelope.tenantId,
      }),
    ]);
    const content = await readAll(await context.readVersion(envelope.versionId));
    const pages = await describePdf(content);
    const ordered = [...recipients].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
    const index = new Map(ordered.map((r, i) => [r.id, i]));
    return provider!.send({
      tenantId: envelope.tenantId,
      envelopeId: envelope.id,
      title: envelope.title,
      ...(envelope.message ? { message: envelope.message } : {}),
      routing: envelope.routing,
      document: { name: node?.name ?? `${envelope.title}.pdf`, content },
      recipients: ordered.map((r) => ({
        email: r.email,
        name: r.name,
        role: r.role,
        order: r.order,
      })),
      fields: fields.map((f) => ({
        recipient: index.get(f.recipientId)!,
        type: f.type,
        page: f.page,
        x: f.x,
        // Better Files places fields from the bottom-left corner (PDF space); providers from the top-left.
        top: pages[f.page - 1]!.height - f.y - f.height,
        width: f.width,
        height: f.height,
        required: f.required,
      })),
    });
  }

  const recipientRank: Record<RecipientStatus, number> = {
    pending: 0,
    sent: 1,
    viewed: 2,
    signed: 3,
    declined: 3,
  };

  /** Stores the provider-sealed PDF (and its certificate) next to the original and completes the envelope. */
  async function completeExternal(context: PluginContext, envelope: Envelope) {
    const node = await context.db.findOne<DataRoomNode>('nodes', {
      id: envelope.documentId,
      tenantId: envelope.tenantId,
    });
    if (!node?.parentId) throw notFound('Document');
    const { signed, certificate } = await provider!.download(envelope.externalId!);
    const stem = node.name.replace(/\.pdf$/i, '');
    const stored = await context.addDocument({
      parentId: node.parentId,
      filename: `${stem} (signed).pdf`,
      mimeType: 'application/pdf',
      content: signed,
      comment: `Signed through ${envelope.provider} envelope ${envelope.externalId}`,
      actorId: envelope.createdBy,
    });
    const certified = certificate
      ? await context.addDocument({
          parentId: node.parentId,
          filename: `${stem} (certificate).pdf`,
          mimeType: 'application/pdf',
          content: certificate,
          comment: `Certificate of completion from ${envelope.provider}`,
          actorId: envelope.createdBy,
        })
      : undefined;
    await evidence(context, envelope, {
      type: 'envelope.completed',
      actor: envelope.provider!,
      detail: {
        signedSha256: stored.sha256,
        ...(certified ? { certificateSha256: certified.sha256 } : {}),
      },
    });
    await context.db.transaction((tx) =>
      tx.update(
        'envelopes',
        { id: envelope.id, tenantId: envelope.tenantId },
        { finalSha256: stored.sha256, signedDocumentId: stored.nodeId, updatedAt: context.now },
      ),
    );
    const recipients = await context.db.findMany<EnvelopeRecipient>('envelopeRecipients', {
      where: { tenantId: envelope.tenantId, envelopeId: envelope.id },
      orderBy: [{ field: 'order' }],
    });
    for (const recipient of recipients)
      await deliver({
        kind: 'completed',
        tenantId: envelope.tenantId,
        envelopeId: envelope.id,
        title: envelope.title,
        recipient: { email: recipient.email, name: recipient.name, role: recipient.role },
      });
    await context.activity({
      roomId: envelope.roomId,
      action: 'esign.completed',
      nodeId: stored.nodeId,
      metadata: { envelopeId: envelope.id, sha256: stored.sha256, provider: envelope.provider! },
    });
    context.emit('esign.completed', {
      envelopeId: envelope.id,
      signedDocumentId: stored.nodeId,
      sha256: stored.sha256,
      provider: envelope.provider!,
    });
    return stored;
  }

  /**
   * Reads a provider envelope's state and applies what changed: recipient progress (as evidence), then completion
   * (the sealed PDF comes back into the room), a decline or a void. Idempotent; concurrent calls complete once.
   */
  async function syncEnvelope(context: PluginContext, envelope: Envelope, throttle: boolean) {
    if (!provider || !envelope.externalId || envelope.status !== 'sent')
      return { status: envelope.status };
    if (envelope.provider !== provider.id)
      throw invalidConfig(
        `Envelope ${envelope.id} was sent through ${envelope.provider}, but the configured provider is ${provider.id}`,
      );
    if (
      throttle &&
      typeof envelope.syncedAt === 'number' &&
      context.now - envelope.syncedAt < syncIntervalMs
    )
      return { status: envelope.status };
    await context.db.transaction((tx) =>
      tx.update(
        'envelopes',
        { id: envelope.id, tenantId: envelope.tenantId },
        { syncedAt: context.now },
      ),
    );
    const remote: ProviderStatus = await provider.status(envelope.externalId);
    const recipients = await context.db.findMany<EnvelopeRecipient>('envelopeRecipients', {
      where: { tenantId: envelope.tenantId, envelopeId: envelope.id },
      orderBy: [{ field: 'order' }],
    });
    for (const recipient of recipients) {
      const reported = remote.recipients.find((r) => r.email === recipient.email);
      if (!reported || recipientRank[reported.status] <= recipientRank[recipient.status]) continue;
      // Viewing is implied by signing: record the steps the provider skipped over, in order.
      const steps = (['viewed', reported.status] as const).filter(
        (status, i, all) =>
          all.indexOf(status) === i && recipientRank[status] > recipientRank[recipient.status],
      );
      const at = reported.at ?? context.now;
      let from = recipient.status;
      for (const status of steps) {
        // Compare-and-set, so concurrent syncs record each step once.
        const changed = await context.db.transaction((tx) =>
          tx.update(
            'envelopeRecipients',
            { id: recipient.id, tenantId: envelope.tenantId, status: from },
            {
              status,
              ...(status === 'viewed' ? { viewedAt: recipient.viewedAt ?? at } : {}),
              ...(status === 'signed' ? { signedAt: at } : {}),
              ...(status === 'declined'
                ? { declinedAt: at, ...(reported.reason ? { declineReason: reported.reason } : {}) }
                : {}),
            },
          ),
        );
        if (changed === 0) break;
        from = status;
        await evidence(context, envelope, {
          type:
            status === 'signed' && recipient.role === 'approver'
              ? 'recipient.approved'
              : `recipient.${status}`,
          actor: recipient.email,
          detail: {
            provider: provider.id,
            at,
            ...(status === 'declined' && reported.reason ? { reason: reported.reason } : {}),
          },
        });
        if (status === 'signed')
          context.emit('esign.signed', { envelopeId: envelope.id, email: recipient.email });
      }
    }
    if (remote.status === 'sent') return { status: 'sent' as const };

    // Claim the transition, so concurrent syncs (a webhook burst) finish the envelope once.
    const claimed = await context.db.transaction((tx) =>
      tx.update(
        'envelopes',
        { id: envelope.id, tenantId: envelope.tenantId, status: 'sent' },
        {
          status: remote.status,
          updatedAt: context.now,
          ...(remote.status === 'completed' ? { completedAt: context.now } : {}),
          ...(remote.status === 'voided'
            ? { voidedAt: context.now, voidReason: remote.reason ?? `Voided at ${provider.id}` }
            : {}),
        },
      ),
    );
    if (claimed === 0) {
      const current = await context.db.findOne<Envelope>('envelopes', {
        id: envelope.id,
        tenantId: envelope.tenantId,
      });
      return { status: current?.status ?? envelope.status };
    }
    if (remote.status === 'completed') {
      try {
        const stored = await completeExternal(context, envelope);
        return { status: 'completed' as const, signedDocumentId: stored.nodeId };
      } catch (error) {
        // Let the next sync retry the download.
        await context.db.transaction((tx) =>
          tx.update(
            'envelopes',
            { id: envelope.id, tenantId: envelope.tenantId },
            { status: 'sent', completedAt: null, syncedAt: null, updatedAt: context.now },
          ),
        );
        throw error;
      }
    }
    await evidence(context, envelope, {
      type: remote.status === 'voided' ? 'envelope.voided' : 'envelope.declined',
      actor: provider.id,
      ...(remote.reason ? { detail: { reason: remote.reason } } : {}),
    });
    context.emit(remote.status === 'voided' ? 'esign.voided' : 'esign.declined', {
      envelopeId: envelope.id,
      provider: provider.id,
    });
    return { status: remote.status };
  }

  const view = (
    envelope: Envelope,
    recipients: readonly EnvelopeRecipient[],
    fields?: readonly EnvelopeField[],
  ) => ({
    ...envelope,
    recipients: recipients.map(
      ({ tokenHash: _hash, tokenExpiresAt: _expires, ...recipient }) => recipient,
    ),
    ...(fields ? { fields } : {}),
  });

  return definePlugin({
    id: 'esign',
    actions: [SEND, SIGN_PUBLIC],
    accessModel: [{ relations: ['owner', 'admin', 'publisher', 'editor'], actions: [SEND] }],
    schema: {
      envelopes: defineTable({
        fields: {
          roomId: field.string(),
          documentId: field.string(),
          versionId: field.string(),
          title: field.string(),
          message: field.string({ required: false }),
          status: field.enum(['draft', 'sent', 'completed', 'voided', 'declined'] as const),
          routing: field.enum(['parallel', 'sequential'] as const),
          originalSha256: field.string(),
          finalSha256: field.string({ required: false }),
          signedDocumentId: field.string({ required: false }),
          createdBy: field.string(),
          sentAt: field.timestamp({ required: false }),
          completedAt: field.timestamp({ required: false }),
          voidedAt: field.timestamp({ required: false }),
          voidReason: field.string({ required: false }),
          evidenceHead: field.string({ required: false }),
          evidenceSequence: field.number(),
          provider: field.string({ required: false }),
          externalId: field.string({ required: false }),
          syncedAt: field.timestamp({ required: false }),
          updatedAt: field.timestamp(),
        },
        indexes: [{ fields: ['tenantId', 'roomId'] }, { fields: ['tenantId', 'externalId'] }],
      }),
      envelopeRecipients: defineTable({
        fields: {
          envelopeId: field.string(),
          email: field.string(),
          name: field.string(),
          role: field.enum(['signer', 'approver', 'cc'] as const),
          order: field.number(),
          status: field.enum(['pending', 'sent', 'viewed', 'signed', 'declined'] as const),
          tokenHash: field.string({ required: false, unique: true }),
          tokenExpiresAt: field.timestamp({ required: false }),
          viewedAt: field.timestamp({ required: false }),
          signedAt: field.timestamp({ required: false }),
          declinedAt: field.timestamp({ required: false }),
          declineReason: field.string({ required: false }),
          signatureName: field.string({ required: false }),
          ip: field.string({ required: false }),
          userAgent: field.string({ required: false }),
        },
        indexes: [{ fields: ['tenantId', 'envelopeId'] }],
      }),
      envelopeFields: defineTable({
        fields: {
          envelopeId: field.string(),
          recipientId: field.string(),
          type: field.enum(['signature', 'initials', 'date', 'text', 'checkbox'] as const),
          page: field.number(),
          x: field.number(),
          y: field.number(),
          width: field.number(),
          height: field.number(),
          required: field.boolean(),
          value: field.string({ required: false }),
        },
        indexes: [{ fields: ['tenantId', 'envelopeId'] }],
      }),
      envelopeEvents: defineTable({
        fields: {
          envelopeId: field.string(),
          sequence: field.number(),
          type: field.string(),
          actor: field.string(),
          ip: field.string({ required: false }),
          userAgent: field.string({ required: false }),
          detail: field.json<Record<string, unknown>>({ required: false }),
          previousHash: field.string({ required: false }),
          hash: field.string(),
        },
        indexes: [{ fields: ['tenantId', 'envelopeId', 'sequence'], unique: true }],
      }),
    },
    endpoints: {
      /** Prepares an envelope over the document's current version (a PDF). */
      create: endpoint({
        operation: { action: SEND, target: 'node', capabilities: ['VIEW'], mutates: false },
        input: v.object({
          nodeId: v.id(),
          title: v.optional(v.string({ min: 1, max: 200 })),
          message: v.optional(v.string({ max: 2000 })),
          routing: v.optional(v.enum(['parallel', 'sequential'] as const)),
          recipients: v.array(
            v.object({
              email: v.string({ min: 3, max: 320, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ }),
              name: v.string({ min: 1, max: 200 }),
              role: v.optional(v.enum(['signer', 'approver', 'cc'] as const)),
              order: v.optional(v.number({ int: true, min: 1, max: 100 })),
            }),
            { min: 1, max: 50 },
          ),
          fields: v.array(
            v.object({
              recipient: v.number({ int: true, min: 0, max: 49 }),
              type: v.enum(['signature', 'initials', 'date', 'text', 'checkbox'] as const),
              page: v.number({ int: true, min: 1 }),
              x: v.number({ min: 0 }),
              y: v.number({ min: 0 }),
              width: v.number({ min: 4, max: 2000 }),
              height: v.number({ min: 4, max: 2000 }),
              required: v.optional(v.boolean()),
            }),
            { max: 500 },
          ),
        }),
        target: (input) => ({ nodeId: input.nodeId }),
        async handler(context, input) {
          const node = context.node!;
          if (node.kind !== 'document')
            throw new BetterFilesError('INVALID_INPUT', 'Only documents can be signed');
          const document = await context.db.findOne<DataRoomDocument>('documents', {
            id: node.id,
            tenantId: context.tenantId,
          });
          const version = document?.currentVersionId
            ? await context.db.findOne<DocumentVersion>('versions', {
                id: document.currentVersionId,
                tenantId: context.tenantId,
              })
            : null;
          if (!version || version.status !== 'ready')
            throw new BetterFilesError('CONFLICT', 'The document has no signable version');
          const bytes = await readAll(await context.readVersion(version.id));
          let pages: { width: number; height: number }[];
          try {
            pages = await describePdf(bytes);
          } catch {
            throw new BetterFilesError('INVALID_INPUT', 'Only PDF documents can be signed');
          }
          for (const f of input.fields) {
            const page = pages[f.page - 1];
            if (!page)
              throw new BetterFilesError('INVALID_INPUT', `The document has no page ${f.page}`);
            if (f.x + f.width > page.width || f.y + f.height > page.height)
              throw new BetterFilesError('INVALID_INPUT', `A field falls outside page ${f.page}`);
            if (!input.recipients[f.recipient])
              throw new BetterFilesError('INVALID_INPUT', `No recipient ${f.recipient}`);
            if (input.recipients[f.recipient]!.role === 'cc')
              throw new BetterFilesError('INVALID_INPUT', 'cc recipients have no fields');
          }
          const signers = input.recipients.filter((r) => (r.role ?? 'signer') !== 'cc');
          if (signers.length === 0)
            throw new BetterFilesError('INVALID_INPUT', 'An envelope needs at least one signer');
          const envelope: Envelope = {
            id: prefixedId('env', context.now),
            tenantId: context.tenantId,
            roomId: node.roomId,
            documentId: node.id,
            versionId: version.id,
            title: input.title ?? node.name,
            ...(input.message ? { message: input.message } : {}),
            status: 'draft',
            routing: input.routing ?? 'parallel',
            originalSha256: version.sha256 ?? sha256(bytes),
            createdBy: context.principal.id,
            evidenceSequence: 0,
            updatedAt: context.now,
            createdAt: context.now,
          };
          const recipients: EnvelopeRecipient[] = input.recipients.map((r, index) => ({
            id: prefixedId('rcp', context.now),
            tenantId: context.tenantId,
            envelopeId: envelope.id,
            email: r.email.toLowerCase(),
            name: r.name,
            role: r.role ?? 'signer',
            order: r.order ?? index + 1,
            status: 'pending',
            createdAt: context.now,
          }));
          const fields: EnvelopeField[] = input.fields.map((f) => ({
            id: prefixedId('fld', context.now),
            tenantId: context.tenantId,
            envelopeId: envelope.id,
            recipientId: recipients[f.recipient]!.id,
            type: f.type,
            page: f.page,
            x: f.x,
            y: f.y,
            width: f.width,
            height: f.height,
            required: f.required ?? f.type !== 'checkbox',
            createdAt: context.now,
          }));
          await context.db.transaction(async (tx) => {
            await tx.insert('envelopes', envelope);
            for (const recipient of recipients) await tx.insert('envelopeRecipients', recipient);
            for (const f of fields) await tx.insert('envelopeFields', f);
          });
          await evidence(context, envelope, {
            type: 'envelope.created',
            actor: context.principal.email ?? context.principal.id,
            detail: { originalSha256: envelope.originalSha256 },
          });
          return view(envelope, recipients, fields);
        },
      }),
      send: endpoint({
        operation: { action: SEND, target: 'room', mutates: false },
        input: v.object({ envelopeId: v.id() }),
        target: envelopeTarget,
        async handler(context, input) {
          const envelope = await context.db.findOne<Envelope>('envelopes', {
            id: input.envelopeId,
            tenantId: context.tenantId,
          });
          if (!envelope) throw notFound('Envelope');
          if (envelope.status !== 'draft')
            throw new BetterFilesError('CONFLICT', `The envelope is ${envelope.status}`);
          const recipients = await context.db.findMany<EnvelopeRecipient>('envelopeRecipients', {
            where: { tenantId: context.tenantId, envelopeId: envelope.id },
          });
          // With a provider, the provider emails the recipients; only a successful hand-off marks it sent.
          const external = provider ? await sendExternal(context, envelope, recipients) : undefined;
          const marked = await context.db.transaction(async (tx) => {
            const changed = await tx.update(
              'envelopes',
              { id: envelope.id, tenantId: context.tenantId, status: 'draft' },
              {
                status: 'sent',
                sentAt: context.now,
                updatedAt: context.now,
                ...(external ? { provider: provider!.id, externalId: external.externalId } : {}),
              },
            );
            if (changed > 0 && external)
              for (const recipient of recipients)
                await tx.update(
                  'envelopeRecipients',
                  { id: recipient.id, tenantId: context.tenantId },
                  { status: 'sent' },
                );
            return changed;
          });
          if (marked === 0) {
            // Someone else sent it meanwhile; withdraw the duplicate at the provider.
            if (external) await provider!.void(external.externalId, 'Sent twice').catch(() => {});
            throw new BetterFilesError('CONFLICT', 'The envelope was sent meanwhile');
          }
          const sent: Envelope = {
            ...envelope,
            status: 'sent',
            sentAt: context.now,
            ...(external ? { provider: provider!.id, externalId: external.externalId } : {}),
          };
          await evidence(context, sent, {
            type: 'envelope.sent',
            actor: context.principal.email ?? context.principal.id,
            ...(external
              ? { detail: { provider: provider!.id, externalId: external.externalId } }
              : {}),
          });
          if (!external) await issueTokens(context, sent, currentTurn(sent, recipients), 'sign');
          await context.activity({
            roomId: envelope.roomId,
            action: 'esign.sent',
            nodeId: envelope.documentId,
            metadata: { envelopeId: envelope.id, recipients: recipients.length },
          });
          context.emit('esign.sent', { envelopeId: envelope.id, nodeId: envelope.documentId });
          return { sent: true as const };
        },
      }),
      list: endpoint({
        operation: { action: SEND, target: 'room', mutates: false, allowClosed: true },
        input: v.object({
          roomId: v.id(),
          status: v.optional(v.enum(['draft', 'sent', 'completed', 'voided', 'declined'] as const)),
        }),
        target: (input) => ({ roomId: input.roomId }),
        async handler(context, input) {
          const envelopes = await context.db.findMany<Envelope>('envelopes', {
            where: {
              tenantId: context.tenantId,
              roomId: context.room!.id,
              ...(input.status ? { status: input.status } : {}),
            },
            orderBy: [{ field: 'createdAt', direction: 'desc' }],
          });
          const recipients = envelopes.length
            ? await context.db.findMany<EnvelopeRecipient>('envelopeRecipients', {
                where: {
                  tenantId: context.tenantId,
                  envelopeId: { in: envelopes.map((e) => e.id) },
                },
              })
            : [];
          return envelopes.map((envelope) =>
            view(
              envelope,
              recipients.filter((r) => r.envelopeId === envelope.id),
            ),
          );
        },
      }),
      get: endpoint({
        operation: { action: SEND, target: 'room', mutates: false, allowClosed: true },
        input: v.object({ envelopeId: v.id() }),
        target: envelopeTarget,
        async handler(context, input) {
          const envelope = await context.db.findOne<Envelope>('envelopes', {
            id: input.envelopeId,
            tenantId: context.tenantId,
          });
          if (!envelope) throw notFound('Envelope');
          const [recipients, fields, events] = await Promise.all([
            context.db.findMany<EnvelopeRecipient>('envelopeRecipients', {
              where: { tenantId: context.tenantId, envelopeId: envelope.id },
              orderBy: [{ field: 'order' }],
            }),
            context.db.findMany<EnvelopeField>('envelopeFields', {
              where: { tenantId: context.tenantId, envelopeId: envelope.id },
            }),
            context.db.findMany<EvidenceEvent>('envelopeEvents', {
              where: { tenantId: context.tenantId, envelopeId: envelope.id },
              orderBy: [{ field: 'sequence' }],
            }),
          ]);
          return {
            ...view(envelope, recipients, fields),
            events,
            verification: await verifyEvidence(context, context.tenantId, envelope.id),
          };
        },
      }),
      void: endpoint({
        operation: { action: SEND, target: 'room', mutates: false, allowClosed: true },
        input: v.object({ envelopeId: v.id(), reason: v.string({ min: 1, max: 500 }) }),
        target: envelopeTarget,
        async handler(context, input) {
          const envelope = await context.db.findOne<Envelope>('envelopes', {
            id: input.envelopeId,
            tenantId: context.tenantId,
          });
          if (!envelope) throw notFound('Envelope');
          if (envelope.status !== 'draft' && envelope.status !== 'sent')
            throw new BetterFilesError('CONFLICT', `The envelope is ${envelope.status}`);
          if (
            envelope.createdBy !== context.principal.id &&
            !(await context.authorize('better-files:admin'))
          )
            throw forbidden();
          // Withdraw it at the provider first: a void that only happened here would leave it signable there.
          if (envelope.status === 'sent' && envelope.externalId) {
            if (!provider || provider.id !== envelope.provider)
              throw invalidConfig(
                `Configure the ${envelope.provider} provider to void this envelope`,
              );
            await provider.void(envelope.externalId, input.reason);
          }
          await context.db.transaction(async (tx) => {
            await tx.update(
              'envelopes',
              { id: envelope.id, tenantId: context.tenantId },
              {
                status: 'voided',
                voidedAt: context.now,
                voidReason: input.reason,
                updatedAt: context.now,
              },
            );
            // Outstanding links stop working at once.
            for (const recipient of await tx.findMany<EnvelopeRecipient>('envelopeRecipients', {
              where: { tenantId: context.tenantId, envelopeId: envelope.id },
            }))
              await tx.update(
                'envelopeRecipients',
                { id: recipient.id, tenantId: context.tenantId },
                { tokenHash: null, tokenExpiresAt: null },
              );
          });
          await evidence(context, envelope, {
            type: 'envelope.voided',
            actor: context.principal.email ?? context.principal.id,
            detail: { reason: input.reason },
          });
          context.emit('esign.voided', { envelopeId: envelope.id });
          return { voided: true as const };
        },
      }),
      remind: endpoint({
        operation: { action: SEND, target: 'room', mutates: false },
        input: v.object({ envelopeId: v.id() }),
        target: envelopeTarget,
        async handler(context, input) {
          const envelope = await context.db.findOne<Envelope>('envelopes', {
            id: input.envelopeId,
            tenantId: context.tenantId,
          });
          if (!envelope || envelope.status !== 'sent')
            throw new BetterFilesError('CONFLICT', 'Only sent envelopes can be reminded');
          const recipients = await context.db.findMany<EnvelopeRecipient>('envelopeRecipients', {
            where: { tenantId: context.tenantId, envelopeId: envelope.id },
          });
          const turn = currentTurn(envelope, recipients);
          if (envelope.externalId) {
            if (!provider || provider.id !== envelope.provider)
              throw invalidConfig(
                `Configure the ${envelope.provider} provider to remind recipients`,
              );
            await provider.remind(
              envelope.externalId,
              turn.map((r) => r.email),
            );
            await evidence(context, envelope, {
              type: 'recipient.reminded',
              actor: context.principal.email ?? context.principal.id,
              detail: { provider: provider.id, emails: turn.map((r) => r.email) },
            });
          } else await issueTokens(context, envelope, turn, 'reminder');
          return { reminded: turn.length };
        },
      }),
      /**
       * Public: reads a provider envelope's state and applies it (progress, completion with the sealed PDF stored in
       * the room, decline, void). `esignWebhook()` calls it with the provider's id for the envelope, which also lifts
       * the throttle; anyone else is limited to one provider read per `syncIntervalMs`. Never trusts its caller.
       */
      sync: endpoint({
        operation: { action: SIGN_PUBLIC, target: 'public', mutates: false },
        input: v.object({
          envelopeId: v.id(),
          externalId: v.optional(v.string({ min: 1, max: 200 })),
        }),
        async handler(context, input) {
          const envelope = await context.db.findOne<Envelope>('envelopes', {
            id: input.envelopeId,
            tenantId: context.tenantId,
          });
          if (
            !envelope ||
            (input.externalId !== undefined && input.externalId !== envelope.externalId)
          )
            throw notFound('Envelope');
          return syncEnvelope(context, envelope, input.externalId === undefined);
        },
      }),

      /** Public: what a recipient sees when they open their signing link. */
      open: endpoint({
        operation: { action: SIGN_PUBLIC, target: 'public', mutates: false },
        input: v.object({ token: v.string({ min: 10, max: 200 }) }),
        async handler(context, input) {
          const { envelope, recipient } = await byToken(context, input.token);
          const recipients = await context.db.findMany<EnvelopeRecipient>('envelopeRecipients', {
            where: { tenantId: context.tenantId, envelopeId: envelope.id },
          });
          const yourTurn = currentTurn(envelope, recipients).some((r) => r.id === recipient.id);
          if (recipient.status !== 'viewed' && recipient.status !== 'signed') {
            await context.db.transaction((tx) =>
              tx.update(
                'envelopeRecipients',
                { id: recipient.id, tenantId: context.tenantId },
                { status: 'viewed', viewedAt: context.now },
              ),
            );
            await evidence(context, envelope, {
              type: 'recipient.viewed',
              actor: recipient.email,
              ...(context.request?.ip ? { ip: context.request.ip } : {}),
              ...(context.request?.userAgent ? { userAgent: context.request.userAgent } : {}),
            });
          }
          const fields = await context.db.findMany<EnvelopeField>('envelopeFields', {
            where: {
              tenantId: context.tenantId,
              envelopeId: envelope.id,
              recipientId: recipient.id,
            },
          });
          const document = await context.issueTicket({
            documentId: envelope.documentId,
            versionId: envelope.versionId,
            variant: 'original',
            disposition: 'inline',
            recipient: {
              id: `esign:${recipient.id}`,
              name: recipient.name,
              email: recipient.email,
            },
          });
          return {
            envelope: {
              id: envelope.id,
              title: envelope.title,
              ...(envelope.message ? { message: envelope.message } : {}),
              routing: envelope.routing,
            },
            recipient: {
              name: recipient.name,
              email: recipient.email,
              role: recipient.role,
              status: recipient.status === 'sent' ? 'viewed' : recipient.status,
            },
            yourTurn,
            fields: fields.map(({ tenantId: _t, envelopeId: _e, ...f }) => f),
            document,
          };
        },
      }),
      /** Public: signs (or approves) with a typed name and the field values. */
      sign: endpoint({
        operation: { action: SIGN_PUBLIC, target: 'public', mutates: false },
        input: v.object({
          token: v.string({ min: 10, max: 200 }),
          signatureName: v.string({ min: 1, max: 200, trim: true }),
          consent: v.literal(true),
          values: v.optional(
            v.record(v.string({ max: 2000 }), { maxKeys: 500, key: /^fld_[0-9A-Z]{26}$/ }),
          ),
        }),
        async handler(context, input) {
          const { envelope, recipient } = await byToken(context, input.token);
          if (recipient.role === 'cc' || recipient.status === 'signed')
            throw new BetterFilesError('CONFLICT', 'Nothing to sign');
          const recipients = await context.db.findMany<EnvelopeRecipient>('envelopeRecipients', {
            where: { tenantId: context.tenantId, envelopeId: envelope.id },
          });
          if (!currentTurn(envelope, recipients).some((r) => r.id === recipient.id))
            throw new BetterFilesError(
              'CONFLICT',
              'Other recipients sign first; you will be notified',
            );
          const fields = await context.db.findMany<EnvelopeField>('envelopeFields', {
            where: {
              tenantId: context.tenantId,
              envelopeId: envelope.id,
              recipientId: recipient.id,
            },
          });
          const values = input.values ?? {};
          const date = new Date(context.now).toISOString().slice(0, 10);
          const initials = input.signatureName
            .split(/\s+/)
            .map((part) => part[0]?.toUpperCase() ?? '')
            .join('');
          const resolved = fields.map((f) => {
            const given = values[f.id];
            const value =
              f.type === 'signature'
                ? input.signatureName
                : f.type === 'initials'
                  ? initials
                  : f.type === 'date'
                    ? date
                    : f.type === 'checkbox'
                      ? String(given === 'true')
                      : given;
            if (
              f.required &&
              (value === undefined || value === '' || (f.type === 'checkbox' && value !== 'true'))
            )
              throw new BetterFilesError('INVALID_INPUT', 'Complete every required field', {
                details: { fieldId: f.id },
              });
            return { id: f.id, value: value ?? '' };
          });
          await context.db.transaction(async (tx) => {
            for (const f of resolved)
              await tx.update(
                'envelopeFields',
                { id: f.id, tenantId: context.tenantId },
                { value: f.value },
              );
            await tx.update(
              'envelopeRecipients',
              { id: recipient.id, tenantId: context.tenantId },
              {
                status: 'signed',
                signedAt: context.now,
                signatureName: input.signatureName,
                tokenHash: null,
                tokenExpiresAt: null,
                ...(context.request?.ip ? { ip: context.request.ip } : {}),
                ...(context.request?.userAgent
                  ? { userAgent: context.request.userAgent.slice(0, 256) }
                  : {}),
              },
            );
          });
          await evidence(context, envelope, {
            type: recipient.role === 'approver' ? 'recipient.approved' : 'recipient.signed',
            actor: recipient.email,
            ...(context.request?.ip ? { ip: context.request.ip } : {}),
            ...(context.request?.userAgent ? { userAgent: context.request.userAgent } : {}),
            detail: { signatureName: input.signatureName, consent: true },
          });
          const updated = recipients.map((r) =>
            r.id === recipient.id ? { ...r, status: 'signed' as const } : r,
          );
          const remaining = currentTurn(envelope, updated);
          if (remaining.length === 0) {
            const stored = await finalize(context, envelope);
            return { status: 'completed' as const, signedDocumentId: stored.nodeId };
          }
          // Sequential routing: invite the next group once this one is done.
          if (envelope.routing === 'sequential') {
            const fresh = remaining.filter((r) => r.status === 'pending');
            if (fresh.length) await issueTokens(context, envelope, fresh, 'sign');
          }
          context.emit('esign.signed', { envelopeId: envelope.id, email: recipient.email });
          return { status: 'signed' as const };
        },
      }),
      decline: endpoint({
        operation: { action: SIGN_PUBLIC, target: 'public', mutates: false },
        input: v.object({
          token: v.string({ min: 10, max: 200 }),
          reason: v.string({ min: 1, max: 1000 }),
        }),
        async handler(context, input) {
          const { envelope, recipient } = await byToken(context, input.token);
          await context.db.transaction(async (tx) => {
            await tx.update(
              'envelopeRecipients',
              { id: recipient.id, tenantId: context.tenantId },
              {
                status: 'declined',
                declinedAt: context.now,
                declineReason: input.reason,
                tokenHash: null,
                tokenExpiresAt: null,
              },
            );
            await tx.update(
              'envelopes',
              { id: envelope.id, tenantId: context.tenantId },
              { status: 'declined', updatedAt: context.now },
            );
          });
          await evidence(context, envelope, {
            type: 'recipient.declined',
            actor: recipient.email,
            ...(context.request?.ip ? { ip: context.request.ip } : {}),
            detail: { reason: input.reason },
          });
          context.emit('esign.declined', { envelopeId: envelope.id, email: recipient.email });
          return { declined: true as const };
        },
      }),
    },
  });
}

/** The part of a `betterFiles()` instance `esignWebhook` needs. */
export interface EsignWebhookTarget {
  api: {
    esign: {
      sync(
        credential: Record<string, never>,
        input: { tenantId: string; envelopeId: string; externalId?: string },
      ): Promise<unknown>;
    };
  };
}

/**
 * A fetch handler for the provider's webhook (DocuSign Connect, Dropbox Sign callbacks): verifies the signature, then
 * syncs each envelope it names from the provider's API. Mount it on a route of your app:
 *
 * ```ts
 * const webhook = esignWebhook(dr, provider);
 * export const POST = (request: Request) => webhook(request); // app/api/esign/webhook/route.ts
 * ```
 *
 * Unsigned requests get 401. A failed sync answers 500, so the provider retries later.
 */
export function esignWebhook(
  dr: EsignWebhookTarget,
  provider: EsignProvider,
  options: { onError?: (error: unknown) => void } = {},
): (request: Request) => Promise<Response> {
  return async (request) => {
    let parsed: Awaited<ReturnType<EsignProvider['parseWebhook']>>;
    try {
      parsed = await provider.parseWebhook(request);
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      return new Response(code === 'UNAUTHENTICATED' ? 'Unauthorized' : 'Bad request', {
        status: code === 'UNAUTHENTICATED' ? 401 : 400,
      });
    }
    const seen = new Set<string>();
    let failed = false;
    for (const event of parsed.events) {
      if (!event.tenantId || !event.envelopeId) continue;
      const key = `${event.tenantId}:${event.envelopeId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        await dr.api.esign.sync(
          {},
          { tenantId: event.tenantId, envelopeId: event.envelopeId, externalId: event.externalId },
        );
      } catch (error) {
        // Envelopes this app does not know (sent from elsewhere, or deleted) are not worth a retry.
        if ((error as { code?: unknown })?.code === 'NOT_FOUND') continue;
        failed = true;
        options.onError?.(error);
      }
    }
    return failed
      ? new Response('Sync failed', { status: 500 })
      : new Response(parsed.reply ?? 'OK', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        });
  };
}
