# @better-files/cli

The `better-files` command line. Installed with `better-files` (`npx better-files …`) or on its own.

## Instance commands

They load your `betterFiles()` instance from `better-files.config.{ts,mts,js,mjs}` (default export, or `dr`), or
`--config <file>`. TypeScript configs need Node 22.18+ or a loader such as `tsx`.

```sh
better-files migrate                          # create or upgrade tables (dr.initialize())
better-files maintain [--every 300]           # tickets, uploads, trash retention, plugin sweeps
better-files verify --tenant acme --room rom_…  # recompute a room's activity hash chain; exit 2 if broken
better-files doctor [--tenant acme]           # secret, database, storage round trip, KMS data key round trip
better-files reconcile --tenant acme [--room rom_…] [--repair] [--revoke-orphans] [--json]
```

## Reconcile with the identity system

Better Files writes the identity system (Better IAM relationship tuples and groups) and its own rosters in order, not
in one transaction. A crash between the two writes, a failed call, or an edit made directly in Better IAM leaves
them apart. `better-files reconcile` compares them room by room:

| Kind                         | Meaning                                                              | `--repair`                   |
| ---------------------------- | -------------------------------------------------------------------- | ---------------------------- |
| `missing-relation`           | A member or group should hold a room relation; Better IAM has none   | grants it, records the id    |
| `stale-relation-id`          | The relation exists under another id than the roster recorded        | records the right id         |
| `lingering-relation`         | A suspended, removed or expired member still holds a relation        | revokes it                   |
| `missing-group-membership`   | An active member is missing from a permission group's IAM group      | adds them (with the expiry)  |
| `lingering-group-membership` | A former member is still in a permission group's IAM group           | removes them                 |
| `orphan-relation`            | A relation on the room that no roster entry explains                 | only with `--revoke-orphans` |
| `unregistered-room`          | The room is not a registered resource in Better IAM                  | reported only                |
| `stuck-provisioning`         | Room creation stopped before Better IAM knew the room (over an hour) | reported only                |

Better IAM is authoritative for membership, so relations granted there directly are reported, never revoked, unless
you pass `--revoke-orphans`. The command uses the integration's `systemCredential`, exits 0 when everything is in
sync (or repaired) and 2 when differences remain. Run it in quiet periods: a change that lands between the two
reads shows up as a difference.

In code: `reconcileIam(dr, { tenantId, repair: true })` returns the same report.

## Sync

Mirrors one room into a local folder over HTTP, through the sync plugin's changes feed.

```sh
export BETTER_FILES_URL=https://app.example.com/api/better-files BETTER_FILES_TENANT=acme BETTER_FILES_TOKEN=…
better-files sync pull   --room rom_… --dir ./falcon
better-files sync status --room rom_… --dir ./falcon
better-files sync push   --room rom_… --dir ./falcon [--delete]
```

- Remote renames and moves become local renames; withdrawn access removes files (unless edited locally).
- Local edits are never overwritten: when both sides changed, the local file is kept as
  `name (conflicted copy YYYY-MM-DD HH-MM).ext` and uploaded on push.
- Documents you may view but not download are listed as view only and skipped.
- Local deletions reach the server only with `push --delete`.
- State lives in `<dir>/.better-files/state.json`; the token is never written to disk.

`createMirror()` and `main()` are exported for embedding in other tools.

Part of [Better Files](../../README.md).
