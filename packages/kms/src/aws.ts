import { createHash } from 'node:crypto';
import { BetterFilesError } from '@better-files/core';
import { awsCredentials, signHeaders, type AwsCredentials } from '@better-files/storage-s3';
import {
  fromBase64,
  keyRefs,
  KmsHttpError,
  requestJson,
  requireOption,
  type KmsKeyProvider,
} from './shared.js';

export interface AwsKmsOptions {
  region: string;
  /** Key id, ARN or `alias/…` that wraps data keys for rooms without a key of their own. */
  keyId: string;
  /** Default `awsCredentials()`: environment, web identity, container role or EC2 instance role. */
  credentials?: AwsCredentials | (() => Promise<AwsCredentials>);
  /** A VPC endpoint or a local emulator. Default `https://kms.{region}.amazonaws.com`. */
  endpoint?: string;
  /**
   * A KMS key per room, so deleting the room destroys its files (crypto-shredding). Each key is billed monthly, so
   * this is off by default. `pendingWindowInDays` (7–30, default 7) is how long a deleted room's key can be recovered.
   */
  perRoomKeys?:
    | boolean
    | { pendingWindowInDays?: number; tags?: Record<string, string>; policy?: string };
  fetch?: typeof fetch;
  /** Retries for throttling and server errors. Default 2. */
  retries?: number;
}

const amzDate = (date: Date) => date.toISOString().replace(/[:-]|\.\d{3}/g, '');

/**
 * AWS KMS as the key provider, over SigV4 and `fetch` (no AWS SDK). Data keys come from `GenerateDataKey` and are
 * bound to the blob's encryption context, which CloudTrail records on every decrypt.
 */
export function awsKms(options: AwsKmsOptions): KmsKeyProvider {
  const region = requireOption(options.region, 'awsKms: region');
  const defaultKey = requireOption(options.keyId, 'awsKms: keyId');
  const endpoint = new URL(options.endpoint ?? `https://kms.${region}.amazonaws.com/`);
  const refs = keyRefs('aws-kms');
  const perRoom =
    options.perRoomKeys === true ? {} : options.perRoomKeys ? options.perRoomKeys : undefined;
  const http = {
    provider: 'AWS KMS',
    fetch: options.fetch,
    retries: options.retries,
    retryCodes: ['ThrottlingException', 'KMSInternalException', 'DependencyTimeoutException'],
  };

  const source = options.credentials ?? awsCredentials();

  async function call<T>(action: string, payload: unknown): Promise<T> {
    const body = JSON.stringify(payload);
    return requestJson<T>(
      http,
      endpoint,
      async () => {
        const credentials = typeof source === 'function' ? await source() : source;
        const date = new Date();
        const headers: Record<string, string> = {
          host: endpoint.host,
          'content-type': 'application/x-amz-json-1.1',
          'x-amz-date': amzDate(date),
          'x-amz-target': `TrentService.${action}`,
          ...(credentials.sessionToken ? { 'x-amz-security-token': credentials.sessionToken } : {}),
        };
        const authorization = signHeaders({
          method: 'POST',
          path: endpoint.pathname || '/',
          headers,
          payloadHash: createHash('sha256').update(body).digest('hex'),
          region,
          service: 'kms',
          credentials,
          date,
        });
        delete headers.host;
        return { method: 'POST', headers: { ...headers, authorization }, body };
      },
      (_status, error) => {
        const e = (error ?? {}) as { __type?: string; message?: string; Message?: string };
        return {
          ...(e.__type ? { code: e.__type.split('#').pop()! } : {}),
          ...((e.message ?? e.Message) ? { message: (e.message ?? e.Message)! } : {}),
        };
      },
    );
  }

  const provider: KmsKeyProvider = {
    id: 'aws-kms',
    owns: refs.owns,
    async generateDataKey({ keyRef, context }) {
      const keyId = keyRef && refs.owns(keyRef) ? refs.read(keyRef) : defaultKey;
      const result = await call<{ CiphertextBlob?: string; Plaintext?: string; KeyId?: string }>(
        'GenerateDataKey',
        { KeyId: keyId, KeySpec: 'AES_256', EncryptionContext: context },
      );
      if (!result?.Plaintext || !result.CiphertextBlob)
        throw new BetterFilesError('INTERNAL_ERROR', 'AWS KMS returned no data key');
      return {
        plaintext: fromBase64(result.Plaintext),
        wrapped: result.CiphertextBlob,
        keyRef: refs.make(result.KeyId ?? keyId),
      };
    },
    async decryptDataKey({ keyRef, wrapped, context }) {
      const result = await call<{ Plaintext?: string }>('Decrypt', {
        KeyId: refs.read(keyRef),
        CiphertextBlob: wrapped,
        EncryptionContext: context,
      });
      if (!result?.Plaintext)
        throw new BetterFilesError('INTERNAL_ERROR', 'AWS KMS returned no data key');
      return fromBase64(result.Plaintext);
    },
  };
  if (!perRoom) return provider;

  return {
    ...provider,
    async createRoomKey({ tenantId, roomId }) {
      const tags = { 'better-files': 'room', tenantId, roomId, ...perRoom.tags };
      const created = await call<{ KeyMetadata?: { Arn?: string; KeyId?: string } }>('CreateKey', {
        Description: `Better Files room ${roomId}`,
        KeyUsage: 'ENCRYPT_DECRYPT',
        KeySpec: 'SYMMETRIC_DEFAULT',
        Tags: Object.entries(tags).map(([TagKey, TagValue]) => ({ TagKey, TagValue })),
        ...(perRoom.policy ? { Policy: perRoom.policy } : {}),
      });
      const id = created?.KeyMetadata?.Arn ?? created?.KeyMetadata?.KeyId;
      if (!id) throw new BetterFilesError('INTERNAL_ERROR', 'AWS KMS returned no key');
      return refs.make(id);
    },
    async retireRoomKey({ keyRef }) {
      if (!refs.owns(keyRef)) return;
      try {
        await call('ScheduleKeyDeletion', {
          KeyId: refs.read(keyRef),
          PendingWindowInDays: perRoom.pendingWindowInDays ?? 7,
        });
      } catch (error) {
        // Already gone, or already pending deletion.
        if (
          error instanceof KmsHttpError &&
          (error.kmsCode === 'NotFoundException' || error.kmsCode === 'KMSInvalidStateException')
        )
          return;
        throw error;
      }
    },
  };
}
