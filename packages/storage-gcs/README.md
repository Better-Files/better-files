# @better-files/storage-gcs

Google Cloud Storage adapter for Better Files. It talks to the JSON API over `fetch`, so it needs no Google SDK. It also mints service-account tokens and signs V4 URLs itself.

Part of [Better Files](../../README.md). Most applications install `better-files` and import this package as `better-files/storage-gcs`.

```ts
import { gcsStorage } from 'better-files/storage-gcs';

const storage = gcsStorage({
  bucket: 'my-app-better-files',
  // The parsed JSON key file. It also enables signed URLs, which direct uploads need.
  credentials: { serviceAccount: JSON.parse(process.env.GCS_KEY!) },
  prefix: 'better-files', // optional: share the bucket with other apps
});
```

**Credentials**

- `{ serviceAccount }`: tokens come from the JWT bearer grant and are cached until a minute before they expire. Signed URLs (`presign`, `multipart.presignPart`) are signed locally with `GOOG4-RSA-SHA256`.
- `{ accessToken }`: a token string, or a function that returns one. Use this for workload identity or `google-auth-library`. The adapter then has no signed URLs, so direct uploads are unavailable and uploads go through the server.

The identity needs `roles/storage.objectUser` on the bucket.

**Multipart uploads.** The JSON API has no S3-style multipart upload, so the adapter:

- stores each part as a temporary object under `.better-files-multipart/{uploadId}/`;
- joins the parts with `compose`, 32 at a time, pinning each part's generation so a replaced part fails the upload;
- deletes the temporary parts afterwards.

Add a lifecycle rule that deletes objects under that prefix after a few days. It cleans up uploads that were abandoned without an abort.

**Direct uploads.** The bucket's CORS configuration must allow `PUT` from your app's origin and expose `ETag`.

**Emulators.** Set `endpoint` (for example `http://localhost:4443` for fake-gcs-server) and pass any `accessToken`.
