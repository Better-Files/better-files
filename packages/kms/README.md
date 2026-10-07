# @better-files/kms

Bring-your-own-key providers for Better Files. Every stored file is encrypted with its own data key, and
these providers wrap those keys with a key that lives in your cloud KMS, so the host's database and storage never
hold a usable key. They talk to each service over `fetch`, with no cloud SDKs.

| Provider        | Service                                 | Context binding                     |
| --------------- | --------------------------------------- | ----------------------------------- |
| `awsKms`        | AWS KMS (`GenerateDataKey`, `Decrypt`)  | KMS encryption context (CloudTrail) |
| `gcpKms`        | Google Cloud KMS (`encrypt`, `decrypt`) | Additional authenticated data       |
| `azureKeyVault` | Azure Key Vault or Managed HSM          | HKDF of the wrapped seed            |
| `vaultTransit`  | HashiCorp Vault or OpenBao Transit      | HKDF of the wrapped seed            |

Each data key is bound to its blob's encryption context (tenant, room, blob), so a wrapped key copied onto another
file does not decrypt it.

```ts
import { betterFiles } from 'better-files';
import { awsKms, cachingKeys } from 'better-files/kms';

export const dr = betterFiles({
  // …
  encryption: {
    keys: awsKms({
      region: 'eu-west-1',
      keyId: 'alias/better-files',
      credentials: () => loadAwsCredentials(), // static keys, or a function for STS/IMDS credentials
      perRoomKeys: true, // a KMS key per room: deleting the room destroys its files
    }),
  },
});
```

```ts
gcpKms({
  keyName: 'projects/acme/locations/europe-west1/keyRings/better-files/cryptoKeys/default',
  accessToken: () => googleAuth.getAccessToken(), // google-auth-library
});

azureKeyVault({
  vaultUrl: 'https://acme.vault.azure.net',
  keyName: 'better-files',
  accessToken: async () => (await credential.getToken('https://vault.azure.net/.default')).token,
});

vaultTransit({
  address: 'https://vault.acme.internal:8200',
  token: () => readVaultToken(),
  keyName: 'better-files',
});
```

## Keys per room

With `perRoomKeys`, creating a room creates a key for it, and deleting the room retires that key: AWS schedules
deletion (`pendingWindowInDays`, default 7), Cloud KMS destroys every version, Azure deletes the key (recoverable
during soft delete) and Vault allows deletion and deletes it. Once the key is gone, the room's stored files cannot
be decrypted even from backups. Providers never retire the shared default key.

The credentials need permission to create and retire keys only when `perRoomKeys` is on. Otherwise they need only:

- AWS: `kms:GenerateDataKey` and `kms:Decrypt` on the key;
- Cloud KMS: `roles/cloudkms.cryptoKeyEncrypterDecrypter`;
- Azure: the `wrapKey` and `unwrapKey` key permissions (Key Vault Crypto User);
- Vault: `update` on `transit/datakey/plaintext/<key>` and `transit/decrypt/<key>`.

## Moving between providers

Stored files keep the key reference that wrapped them, and references are namespaced (`aws-kms:…`, `gcp-kms:…`,
`azure-kv:…`, `vault:…`). `migratingKeys` switches an installation to a new provider without re-encrypting
anything: new files use `current`, and existing files go back to whichever provider wrapped them.

```ts
encryption: {
  keys: migratingKeys({
    current: awsKms({ … }),
    previous: [localKeyProvider({ secret: process.env.BETTER_FILES_SECRET! })],
  }),
}
```

## Keys in the room's region

With data residency (`regionalStorage`), rooms are created in a region. `regionalKeys` keeps each room's keys in
that region's KMS too:

```ts
encryption: {
  keys: regionalKeys({
    regions: {
      eu: awsKms({ region: 'eu-central-1', keyId: 'alias/better-files', credentials, perRoomKeys: true }),
      us: awsKms({ region: 'us-east-1', keyId: 'alias/better-files', credentials, perRoomKeys: true }),
    },
    defaultRegion: 'eu',
  }),
}
```

Every room's key reference starts with its region (`region:eu:…`), even when the regional provider has no keys per
room, so wraps and unwraps always go to the same region. Creating a room in a region with no provider fails rather
than using another region's key. References made before `regionalKeys` belong to `defaultRegion`.

## Caching unwrapped keys

Streaming a popular document calls the KMS on every request. `cachingKeys(provider, { maxAgeMs, maxEntries })`
keeps unwrapped data keys in memory for a while (default 5 minutes, 1000 keys). It saves KMS cost and latency, but
plaintext keys stay in process memory, and revoking access in the KMS takes effect only after `maxAgeMs`.

## Errors and retries

Throttling and server errors (HTTP 429 and 5xx, and AWS `ThrottlingException`) are retried twice with jittered
backoff (`retries`). Other failures throw `KmsHttpError`, a `BetterFilesError` with `status` and the service's
`kmsCode`. Key references are checked before any request: a reference outside the configured vault or key ring is
refused, so a tampered database row cannot send a bearer token to another host.
