import { readFile } from 'node:fs/promises';
import { BetterFilesError, invalidConfig } from '@better-files/core';

interface TokenOptions {
  /** Environment variables to read. Default `process.env`. */
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  now?: () => number;
  /** Refresh tokens this long before they expire. Default 5 minutes. */
  refreshBeforeMs?: number;
}

/** Caches a token until shortly before it expires; concurrent callers share one request. */
function cachedToken(
  options: TokenOptions,
  mint: () => Promise<{ token: string; expiresAt: number }>,
): () => Promise<string> {
  const now = options.now ?? Date.now;
  const refreshBefore = options.refreshBeforeMs ?? 5 * 60_000;
  let cached: { token: string; expiresAt: number } | undefined;
  let pending: Promise<string> | undefined;
  return async () => {
    if (cached && now() < cached.expiresAt - refreshBefore) return cached.token;
    pending ??= mint()
      .then((minted) => {
        cached = minted;
        return minted.token;
      })
      .finally(() => (pending = undefined));
    return pending;
  };
}

async function tokenResponse(source: string, response: Response) {
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number | string;
    expires_on?: number | string;
    error?: string;
  };
  if (!response.ok || !body.access_token)
    throw new BetterFilesError(
      'INTERNAL_ERROR',
      `Token request to ${source} failed: ${response.status}${body.error ? ` ${body.error}` : ''}`,
    );
  return body as typeof body & { access_token: string };
}

export interface GcpMetadataTokenOptions extends TokenOptions {
  /** OAuth scopes. Default `https://www.googleapis.com/auth/cloud-platform`. */
  scopes?: string[];
  /** The attached service account. Default `default`. */
  serviceAccount?: string;
}

/**
 * Access tokens for the service account attached to a Google Cloud host (GCE, GKE Workload Identity, Cloud Run,
 * Cloud Functions), from the metadata server. Pass it as `gcpKms({ accessToken: gcpMetadataToken() })`.
 */
export function gcpMetadataToken(options: GcpMetadataTokenOptions = {}): () => Promise<string> {
  const env = options.env ?? process.env;
  const doFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const host = env.GCE_METADATA_HOST ?? 'metadata.google.internal';
  const account = encodeURIComponent(options.serviceAccount ?? 'default');
  const scopes = (options.scopes ?? ['https://www.googleapis.com/auth/cloud-platform']).join(',');
  return cachedToken(options, async () => {
    const response = await doFetch(
      `http://${host}/computeMetadata/v1/instance/service-accounts/${account}/token?scopes=${encodeURIComponent(scopes)}`,
      { headers: { 'metadata-flavor': 'Google' }, signal: AbortSignal.timeout(5000) },
    );
    const body = await tokenResponse('the GCP metadata server', response);
    return { token: body.access_token, expiresAt: now() + Number(body.expires_in ?? 3600) * 1000 };
  });
}

export interface AzureIdentityTokenOptions extends TokenOptions {
  /** The resource the token is for. Default `https://vault.azure.net` (Key Vault); Managed HSM uses `https://managedhsm.azure.net`. */
  resource?: string;
  /** A user-assigned identity's client id. Default `AZURE_CLIENT_ID`, else the system-assigned identity. */
  clientId?: string;
  readFile?: (path: string) => Promise<string>;
}

/**
 * Microsoft Entra tokens for the identity an Azure host runs as, without @azure/identity:
 *
 * 1. AKS workload identity (`AZURE_FEDERATED_TOKEN_FILE`, `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`);
 * 2. App Service and Functions managed identity (`IDENTITY_ENDPOINT`, `IDENTITY_HEADER`);
 * 3. the VM / VM scale set managed identity through the instance metadata service.
 *
 * Pass it as `azureKeyVault({ accessToken: azureIdentityToken() })`.
 */
export function azureIdentityToken(options: AzureIdentityTokenOptions = {}): () => Promise<string> {
  const env = options.env ?? process.env;
  const doFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const read = options.readFile ?? ((path: string) => readFile(path, 'utf8'));
  const resource = (options.resource ?? 'https://vault.azure.net').replace(/\/+$/, '');
  const clientId = options.clientId ?? env.AZURE_CLIENT_ID;
  const expiresAt = (body: { expires_in?: number | string; expires_on?: number | string }) =>
    body.expires_on !== undefined && /^\d+$/.test(String(body.expires_on))
      ? Number(body.expires_on) * 1000
      : now() + Number(body.expires_in ?? 3600) * 1000;

  return cachedToken(options, async () => {
    if (env.AZURE_FEDERATED_TOKEN_FILE) {
      if (!clientId || !env.AZURE_TENANT_ID)
        throw invalidConfig('Workload identity needs AZURE_CLIENT_ID and AZURE_TENANT_ID');
      const authority = (env.AZURE_AUTHORITY_HOST ?? 'https://login.microsoftonline.com').replace(
        /\/+$/,
        '',
      );
      const response = await doFetch(
        `${authority}/${encodeURIComponent(env.AZURE_TENANT_ID)}/oauth2/v2.0/token`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId,
            scope: `${resource}/.default`,
            grant_type: 'client_credentials',
            client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
            client_assertion: (await read(env.AZURE_FEDERATED_TOKEN_FILE)).trim(),
          }),
        },
      );
      const body = await tokenResponse('Microsoft Entra', response);
      return { token: body.access_token, expiresAt: expiresAt(body) };
    }
    const query = new URLSearchParams({ resource, ...(clientId ? { client_id: clientId } : {}) });
    if (env.IDENTITY_ENDPOINT && env.IDENTITY_HEADER) {
      query.set('api-version', '2019-08-01');
      const response = await doFetch(`${env.IDENTITY_ENDPOINT}?${query}`, {
        headers: { 'x-identity-header': env.IDENTITY_HEADER },
        signal: AbortSignal.timeout(5000),
      });
      const body = await tokenResponse('the App Service identity endpoint', response);
      return { token: body.access_token, expiresAt: expiresAt(body) };
    }
    query.set('api-version', '2018-02-01');
    const response = await doFetch(
      `http://169.254.169.254/metadata/identity/oauth2/token?${query}`,
      {
        headers: { metadata: 'true' },
        signal: AbortSignal.timeout(5000),
      },
    ).catch(() => {
      throw invalidConfig(
        'No Azure identity found: run with workload identity, an App Service identity or a VM managed identity',
      );
    });
    const body = await tokenResponse('the Azure instance metadata service', response);
    return { token: body.access_token, expiresAt: expiresAt(body) };
  });
}
