# @better-files/plugin-processing

Document processing for Better Files. Office and other formats get a PDF rendition, so the secure viewer
and watermarked downloads work for Word, Excel and PowerPoint. Every document gets a thumbnail.

```ts
import { processingPlugin, libreOffice } from 'better-files/plugin-processing';

processingPlugin({ converters: [libreOffice()] }); // needs `soffice` (LibreOffice) on the server
```

- Runs after `document.uploaded`, `version.created`, `version.restored` and `version.scanned`. Quarantined files wait
  for a clean scan. Failures are retried by `dr.maintain()` (three attempts); `processing.reprocess` runs it again.
- **Renditions** (`pdf`, `thumbnail`) are stored through core's rendition store: encrypted like the file and
  deleted with it. The viewer and watermark plugins pick up the PDF rendition automatically; a watermarked download
  of a `.docx` is a stamped `.pdf`.
- `processing.thumbnails({ roomId, nodeIds })` returns data URLs for listings, only for documents the caller may
  view. `processing.status({ nodeId })` reports `pending`, `done`, `skipped` or `failed`.
- `libreOffice({ binary, timeoutMs })` runs `soffice --headless` with a private profile per conversion, so
  conversions can run in parallel. Files are written to a temporary folder with a neutral name, then removed.
  A `Converter` is two methods (`accepts`, `toPdf`) if you use a conversion service instead.
- `mode: 'inline'` waits for processing inside the upload request (scripts, tests); the default runs it in the
  background.

`unpdf` and `@napi-rs/canvas` (thumbnails) are optional peer dependencies.

Part of [Better Files](../../README.md).
