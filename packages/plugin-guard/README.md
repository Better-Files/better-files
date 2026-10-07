# @better-files/plugin-guard

Download rate limits and anomaly reporting for Better Files, connected to Better IAM's threat detection.

Part of [Better Files](../../README.md). Most applications install `better-files` and import this package through its subpaths.

## Rate limits

```ts
import { guardPlugin } from 'better-files/plugin-guard';

betterFiles({ …, plugins: [guardPlugin({ maxDownloads: 100, windowMs: 10 * 60_000 })] });
```

- **What counts:** each person's downloads per room in the window, read from the room's activity log, so the limit
  holds across servers and restarts. Every file in a folder ZIP counts, both inside one request and across
  requests. Viewer opens count too with `countViews: true`.
- **Who is exempt:** owners and admins (`exempt`).
- **What happens at the limit:** the request is refused with `RATE_LIMITED`. A `security.download-anomaly` event
  is emitted and logged, and `onAnomaly` runs. Both happen once per window, also across servers.

## Better IAM threat response

`betterIamThreats(iam, options)` connects the guard to Better IAM's identity threat detection (better-iam 0.2 or
later):

- **Someone crosses the limit:** their Better IAM risk is raised to `high` for 24 hours (`raiseRisk`,
  `riskExpiresInMs`). Better IAM policies see this as `principal.riskLevel`, and it appears in
  `threats.listRisk`. Optional `actions` run through `threats.respond`: `revoke-sessions`, `forget-devices`,
  `contain`, `notify`, or `block-network` (which blocks the requester's address).
- **Someone Better IAM rates high risk:** their downloads and views are refused in every room, whatever their role.
  This applies whether the guard raised the risk or Better IAM did on its own (password spraying, session hijack, a
  "this wasn't me" report). If the lookup fails, the download is allowed (fail open), so a Better IAM outage does
  not close every room. Lookups are cached for 30 seconds (`cacheMs`). The threshold is set with `blockAt`.

```ts
import { betterIamThreats, guardPlugin, threatsPolicy } from 'better-files/plugin-guard';

const guard = guardPlugin({
  maxDownloads: 50,
  ...betterIamThreats(iam, {
    // A service account API key whose role carries threatsPolicy() (iam:threats:read, iam:threats:respond).
    credential: (tenantId) => ({ token: securityKeys[tenantId] }),
    actions: [{ kind: 'revoke-sessions' }, { kind: 'notify' }],
  }),
});
```

To add your own handling, wrap `onAnomaly`. To use another identity system, pass your own `risk` gate:
`guardPlugin({ risk: { level: 'medium', lookup: async ({ tenantId, principalId }) => … } })`.
