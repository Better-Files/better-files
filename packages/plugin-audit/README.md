# @better-files/plugin-audit

Audit reports for Better Files, for closing binders, access reviews and regulators.

```ts
const { report, sha256 } = await api.audit.report({ tenantId, roomId }); // JSON
const pdf = await api.audit.report({ tenantId, roomId, format: 'pdf', saveTo: closingFolderId });
```

A report contains:

- **The room:** status, documents and folders.
- **The activity chain:** recomputed now, so a tampered log reads `BROKEN`.
- **Groups and participants:** relation, groups, guest status and when each person was last seen.
- **Access by folder and group:** the permission matrix, to `depth` levels. It is taken before room settings
  (downloads off, NDA pending) and plugin clamps.
- **Engagement per person:** views, downloads (folder downloads included), uploads and last activity.

JSON comes back inline. A PDF comes back base64-encoded with its SHA-256, and `saveTo` files it into the room as a
document (upload access needed). `audit.reported` goes to the activity log. The action is
`better-files:activity:export` (auditors and administrators). `pdf-lib` is an optional peer dependency, needed only for
PDFs.

Part of [Better Files](../../README.md).
