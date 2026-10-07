import { createHash } from 'node:crypto';
import { s3Storage, signHeaders, type AwsCredentials } from '@better-files/storage-s3';

/**
 * Settings for the tests that need real backing services (`tests/docker/compose.yml`). Each service is optional: a
 * test that needs one is skipped unless its variable is set, so `pnpm check` stays self-contained.
 */

export const postgresUrl = process.env.BETTER_FILES_POSTGRES_URL;

const s3Endpoint = process.env.BETTER_FILES_S3_ENDPOINT;
const s3Bucket = process.env.BETTER_FILES_S3_BUCKET ?? 'better-files-test';
const s3Region = process.env.BETTER_FILES_S3_REGION ?? 'us-east-1';
// The defaults are the throwaway MinIO credentials in compose.yml.
const s3Credentials: AwsCredentials = {
  accessKeyId: process.env.BETTER_FILES_S3_ACCESS_KEY ?? 'better-files',
  secretAccessKey: process.env.BETTER_FILES_S3_SECRET_KEY ?? 'better-files-test-secret',
};

export const s3Configured = s3Endpoint !== undefined;

/** An S3 adapter on a fresh key prefix, so each test starts from an empty store without deleting anything. */
export function realS3(label: string) {
  if (!s3Endpoint) throw new Error('BETTER_FILES_S3_ENDPOINT is not set');
  return s3Storage({
    bucket: s3Bucket,
    region: s3Region,
    endpoint: s3Endpoint,
    credentials: s3Credentials,
    prefix: `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}/${label}`,
  });
}

/** Creates the test bucket if it is missing (S3 `CreateBucket`; "already owned by you" counts as success). */
export async function ensureBucket(): Promise<void> {
  if (!s3Endpoint) return;
  const url = new URL(`${s3Endpoint.replace(/\/$/, '')}/${encodeURIComponent(s3Bucket)}`);
  const date = new Date();
  const payloadHash = createHash('sha256').update('').digest('hex');
  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-date': date.toISOString().replace(/[:-]|\.\d{3}/g, ''),
    'x-amz-content-sha256': payloadHash,
  };
  const authorization = signHeaders({
    method: 'PUT',
    path: url.pathname,
    headers,
    payloadHash,
    region: s3Region,
    credentials: s3Credentials,
    date,
  });
  const { host: _host, ...sent } = headers;
  const response = await fetch(url, { method: 'PUT', headers: { ...sent, authorization } });
  if (response.ok) return;
  const body = await response.text();
  if (response.status === 409 && body.includes('BucketAlreadyOwnedByYou')) return;
  throw new Error(`Could not create bucket ${s3Bucket}: ${response.status} ${body.slice(0, 200)}`);
}
