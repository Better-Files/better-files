# @better-files/storage-cluster

A storage control plane for Better Files, in the style of better-compute. Servers with local disks run the
[node agent](../storage-node) and become the room's storage: the control plane places each file on several nodes,
reads from any live copy, repairs what goes missing, drains nodes for maintenance and scrubs copies against their
checksums. It is a library: it runs inside your app and plugs in as the `StorageAdapter`.

```ts
import { storageCluster } from 'better-files/storage-cluster';

const cluster = storageCluster({
  database: postgresAdapter({ connectionString, poolSize: 5 }), // its own handle; see below
  secret: process.env.STORAGE_CLUSTER_SECRET!, // 32+ characters; node secrets derive from it
  operatorTenant: 'ops', // whose administrators run the fleet
  replicas: 3,
});
const dr = betterFiles({ storage: cluster.storage, plugins: [cluster.plugin], ...options });
await cluster.initialize();
```

## How it works

| Concern    | Behavior                                                                                                                                                                                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Joining    | An operator creates a single-use, expiring join token (`storage.createJoinToken`, `better-files storage join-token`). The node presents it once and gets its node secret. The control plane stores no node secrets: they derive from the cluster secret, the node id and a generation.                                    |
| Control    | Outbound only, like better-compute's `bcd`. Nodes send signed heartbeats (stats, command results) to `storage.heartbeat` and receive commands (deletions that could not be delivered). Timestamps must be fresh and increasing, so heartbeats cannot be replayed. Fleet paths never call the identity system.             |
| Data       | The control plane (and, for direct uploads, the browser) calls the node's HTTP API with short-lived tokens signed for that node, operation and object. Nodes only ever hold ciphertext, because Better Files encrypts first.                                                                                              |
| Placement  | Weighted rendezvous hashing: stable per key, proportional to free space, one copy per zone first. It skips cordoned, draining, disconnected or full nodes (`reserveBytes`).                                                                                                                                               |
| Writes     | One read of the body is streamed to every chosen node. The write succeeds at `writeQuorum` copies (default: a majority) with identical SHA-256; missing copies are repaired later. Multipart uploads stage parts on one node, and completing them copies the file to reach the quorum.                                    |
| Reads      | From the nearest (`zone`), least-full live copy, with failover to the next. Range requests pass through. A node that loses a copy has it marked missing.                                                                                                                                                                  |
| Liveness   | A node that misses heartbeats for `disconnectedAfterMs` (40 s) is skipped. Its copies still count until `lostAfterMs` (15 min): disconnected is not dead, and a reboot does not start a copy storm.                                                                                                                       |
| Repair     | `reconcile()` (run by `dr.maintain()`) copies under-replicated objects node to node through the control plane and verifies each copy's checksum. It trims copies on draining or removed nodes, and extras once a lost node returns.                                                                                       |
| Scrub      | Each reconcile re-hashes the least recently verified copies (daily). A corrupt copy is replaced, then deleted. `verify(keys)` checks on demand.                                                                                                                                                                           |
| Recovery   | `sync()` reads every node's inventory. Objects missing from the index (a restored database) come back, and copies a node no longer has are repaired.                                                                                                                                                                      |
| Operations | `storage.nodes`, `status`, `cordon`/`uncordon`, `drain`/`activate`, `remove` (refused while a node holds copies unless `force`; it bumps the generation, revoking the node), `reconcile`, `sync`. All go through `better-files:storage:admin` in the operator tenant, and are also available as `better-files storage …`. |

**Give the index its own database handle.** Better Files can call storage while it holds a transaction on its own
connection. With PostgreSQL, pass a separate pool (the same database is fine). With SQLite or PGlite, use a separate
file.

Tested: the core storage conformance suite, plus real node agents on local ports. The tests cover zone spread,
failover reads, lost-node repair, drain and removal, corruption repair, index rebuild, delayed deletions, direct
browser uploads, and forged tokens and heartbeats.

Part of [Better Files](../../README.md).
