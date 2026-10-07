# @better-files/plugin-network

Network rules for Better Files: per-room IP allow-lists for guests or everyone, enforced on every operation and download.

Part of [Better Files](../../README.md). Most applications install `better-files` and import this package through its subpaths.

```ts
import { networkPlugin } from '@better-files/plugin-network';

const dr = betterFiles({ /* … */, plugins: [networkPlugin()], trustProxy: true });

await dr.api.network.set(credential, {
  tenantId,
  roomId,
  allowedRanges: ['203.0.113.0/24', '2001:db8::/32'],
  appliesTo: 'external', // only guests; 'everyone' restricts employees too
});
```

- When a room has allowed ranges, a participant connecting from anywhere else gets no capabilities in it: no names,
  no viewing, no downloads. Room owners and administrators are exempt, so they cannot lock themselves out.
- The address comes from the framework adapter (`req.socket.remoteAddress`, Hono's connection info) or, with
  `betterFiles({ trustProxy: true })`, from `x-forwarded-for`. Only trust a proxy you control.
- IPv4, IPv6 and IPv4-mapped IPv6 (`::ffff:192.0.2.1`, as Node reports on dual-stack sockets) are understood.
- An unknown address (a server-side `dr.api` call without request info) is refused by default. Pass
  `networkPlugin({ unknownAddress: 'allow' })` when the host calls the API for users it has already checked.
- `network.status({ roomId })` tells any participant whether their connection is allowed, so a client can explain an
  empty room. `network.get` and `network.set` need room administration. Every change is in the activity log
  (`network.changed`).
- `ipInRanges`, `parseIp` and `parseIpRange` are exported for hosts that check addresses elsewhere.
