# @better-files/plugin-redaction

Redaction for Better Files: find sensitive text in PDFs and burn it out, as a new version or as a redacted
copy next to the original.

```ts
import { redactionPlugin } from 'better-files/plugin-redaction';

const dr = betterFiles({
  ...options,
  plugins: [redactionPlugin({ patterns: { employeeId: /\bEMP-\d{6}\b/g } })],
});

// Review what would be removed (boxes in PDF points, origin bottom-left)…
const { matches } = await api.redaction.find({
  tenantId,
  nodeId,
  patterns: ['email', 'ssn'],
  terms: ['Project Falcon'],
});
// …then apply: matches plus any areas marked by hand.
await api.redaction.apply({ tenantId, nodeId, patterns: ['email', 'ssn'], areas, mode: 'copy' });
```

- **Nothing survives under a box.** Pages with redactions are rasterized with the boxes drawn in, so text, vectors
  and images underneath are gone. Other pages are copied untouched and keep their text layer. Document metadata is
  not carried over.
- **Detectors:** `email`, `phone`, `ssn`, `iban`, `card`, your own `patterns` (host configuration), and literal
  `terms` (case-insensitive). Request input never becomes a regular expression.
- **Access:** both operations need `EDIT` on the document; `mode: 'copy'` also needs `UPLOAD` on its folder.
- **Audit:** `document.redacted` records the mode, counts, pages and rule names, never the redacted text.
- Images take `areas` in pixels (origin top-left) and come back as PNG.

`pdf-lib`, `unpdf` and `@napi-rs/canvas` are optional peer dependencies. `findInPdf`, `redactPdf` and `redactImage`
are exported for use outside a room.

Part of [Better Files](../../README.md).
