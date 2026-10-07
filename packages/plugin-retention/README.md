# @better-files/plugin-retention

Legal holds and retention rules for Better Files: preserve rooms or folders against deletion, trash purges and room deletion.

- **Legal holds** (`retention.place`, `release`, `list`) preserve a room or a folder's subtree until released.
- **Retention rules** (`retention.addRule`, `removeRule`, `listRules`) keep documents for `keepDays` after they were added. A `locked` rule cannot be removed.
- With `closedRoomRetentionDays`, `dr.maintain()` emits `room.retention-expired` once a closed room is past that age and no hold or rule keeps anything in it.

```ts
retentionPlugin({ closedRoomRetentionDays: 365 * 7 });
await dr.api.retention.addRule(credential, {
  tenantId,
  roomId,
  name: 'Books and records',
  keepDays: 2555,
  locked: true,
});
```

Part of [Better Files](../../README.md). Most applications install `better-files` and import this package through its subpaths.
