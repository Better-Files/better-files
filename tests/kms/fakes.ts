import {
  constants,
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  randomUUID,
} from 'node:crypto';

/**
 * In-memory stand-ins for AWS KMS, Cloud KMS, Azure Key Vault and Vault Transit, served through the providers'
 * `fetch` option. They do real cryptography and refuse a wrong encryption context, so the tests catch a provider
 * that forgets to bind it.
 */

export interface Recorded {
  method: string;
  url: URL;
  headers: Headers;
  body: any;
}

function json(status: number, body: unknown): Response {
  if (status === 204) return new Response(null, { status });
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function seal(key: Buffer, plaintext: Buffer, aad?: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(aad);
  return Buffer.concat([iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function open(key: Buffer, sealed: Buffer, aad?: Buffer): Buffer | undefined {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
    if (aad) decipher.setAAD(aad);
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    return Buffer.concat([
      decipher.update(sealed.subarray(12, sealed.length - 16)),
      decipher.final(),
    ]);
  } catch {
    return undefined;
  }
}

function recorder() {
  const requests: Recorded[] = [];
  let failures: { status: number; body: unknown }[] = [];
  return {
    requests,
    /** The next requests fail with these responses, in order. */
    failNext(...responses: { status: number; body: unknown }[]) {
      failures = responses;
    },
    async take(input: RequestInfo | URL, init?: RequestInit): Promise<Recorded | Response> {
      const url = new URL(String(input));
      const text = typeof init?.body === 'string' ? init.body : '';
      const recorded = {
        method: init?.method ?? 'GET',
        url,
        headers: new Headers(init?.headers),
        body: text ? JSON.parse(text) : undefined,
      };
      requests.push(recorded);
      const failure = failures.shift();
      return failure ? json(failure.status, failure.body) : recorded;
    },
  };
}

// ─── AWS KMS ─────────────────────────────────────────────────────────────────────────────────────

export function fakeAwsKms(region = 'eu-west-1') {
  const rec = recorder();
  const keys = new Map<string, { material: Buffer; pending: boolean }>();
  const aliases = new Map<string, string>();
  const create = () => {
    const arn = `arn:aws:kms:${region}:111122223333:key/${randomUUID()}`;
    keys.set(arn, { material: randomBytes(32), pending: false });
    return arn;
  };
  const defaultKey = create();
  aliases.set('alias/better-files', defaultKey);
  const resolve = (id: string) =>
    aliases.get(id) ?? [...keys.keys()].find((arn) => arn === id || arn.endsWith(`/${id}`));
  const aad = (context: Record<string, string>) =>
    Buffer.from(JSON.stringify(Object.entries(context ?? {}).sort()));
  const error = (type: string, message = '') => json(400, { __type: type, message });

  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const r = await rec.take(input, init);
    if (r instanceof Response) return r;
    const auth = r.headers.get('authorization') ?? '';
    if (!new RegExp(`Credential=AKID/\\d{8}/${region}/kms/aws4_request`).test(auth))
      return error('IncompleteSignatureException');
    const action = r.headers.get('x-amz-target')?.replace('TrentService.', '');
    const body = r.body;
    switch (action) {
      case 'GenerateDataKey': {
        const arn = resolve(body.KeyId);
        const key = arn ? keys.get(arn) : undefined;
        if (!arn || !key) return error('NotFoundException');
        if (key.pending) return error('KMSInvalidStateException');
        const plaintext = randomBytes(32);
        const blob = Buffer.concat([
          Buffer.from(arn.padEnd(128)),
          seal(key.material, plaintext, aad(body.EncryptionContext)),
        ]);
        return json(200, {
          KeyId: arn,
          Plaintext: plaintext.toString('base64'),
          CiphertextBlob: blob.toString('base64'),
        });
      }
      case 'Decrypt': {
        const blob = Buffer.from(body.CiphertextBlob, 'base64');
        const arn = blob.subarray(0, 128).toString().trim();
        if (body.KeyId && resolve(body.KeyId) !== arn) return error('IncorrectKeyException');
        const key = keys.get(arn);
        if (!key) return error('NotFoundException');
        if (key.pending) return error('KMSInvalidStateException');
        const plaintext = open(key.material, blob.subarray(128), aad(body.EncryptionContext));
        if (!plaintext) return error('InvalidCiphertextException');
        return json(200, { KeyId: arn, Plaintext: plaintext.toString('base64') });
      }
      case 'CreateKey':
        return json(200, { KeyMetadata: { Arn: create(), Description: body.Description } });
      case 'ScheduleKeyDeletion': {
        const arn = resolve(body.KeyId);
        const key = arn ? keys.get(arn) : undefined;
        if (!key) return error('NotFoundException');
        if (key.pending) return error('KMSInvalidStateException');
        key.pending = true;
        return json(200, { KeyId: arn });
      }
      default:
        return error('UnknownOperationException');
    }
  };
  return { fetch: fetch as typeof globalThis.fetch, keys, defaultKey, ...rec };
}

// ─── Google Cloud KMS ────────────────────────────────────────────────────────────────────────────

export const GCP_RING = 'projects/acme/locations/europe-west1/keyRings/better-files';

export function fakeGcpKms(token = 'gcp-token') {
  const rec = recorder();
  const keys = new Map<string, { versions: { material: Buffer; state: string }[] }>();
  keys.set(`${GCP_RING}/cryptoKeys/default`, {
    versions: [{ material: randomBytes(32), state: 'ENABLED' }],
  });
  const error = (status: number, code: string) =>
    json(status, { error: { status: code, message: code } });

  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const r = await rec.take(input, init);
    if (r instanceof Response) return r;
    if (r.headers.get('authorization') !== `Bearer ${token}`) return error(401, 'UNAUTHENTICATED');
    const path = decodeURIComponent(r.url.pathname.replace(/^\/v1\//, ''));
    let match: RegExpExecArray | null;
    if ((match = /^(.+\/cryptoKeys\/[^/:]+):(encrypt|decrypt)$/.exec(path))) {
      const key = keys.get(match[1]!);
      if (!key) return error(404, 'NOT_FOUND');
      const aad = Buffer.from(r.body.additionalAuthenticatedData ?? '', 'base64');
      if (match[2] === 'encrypt') {
        const index = key.versions.length - 1;
        const version = key.versions[index]!;
        if (version.state !== 'ENABLED') return error(400, 'FAILED_PRECONDITION');
        const sealed = seal(version.material, Buffer.from(r.body.plaintext, 'base64'), aad);
        return json(200, {
          name: `${match[1]}/cryptoKeyVersions/${index + 1}`,
          ciphertext: Buffer.concat([Buffer.from([index]), sealed]).toString('base64'),
        });
      }
      const blob = Buffer.from(r.body.ciphertext, 'base64');
      const version = key.versions[blob[0]!];
      if (!version || version.state !== 'ENABLED') return error(400, 'FAILED_PRECONDITION');
      const plaintext = open(version.material, blob.subarray(1), aad);
      if (!plaintext) return error(400, 'INVALID_ARGUMENT');
      return json(200, { plaintext: plaintext.toString('base64') });
    }
    if ((match = /^(.+\/keyRings\/[^/]+)\/cryptoKeys$/.exec(path)) && r.method === 'POST') {
      const name = `${match[1]}/cryptoKeys/${r.url.searchParams.get('cryptoKeyId')}`;
      if (keys.has(name)) return error(409, 'ALREADY_EXISTS');
      keys.set(name, { versions: [{ material: randomBytes(32), state: 'ENABLED' }] });
      return json(200, { name });
    }
    if ((match = /^(.+\/cryptoKeys\/[^/]+)\/cryptoKeyVersions$/.exec(path))) {
      const key = keys.get(match[1]!);
      if (!key) return error(404, 'NOT_FOUND');
      return json(200, {
        cryptoKeyVersions: key.versions.map((v, i) => ({
          name: `${match![1]}/cryptoKeyVersions/${i + 1}`,
          state: v.state,
        })),
      });
    }
    if ((match = /^(.+\/cryptoKeys\/[^/]+)\/cryptoKeyVersions\/(\d+):destroy$/.exec(path))) {
      const version = keys.get(match[1]!)?.versions[Number(match[2]) - 1];
      if (!version) return error(404, 'NOT_FOUND');
      version.state = 'DESTROY_SCHEDULED';
      return json(200, {});
    }
    return error(404, 'NOT_FOUND');
  };
  return { fetch: fetch as typeof globalThis.fetch, keys, ...rec };
}

// ─── Azure Key Vault ─────────────────────────────────────────────────────────────────────────────

export const AZURE_VAULT = 'https://acme.vault.azure.net';

export function fakeAzureKeyVault(token = 'azure-token') {
  const rec = recorder();
  type Version = {
    id: string;
    publicKey: ReturnType<typeof generateKeyPairSync>['publicKey'];
    privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
  };
  const keys = new Map<string, { versions: Version[]; deleted: boolean }>();
  const addVersion = (name: string) => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const entry = keys.get(name) ?? { versions: [], deleted: false };
    entry.versions.push({ id: randomUUID().replace(/-/g, ''), ...pair });
    keys.set(name, entry);
  };
  addVersion('better-files');
  const error = (status: number, code: string) => json(status, { error: { code, message: code } });

  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const r = await rec.take(input, init);
    if (r instanceof Response) return r;
    if (r.headers.get('authorization') !== `Bearer ${token}`) return error(401, 'Unauthorized');
    if (r.url.searchParams.get('api-version') !== '7.4') return error(400, 'BadParameter');
    const match =
      /^\/keys\/([0-9A-Za-z-]+)(?:\/([0-9a-f]{32}))?(?:\/(wrapkey|unwrapkey|create))?$/.exec(
        r.url.pathname,
      );
    if (!match) return error(404, 'NotFound');
    const [, name, versionId, op] = match;
    if (op === 'create') {
      addVersion(name!);
      return json(200, {
        key: { kid: `${AZURE_VAULT}/keys/${name}/${keys.get(name!)!.versions.at(-1)!.id}` },
      });
    }
    const key = keys.get(name!);
    if (!key || key.deleted) return error(404, 'KeyNotFound');
    if (r.method === 'DELETE') {
      key.deleted = true;
      return json(200, {});
    }
    const version = versionId ? key.versions.find((v) => v.id === versionId) : key.versions.at(-1);
    if (!version) return error(404, 'KeyNotFound');
    if (r.body?.alg !== 'RSA-OAEP-256') return error(400, 'BadParameter');
    const oaep = { padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' };
    if (op === 'wrapkey')
      return json(200, {
        kid: `${AZURE_VAULT}/keys/${name}/${version.id}`,
        value: publicEncrypt(
          { key: version.publicKey, ...oaep },
          Buffer.from(r.body.value, 'base64url'),
        ).toString('base64url'),
      });
    if (op === 'unwrapkey') {
      try {
        return json(200, {
          kid: `${AZURE_VAULT}/keys/${name}/${version.id}`,
          value: privateDecrypt(
            { key: version.privateKey, ...oaep },
            Buffer.from(r.body.value, 'base64url'),
          ).toString('base64url'),
        });
      } catch {
        return error(400, 'BadParameter');
      }
    }
    return error(404, 'NotFound');
  };
  return { fetch: fetch as typeof globalThis.fetch, keys, rotate: addVersion, ...rec };
}

// ─── Vault Transit ───────────────────────────────────────────────────────────────────────────────

export const VAULT_ADDRESS = 'https://vault.acme.test:8200';

export function fakeVaultTransit(token = 'hvs.token') {
  const rec = recorder();
  const keys = new Map<string, { material: Buffer; deletionAllowed: boolean }>();
  keys.set('better-files', { material: randomBytes(32), deletionAllowed: false });
  const error = (status: number, message: string) => json(status, { errors: [message] });

  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const r = await rec.take(input, init);
    if (r instanceof Response) return r;
    if (r.headers.get('x-vault-token') !== token) return error(403, 'permission denied');
    const match =
      /^\/v1\/transit\/(datakey\/plaintext|decrypt|keys)\/([A-Za-z0-9_.-]+)(\/config)?$/.exec(
        r.url.pathname,
      );
    if (!match) return error(404, 'unsupported path');
    const [, op, name, config] = match;
    const key = keys.get(name!);
    if (op === 'keys') {
      if (config) {
        if (!key) return error(404, 'no such key');
        key.deletionAllowed = r.body.deletion_allowed === true;
        return json(204, {});
      }
      if (r.method === 'DELETE') {
        if (!key) return error(404, 'no such key');
        if (!key.deletionAllowed) return error(400, 'deletion is not allowed for this key');
        keys.delete(name!);
        return json(204, {});
      }
      if (!key) keys.set(name!, { material: randomBytes(32), deletionAllowed: false });
      return json(200, {});
    }
    if (!key) return error(400, 'encryption key not found');
    if (op === 'datakey/plaintext') {
      const plaintext = randomBytes(r.body.bits / 8);
      return json(200, {
        data: {
          plaintext: plaintext.toString('base64'),
          ciphertext: `vault:v1:${seal(key.material, plaintext).toString('base64')}`,
        },
      });
    }
    const plaintext = open(key.material, Buffer.from(String(r.body.ciphertext).slice(9), 'base64'));
    if (!plaintext) return error(400, 'cipher: message authentication failed');
    return json(200, { data: { plaintext: plaintext.toString('base64') } });
  };
  return { fetch: fetch as typeof globalThis.fetch, keys, ...rec };
}
