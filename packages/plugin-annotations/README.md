# @better-files/plugin-annotations

Notes and highlights on documents for Better Files, anchored to a page and area, with replies and
resolution.

```ts
await api.annotations.create({
  tenantId,
  nodeId,
  body: 'Check the MAC clause',
  page: 3,
  rect: { x: 0.1, y: 0.2, width: 0.5, height: 0.05 },
  quote: 'Material Adverse Change',
}); // private
await api.annotations.create({ tenantId, nodeId, body: 'Ask about earn-out', visibility: 'group' });
await api.annotations.list({ tenantId, nodeId }); // what the caller may read
```

| Visibility          | Who reads it                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `private` (default) | The author only. Room administrators cannot read it, and it is never published as an event. |
| `group`             | Members of one permission group the author belongs to (for example a bidder's team).        |
| `room`              | Everyone who may view the document. Creating one needs `EDIT` (the sell side's guidance).   |

- Replies inherit their thread's audience. Resolving a thread hides it unless `includeResolved` is passed.
- Only the author edits a note. The author or a moderator (`MANAGE`) removes a shared note; a private note belongs
  to its author alone.
- `annotation.created` goes to the activity log with its visibility, never its text. Shared notes also publish an
  event, for notifications.
- Rectangles are fractions of the page (0–1, top-left origin), so they survive re-rendering at any size, including
  in `<bf-viewer>`.

Part of [Better Files](../../README.md).
