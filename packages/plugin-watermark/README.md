# @better-files/plugin-watermark

Watermarked downloads and views for Better Files: identity, time and a forensic code stamped on PDFs and images, a hidden copy of the code, and a record of every copy so a leak leads back to its recipient.

Part of [Better Files](../../README.md). Most applications install `better-files` and import this package through its subpaths.

```ts
import { watermarkPlugin } from '@better-files/plugin-watermark';

const dr = betterFiles({ /* … */ plugins: [watermarkPlugin()] });
```

The plugin serves the `watermarked` download variant and the inline `view` variant. People who may only have watermarked copies never get an unmarked original: file types it cannot stamp are refused, unless the processing plugin has made a PDF rendition, which is stamped instead.

## The visible stamp

Every page or image carries `{email or name} · {time} UTC · {ip} · {code}`, tiled diagonally. The font shrinks until a whole line fits the page, one copy sits in the middle, and staggered copies cover the rest, so cropping one leaves others.

| Option     | Default           | Meaning                                                                              |
| ---------- | ----------------- | ------------------------------------------------------------------------------------ |
| `text`     | see above         | `(context) => string` with `name`, `email`, `ip`, `time`, `room`, `filename`, `code` |
| `opacity`  | `0.18`            | 0–1                                                                                  |
| `fontSize` | `28`              | Points; the largest size used                                                        |
| `angle`    | `35`              | Degrees counter-clockwise                                                            |
| `color`    | grey              | RGB 0–1                                                                              |
| `maxBytes` | 200 MiB           | Largest file stamped in memory                                                       |
| `view`     | `true`            | Also serve the `view` variant                                                        |
| `forensic` | `{ strength: 8 }` | Hidden marks; `false` turns them off                                                 |
| `record`   | `true`            | Record every copy in `watermarkIssues`                                               |

## Forensic tracing

Each copy gets a fresh, unguessable 10-digit code. Besides the visible stamp, the code is hidden where removing the stamp does not reach it:

- **PDFs:** in the document keywords, and as invisible text on every page. Stripping the metadata leaves the text.
- **Images:** in the mean brightness of a grid of cells across the picture. The mark survives JPEG re-compression (down to quality 40 in tests), PNG/WebP conversion, mild blur and resizing of ordinary photos. Cropping, rotation, brightness or contrast changes and heavy editing defeat it. Images under 64 × 56 pixels carry the visible stamp only. On flat artwork the mark can show as a faint texture: lower `forensic.strength` (it is the luma step; higher survives harsher processing and shows more).

Every copy is recorded (`WatermarkIssue`: room, document, version, recipient, IP, variant, code, whether the hidden mark was embedded), before the copy is served. The `document.watermarked` event carries the code too.

When a copy leaks:

```ts
// The leaked file was uploaded to the room (a restricted folder works well): read its code and whose copy it was.
const found = await dr.api.watermark.identify(credential, { tenantId, nodeId });
// → { code, method: 'pdf-metadata' | 'pdf-text' | 'image-pixels', issue: { identityId, email, ip, createdAt, … } }

// A code from anywhere in the tenant (tenant administrators).
const issue = await dr.api.watermark.trace(credential, { tenantId, code: '3F6B7D6E42' });

// The copies handed out in a room, newest first.
const issues = await dr.api.watermark.issues(credential, { tenantId, roomId, nodeId, identityId });

// Outside any request, for files you hold (a CLI, a scheduled scan):
import { extractForensicCode } from '@better-files/plugin-watermark';
const match = await extractForensicCode(bytes); // { code, method } | undefined
```

| Endpoint   | Target | Action                                    | Who (access model)            |
| ---------- | ------ | ----------------------------------------- | ----------------------------- |
| `trace`    | tenant | `better-files:watermark:trace`            | tenant administrators         |
| `issues`   | room   | `better-files:watermark:read`             | room owners, admins, auditors |
| `identify` | node   | `better-files:watermark:trace` + `MANAGE` | room owners and admins        |

`identify` returns the recipient only for copies issued in the same room; for a copy from another room it reports `otherRoom: true` and leaves the lookup to `trace`. Each identification is written to the room's activity log.

The table is plugin-owned: run `better-files generate` / `better-files migrate` after adding the plugin to a SQL database.

No watermark prevents screenshots or photos of a screen. The visible stamp discourages them and names the source when they surface.
