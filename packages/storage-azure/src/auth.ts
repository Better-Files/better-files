import { createHmac } from 'node:crypto';
import { invalidConfig } from '@better-files/core';

/** The REST API version every request and SAS uses. */
export const AZURE_STORAGE_VERSION = '2023-11-03';

/**
 * The Shared Key `Authorization` header for a Blob service request (version 2015-02-21 and later), as described in
 * "Authorize with Shared Key". `headers` must hold every header that will be sent, lower-cased, including
 * `x-ms-date` and `x-ms-version`; `url` is the exact request URL.
 */
export function sharedKeyAuthorization(input: {
  account: string;
  accountKey: string;
  method: string;
  url: URL;
  headers: Record<string, string>;
}): string {
  const header = (name: string) => input.headers[name] ?? '';
  const contentLength = header('content-length');
  const canonicalHeaders = Object.keys(input.headers)
    .filter((name) => name.startsWith('x-ms-'))
    .sort()
    .map((name) => `${name}:${input.headers[name]!.replace(/\s+/g, ' ').trim()}\n`)
    .join('');
  const params = new Map<string, string[]>();
  for (const [name, value] of input.url.searchParams) {
    const key = name.toLowerCase();
    params.set(key, [...(params.get(key) ?? []), value]);
  }
  const canonicalResource =
    `/${input.account}${input.url.pathname}` +
    [...params.keys()]
      .sort()
      .map((name) => `\n${name}:${params.get(name)!.sort().join(',')}`)
      .join('');
  const stringToSign = [
    input.method.toUpperCase(),
    header('content-encoding'),
    header('content-language'),
    contentLength === '0' ? '' : contentLength,
    header('content-md5'),
    header('content-type'),
    '', // Date: x-ms-date is used instead
    header('if-modified-since'),
    header('if-match'),
    header('if-none-match'),
    header('if-unmodified-since'),
    header('range'),
    canonicalHeaders + canonicalResource,
  ].join('\n');
  const signature = createHmac('sha256', Buffer.from(input.accountKey, 'base64'))
    .update(stringToSign, 'utf8')
    .digest('base64');
  return `SharedKey ${input.account}:${signature}`;
}

const sasTime = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * A service SAS for one blob (`sr=b`), signed with the account key. `permissions` uses the SAS letters in their
 * canonical order: `r` read, `a` add, `c` create, `w` write, `d` delete. The SAS is returned as a query string
 * without the leading `?`.
 */
export function blobSas(input: {
  account: string;
  accountKey: string;
  container: string;
  blob: string;
  permissions: string;
  expiresOn: Date;
  startsOn?: Date;
  /** `https` (the default) or `https,http` for local emulators. */
  protocol?: 'https' | 'https,http';
  version?: string;
}): string {
  if (!/^r?a?c?w?d?$/.test(input.permissions) || !input.permissions)
    throw invalidConfig('SAS permissions must be a subset of "racwd", in that order');
  const version = input.version ?? AZURE_STORAGE_VERSION;
  const protocol = input.protocol ?? 'https';
  const start = input.startsOn ? sasTime(input.startsOn) : '';
  const expiry = sasTime(input.expiresOn);
  const stringToSign = [
    input.permissions,
    start,
    expiry,
    `/blob/${input.account}/${input.container}/${input.blob}`,
    '', // signed identifier
    '', // signed IP
    protocol,
    version,
    'b', // signed resource
    '', // snapshot time
    '', // encryption scope
    '', // rscc
    '', // rscd
    '', // rsce
    '', // rscl
    '', // rsct
  ].join('\n');
  const signature = createHmac('sha256', Buffer.from(input.accountKey, 'base64'))
    .update(stringToSign, 'utf8')
    .digest('base64');
  const query = new URLSearchParams({ sv: version, ...(start ? { st: start } : {}), se: expiry });
  query.set('sr', 'b');
  query.set('sp', input.permissions);
  query.set('spr', protocol);
  query.set('sig', signature);
  return query.toString();
}

/** What `parseConnectionString` returns: the options `azureBlobStorage` needs, minus the container. */
export interface AzureConnection {
  account: string;
  endpoint: string;
  credentials: { accountKey: string } | { sasToken: string };
}

/**
 * Reads an Azure Storage connection string (`DefaultEndpointsProtocol=…;AccountName=…;AccountKey=…`), including
 * `UseDevelopmentStorage=true` for Azurite and `BlobEndpoint` / `SharedAccessSignature` forms.
 */
export function parseConnectionString(connectionString: string): AzureConnection {
  const fields = new Map<string, string>();
  for (const part of connectionString.split(';')) {
    const at = part.indexOf('=');
    if (at > 0) fields.set(part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim());
  }
  if (fields.get('usedevelopmentstorage') === 'true')
    return {
      account: 'devstoreaccount1',
      endpoint: 'http://127.0.0.1:10000/devstoreaccount1',
      credentials: {
        // Azurite's published well-known development key.
        accountKey:
          'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==',
      },
    };
  const sas = fields.get('sharedaccesssignature');
  const accountKey = fields.get('accountkey');
  const blobEndpoint = fields.get('blobendpoint');
  let account = fields.get('accountname');
  if (!account && blobEndpoint) account = new URL(blobEndpoint).hostname.split('.')[0];
  if (!account) throw invalidConfig('The connection string has no AccountName');
  const endpoint =
    blobEndpoint ??
    `${fields.get('defaultendpointsprotocol') ?? 'https'}://${account}.blob.${fields.get('endpointsuffix') ?? 'core.windows.net'}`;
  if (accountKey) return { account, endpoint, credentials: { accountKey } };
  if (sas) return { account, endpoint, credentials: { sasToken: sas } };
  throw invalidConfig('The connection string has neither AccountKey nor SharedAccessSignature');
}
