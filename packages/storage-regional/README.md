# @better-files/storage-regional

Data residency for Better Files: each room's files are stored in that room's region.

Part of [Better Files](../../README.md). Most applications install `better-files` and import this package through `better-files/storage-regional`.

```ts
import { regionalStorage } from 'better-files/storage-regional';
import { s3Storage } from 'better-files/storage-s3';

const dr = betterFiles({
  // …
  storage: regionalStorage({
    regions: {
      eu: s3Storage({ region: 'eu-central-1', bucket: 'rooms-eu' /* … */ }),
      us: s3Storage({ region: 'us-east-1', bucket: 'rooms-us' /* … */ }),
    },
    // A name, or one per tenant.
    defaultRegion: ({ tenantId }) => contracts.regionOf(tenantId) ?? 'eu',
    // Where files stored before residency was turned on live.
    unplacedRegion: 'eu',
    // Optional: which regions a tenant may choose.
    allows: ({ tenantId, region }) => contracts.allows(tenantId, region),
  }),
});

await dr.api.rooms.create(credential, { tenantId, name: 'Project Alpine', region: 'eu' });
```

- A room gets its region when it is created: the `region` input, or `defaultRegion`. An unknown region is
  `INVALID_INPUT` and one `allows` refuses is `FORBIDDEN`. With a storage adapter that is not regional, asking for a
  region is `UNSUPPORTED`.
- Keys of the room's files start with `g/{region}/`, so the router needs no lookups. Each region's adapter receives the
  key without that prefix. Keys with no prefix go to `unplacedRegion`.
- The key provider's `createRoomKey` receives the region, so per-room keys can be created in that region's KMS:
  `regionalKeys({ regions: { eu: awsKms(…), us: awsKms(…) }, defaultRegion: 'eu' })` from
  `@better-files/kms` does this.
- Multipart uploads, direct uploads (`presignPart`) and `presign` are available when every region's adapter supports
  them.

## Moving a room

```ts
import { moveRoom } from 'better-files/storage-regional';

const result = await moveRoom({ database, storage, tenantId, roomId, to: 'us' });
// { from: 'eu', to: 'us', moved: 120, skipped: 0, pendingUploads: 0 }
```

`moveRoom` first points the room at the new region, so new uploads go there. It then copies every stored object (all
versions and renditions), checks the size, repoints the blob and deletes the old copy (`deleteSource: false` keeps
it). It is safe to interrupt and run again, because objects already in the target region are skipped. Uploads still
open when it runs finish in the old region and are counted in `pendingUploads`. Run it again once they finish.

Run it from a maintenance script or a job, with the same `database` and `storage` given to `betterFiles()`. Wrapped
data keys stay valid, since they do not depend on the storage key. Keys created in a regional KMS stay in that KMS.
Downloads that are streaming while their object moves can fail and need retrying, so move rooms outside busy hours or
pass `deleteSource: false` and delete the old copies later.
