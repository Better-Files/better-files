# @better-files/storage-azure

Azure Blob Storage adapter for Better Files. It uses block blobs over `fetch`, signs Shared Key requests and service SAS URLs itself, and needs no Azure SDK.

Part of [Better Files](../../README.md). Most applications install `better-files` and import this package as `better-files/storage-azure`.

```ts
import { azureBlobStorage, parseConnectionString } from 'better-files/storage-azure';

const storage = azureBlobStorage({
  ...parseConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING!),
  container: 'better-files',
});
```

**Credentials**

- `{ accountKey }`: Shared Key auth. It also enables service SAS URLs, which `presign` and direct uploads use.
- `{ sasToken }`: a container or account SAS with read, create, write and delete rights.
- `{ accessToken }`: a Microsoft Entra ID token for `https://storage.azure.com/`, or a function that returns one (managed identity, `@azure/identity`). The identity needs **Storage Blob Data Contributor**.

With either of the last two, the adapter cannot presign, so direct uploads are unavailable and uploads go through the server.

`parseConnectionString` reads the account-key, SAS, `BlobEndpoint` and `UseDevelopmentStorage=true` (Azurite) forms.

**Multipart uploads**

- Each part is a `Put Block`. The block id is derived from the upload id and the part number, never from the caller.
- `complete` commits the blocks with `Put Block List`.
- Azure cannot discard staged blocks, so `abort` leaves them. They never become visible, and the service drops them after seven days.

**Copies.** A `Copy Blob` that reports `pending` is polled until it succeeds. The wait is bounded by `copyTimeoutMs`.

**Direct uploads.** The container's CORS rules must allow `PUT` from your app's origin and expose `Content-MD5`. `Put Block` answers without an `ETag`, so the client sends this checksum instead.

Signatures are cross-checked against `@azure/storage-blob` in the test suite.
