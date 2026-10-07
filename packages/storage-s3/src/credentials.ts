import { readFile } from 'node:fs/promises';
import { BetterFilesError, invalidConfig } from '@better-files/core';
import type { AwsCredentials } from './sigv4.js';

export interface AwsCredentialsOptions {
  /** Environment variables to read. Default `process.env`. */
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  now?: () => number;
  /** Refresh temporary credentials this long before they expire. Default 5 minutes. */
  refreshBeforeMs?: number;
  /** Reads token files (web identity, Pod Identity). Default `fs.readFile`. */
  readFile?: (path: string) => Promise<string>;
}

interface Expiring {
  credentials: AwsCredentials;
  expiresAt?: number;
}

const tag = (xml: string, name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1];

/** Container credential endpoints may use plain HTTP only on these hosts (as the AWS SDKs require). */
const CONTAINER_HOSTS = new Set([
  '169.254.170.2',
  '169.254.170.23',
  '[fd00:ec2::23]',
  '127.0.0.1',
  '[::1]',
  'localhost',
]);

/**
 * The AWS SDK's default credential chain without the SDK, for `s3Storage` and `awsKms` on AWS hosts:
 *
 * 1. `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`;
 * 2. web identity (EKS IAM roles for service accounts): `AWS_WEB_IDENTITY_TOKEN_FILE` and `AWS_ROLE_ARN`, exchanged
 *    with STS `AssumeRoleWithWebIdentity`;
 * 3. container credentials (ECS task roles, EKS Pod Identity): `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` or
 *    `_FULL_URI`, with `AWS_CONTAINER_AUTHORIZATION_TOKEN[_FILE]`;
 * 4. the EC2 instance role through IMDSv2 (unless `AWS_EC2_METADATA_DISABLED=true`).
 *
 * Temporary credentials are cached until shortly before they expire, and concurrent callers share one refresh.
 */
export function awsCredentials(options: AwsCredentialsOptions = {}): () => Promise<AwsCredentials> {
  const env = options.env ?? process.env;
  const doFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const refreshBefore = options.refreshBeforeMs ?? 5 * 60_000;
  const read = options.readFile ?? ((path: string) => readFile(path, 'utf8'));
  let cached: Expiring | undefined;
  let pending: Promise<AwsCredentials> | undefined;

  const fail = (source: string, detail: string): never => {
    throw new BetterFilesError(
      'INTERNAL_ERROR',
      `AWS credentials from ${source} failed: ${detail}`,
    );
  };
  const expiry = (value: string | undefined) => (value ? Date.parse(value) : undefined);

  async function webIdentity(): Promise<Expiring> {
    const token = (await read(env.AWS_WEB_IDENTITY_TOKEN_FILE!)).trim();
    const region = env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
    const endpoint = region ? `https://sts.${region}.amazonaws.com/` : 'https://sts.amazonaws.com/';
    const response = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        Action: 'AssumeRoleWithWebIdentity',
        Version: '2011-06-15',
        RoleArn: env.AWS_ROLE_ARN!,
        RoleSessionName: env.AWS_ROLE_SESSION_NAME ?? `better-files-${now()}`,
        WebIdentityToken: token,
      }),
    });
    const xml = await response.text();
    if (!response.ok) fail('web identity', `${response.status} ${tag(xml, 'Code') ?? ''}`.trim());
    const accessKeyId = tag(xml, 'AccessKeyId');
    const secretAccessKey = tag(xml, 'SecretAccessKey');
    if (!accessKeyId || !secretAccessKey) fail('web identity', 'no credentials in the response');
    const sessionToken = tag(xml, 'SessionToken');
    const expiresAt = expiry(tag(xml, 'Expiration'));
    return {
      credentials: {
        accessKeyId: accessKeyId!,
        secretAccessKey: secretAccessKey!,
        ...(sessionToken ? { sessionToken } : {}),
      },
      ...(expiresAt ? { expiresAt } : {}),
    };
  }

  const fromJson = (source: string, body: Record<string, string | undefined>): Expiring => {
    if (!body.AccessKeyId || !body.SecretAccessKey) fail(source, 'no credentials in the response');
    const expiresAt = expiry(body.Expiration);
    return {
      credentials: {
        accessKeyId: body.AccessKeyId!,
        secretAccessKey: body.SecretAccessKey!,
        ...(body.Token ? { sessionToken: body.Token } : {}),
      },
      ...(expiresAt ? { expiresAt } : {}),
    };
  };

  async function container(): Promise<Expiring> {
    const url = env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
      ? new URL(`http://169.254.170.2${env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI}`)
      : new URL(env.AWS_CONTAINER_CREDENTIALS_FULL_URI!);
    if (
      url.protocol !== 'https:' &&
      !CONTAINER_HOSTS.has(url.hostname) &&
      !CONTAINER_HOSTS.has(url.host)
    )
      throw invalidConfig(
        'AWS_CONTAINER_CREDENTIALS_FULL_URI must use https or a link-local container host',
      );
    const authorization = env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE
      ? (await read(env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE)).trim()
      : env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
    const response = await doFetch(url, {
      headers: authorization ? { authorization } : {},
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) fail('the container endpoint', String(response.status));
    return fromJson('the container endpoint', (await response.json()) as Record<string, string>);
  }

  async function instance(): Promise<Expiring> {
    const base = (env.AWS_EC2_METADATA_SERVICE_ENDPOINT ?? 'http://169.254.169.254').replace(
      /\/+$/,
      '',
    );
    const signal = () => AbortSignal.timeout(2000);
    const tokenResponse = await doFetch(`${base}/latest/api/token`, {
      method: 'PUT',
      headers: { 'x-aws-ec2-metadata-token-ttl-seconds': '21600' },
      signal: signal(),
    }).catch(() => undefined);
    if (!tokenResponse?.ok)
      throw invalidConfig(
        'No AWS credentials found: set AWS_ACCESS_KEY_ID, run with a web identity or container role, or on EC2 with an instance role',
      );
    const headers = { 'x-aws-ec2-metadata-token': await tokenResponse.text() };
    const path = `${base}/latest/meta-data/iam/security-credentials/`;
    const roles = await doFetch(path, { headers, signal: signal() });
    const role = (await roles.text()).split('\n')[0]?.trim();
    if (!roles.ok || !role) fail('the instance metadata service', 'no instance role');
    const response = await doFetch(path + encodeURIComponent(role!), { headers, signal: signal() });
    if (!response.ok) fail('the instance metadata service', String(response.status));
    return fromJson(
      'the instance metadata service',
      (await response.json()) as Record<string, string>,
    );
  }

  async function resolve(): Promise<Expiring> {
    if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY)
      return {
        credentials: {
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
          ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
        },
      };
    if (env.AWS_WEB_IDENTITY_TOKEN_FILE && env.AWS_ROLE_ARN) return webIdentity();
    if (env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || env.AWS_CONTAINER_CREDENTIALS_FULL_URI)
      return container();
    if (env.AWS_EC2_METADATA_DISABLED?.toLowerCase() === 'true')
      throw invalidConfig(
        'No AWS credentials found, and the instance metadata service is disabled',
      );
    return instance();
  }

  return async () => {
    if (cached && (cached.expiresAt === undefined || now() < cached.expiresAt - refreshBefore))
      return cached.credentials;
    pending ??= resolve()
      .then((resolved) => {
        cached = resolved;
        return resolved.credentials;
      })
      .finally(() => (pending = undefined));
    return pending;
  };
}
