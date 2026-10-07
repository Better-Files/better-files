# @better-files/plugin-sync

Delta sync for Better Files: snapshots and a permission-aware changes feed with content hashes, for desktop
and CLI mirrors.

```ts
const { cursor, entries } = await api.sync.snapshot({ tenantId, roomId });
// later
const page = await api.sync.changes({ tenantId, roomId, cursor });
// { reset, cursor, hasMore, changes: [{ type: 'upsert', entry } | { type: 'remove', id }] }
```

- The cursor is the room's activity sequence, so every recorded change is covered. Views, searches and Q&A are not
  changes.
- Entries carry `parentId` (null at the top), `name`, and for documents the current `version` with its `sha256`, so a
  client downloads only what changed. Upserts arrive parents first.
- Results pass the room index's checks: when access is withdrawn (a permission change, a hidden folder), the affected
  entries arrive as `remove`. Moves, deletes and restores cover the whole subtree.
- Group and membership changes return `reset: true`: take a new snapshot. So does an invalid or future cursor.

`better-files sync` in [`@better-files/cli`](../cli) is a complete client.

Part of [Better Files](../../README.md).
