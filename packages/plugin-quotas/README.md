# @better-files/plugin-quotas

Storage quotas for Better Files: bytes, documents and file size, per room and per tenant.

```ts
quotasPlugin({
  room: { maxBytes: 50 * 1024 ** 3, maxFileBytes: 2 * 1024 ** 3 }, // default for every room
  tenant: async (tenantId) => plans.limitsFor(tenantId), // from your billing plan
  warnAt: 0.8,
});

await api.quotas.room({ tenantId, roomId }); // { bytes, documents, versions, limits, ratio }
await api.quotas.setRoom({ tenantId, roomId, maxBytes: 200 * 1024 ** 3 }); // tenant administrators
```

- **Before any bytes move.** `uploads.create` is refused with `QUOTA_EXCEEDED` (HTTP 429) for a file over the size
  limit, or a room or tenant over its byte or document limit. `quota.exceeded` is published.
- **Exact accounting.** Usage moves in the same transaction as each stored version, generated files included.
  Every version counts, and trash counts until it is purged. `dr.maintain()` recounts rooms round-robin, so
  purged space comes back.
- **Warnings.** `quota.warning` fires once when usage crosses `warnAt` of a limit (for notifications and webhooks).
- **Who.** Any room member can read the room's usage. Setting limits, recounting and the tenant view need
  `better-files:quotas:manage` on the tenant, so room administrators cannot raise their own limits.
- Limits are soft under concurrency: two uploads checked at the same moment can both pass.

## Metering and limits in Better IAM billing

`betterIamMetering(iam, options)` is a separate plugin (id `metering`). It records Better Files usage in Better IAM
billing (better-iam 0.2 or later) and enforces Better IAM budgets and quota plans. It uses the instance's trusted
`iam.billing` and `iam.quotas` runtimes, so it needs no credential.

```ts
import { betterIamMetering, meteringMeters } from 'better-files/plugin-quotas';

// Once, as the platform (root tenant): define the meters, then price them on your rate card.
for (const meter of meteringMeters()) await iam.api.billing.createMeter(rootCredential, { tenantId: rootTenantId, ...meter });

betterFiles({
  …,
  plugins: [
    betterIamMetering(iam, {
      enforceBudgets: true, // refuse work once an enforced budget is spent
      quotas: { download: 'better-files.downloads' }, // per-person quota plans you define in Better IAM
    }),
  ],
});
```

| Meter (default key)           | Aggregation | Unit        | Recorded when                                            |
| ----------------------------- | ----------- | ----------- | -------------------------------------------------------- |
| `better-files.upload-bytes`   | sum         | byte        | A document or new version is stored (generated ones too) |
| `better-files.download-bytes` | sum         | byte        | A single file is downloaded, original or watermarked     |
| `better-files.downloads`      | sum         | file        | Files are downloaded; folder ZIPs count per file         |
| `better-files.views`          | sum         | view        | A document is opened in the viewer                       |
| `better-files.rooms`          | sum         | room        | A room is created                                        |
| `better-files.participants`   | unique      | participant | Anyone views or downloads (active participants)          |

- **When usage is recorded.** After each change commits, from the published events, with the event id as
  idempotency key. Refused or rolled-back actions are never billed, and a redelivered event is billed once.
- **Who it is billed to.** Usage is attributed to the acting person, and the system to no one. Actors Better IAM
  does not know, such as share-link visitors, are billed to the tenant without attribution. Every event is tagged
  `roomId` for chargeback; add more labels with `tags`. Rename a meter or turn it off with
  `meters: { views: false }`.
- **Enforcement.** `enforceBudgets` asks `billing.check` before uploads, downloads and views, and refuses with
  `QUOTA_EXCEEDED` (scope `budget`). Each `quotas` meter is counted per person through `quotas.consumeFor`. A
  refusal is `RATE_LIMITED`, with the plan and `retryAfterMs`. People no plan covers are unlimited.
- **When Better IAM is unreachable.** Checks fail open by default and log a warning. With `onCheckError: 'closed'`,
  the action is refused instead.
- **Delivery.** Each event's usage is written by a durable `metering.record` job (`dr.jobs`). The job retries with
  backoff while Better IAM is unreachable, up to 10 attempts, and the idempotency keys make repeats harmless.
  `delivery: 'inline'` records as the event is delivered instead, with no retry.

Part of [Better Files](../../README.md).
