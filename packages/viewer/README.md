# @better-files/viewer

The secure document viewer for Better Files: pages are rendered on the server to watermarked images and
shown by the `<bf-viewer>` custom element. The file itself never reaches the browser.

## Server

```ts
import { viewerPlugin } from 'better-files/viewer/server';

const dr = betterFiles({ ...options, plugins: [viewerPlugin()] });
```

- `viewer.open({ nodeId, versionId? })` needs `VIEW`. It goes through the regular view request (NDA gates, network
  rules, the `document.viewed` record) and returns page sizes plus tickets for the first pages.
- `viewer.pages({ nodeId, versionId, from, to })` hands out more page tickets.
- Each ticket is served as one page rendered with unpdf (pdf.js) and stamped with who is viewing, when, and a short
  code tying a screenshot back to them. Images preview as a single page.

Options: `scale` (default 1.5), `batch` (tickets per call, default 10), `maxBytes`, `watermark` (a function of
`{ name, email, principalId, at, ip, code }`, or `false`), and `renderer` to use another rendering engine.
`unpdf` and `@napi-rs/canvas` are optional peer dependencies of the default renderer.

## Browser

```ts
import { defineBetterFilesViewer } from 'better-files/viewer';
defineBetterFilesViewer(); // registers <bf-viewer>; does nothing on the server

const viewer = document.createElement('bf-viewer');
viewer.client = createBetterFilesClient<typeof dr>({ tenantId });
viewer.setAttribute('node-id', documentId);
viewer.addEventListener('bf-viewer-open', (event) => console.log(event.detail.pages));
```

It works in any framework (React 19, Vue and Svelte pass properties to custom elements). Pages load as they scroll
into view; expired tickets are renewed. The context menu, dragging, save/print/copy shortcuts and printing the page
are blocked. These are deterrents; the watermark is what identifies a leak. Style it with `::part(page)`,
`::part(image)`, `::part(status)`, `--bf-viewer-gap`, `--bf-viewer-background` and `--bf-viewer-zoom`.

Part of [Better Files](../../README.md).
