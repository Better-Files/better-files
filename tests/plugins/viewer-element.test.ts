// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { createBetterFilesClient } from '@better-files/client';
import { defineBetterFilesViewer, type ViewerOpenDetail } from '@better-files/viewer';
import { viewerPlugin, type PageRenderer } from '@better-files/viewer/server';
import { fixture, TENANT } from '../fixtures.js';

const renderer: PageRenderer = {
  pages: async () => [
    { number: 1, width: 400, height: 600 },
    { number: 2, width: 400, height: 600 },
  ],
  render: async () => ({ bytes: new Uint8Array([1]), mimeType: 'image/png' }),
};

async function until(check: () => boolean) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 3000) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('<bf-viewer>', () => {
  it('opens a document, lays out pages and loads page images through tickets', async () => {
    const f = await fixture({ plugins: [viewerPlugin({ renderer })] });
    const room = await f.room();
    const { document: file } = await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'deck.pdf',
      content: new TextEncoder().encode('%PDF-1.7 stand-in'),
    });
    defineBetterFilesViewer();
    defineBetterFilesViewer(); // idempotent
    const element = document.createElement('bf-viewer');
    element.client = createBetterFilesClient<typeof f.dr>({
      baseURL: 'http://app.test',
      tenantId: TENANT,
      headers: () => ({ authorization: 'Bearer alice' }),
      fetch: (input, init) => f.dr.handler(new Request(input, init)),
    });
    let opened: ViewerOpenDetail | undefined;
    element.addEventListener(
      'bf-viewer-open',
      (event) => (opened = (event as CustomEvent<ViewerOpenDetail>).detail),
    );
    element.setAttribute('node-id', file.id);
    document.body.append(element);

    await until(() => opened !== undefined);
    expect(opened).toEqual({ filename: 'deck.pdf', pages: 2, supported: true });
    const shadow = element.shadowRoot!;
    await until(() => shadow.querySelectorAll('img').length === 2);
    const images = [...shadow.querySelectorAll('img')];
    expect(images.map((image) => image.getAttribute('src'))).toEqual([
      expect.stringMatching(/^http:\/\/app\.test\/api\/better-files\/files\/.+/),
      expect.stringMatching(/^http:\/\/app\.test\/api\/better-files\/files\/.+/),
    ]);
    expect(images.every((image) => image.draggable === false)).toBe(true);
    expect(shadow.querySelectorAll('[part="page"]')).toHaveLength(2);

    // A refused open shows a status instead of pages.
    const outsider = document.createElement('bf-viewer');
    outsider.client = createBetterFilesClient<typeof f.dr>({
      baseURL: 'http://app.test',
      tenantId: TENANT,
      headers: () => ({ authorization: 'Bearer dave' }),
      fetch: (input, init) => f.dr.handler(new Request(input, init)),
    });
    let failed = false;
    outsider.addEventListener('bf-viewer-error', () => (failed = true));
    outsider.setAttribute('node-id', file.id);
    document.body.append(outsider);
    await until(() => failed);
    expect(outsider.shadowRoot!.querySelector('[part="status"]')?.textContent).toBeTruthy();
    element.remove();
    outsider.remove();
  });
});
