/**
 * `<bf-viewer>`: shows a document as server-rendered, watermarked page images. The file itself never reaches the
 * browser; pages load as they scroll into view through short-lived tickets. Deterrents (no context menu, no drag,
 * no printing of the page) raise the effort of copying; the watermark is what identifies a leak.
 *
 * ```ts
 * import { defineBetterFilesViewer } from 'better-files/viewer';
 * defineBetterFilesViewer();
 * const viewer = document.createElement('bf-viewer');
 * viewer.client = createBetterFilesClient<typeof dr>({ tenantId });
 * viewer.setAttribute('node-id', documentId);
 * ```
 *
 * Style it with `::part(page)`, `::part(image)` and `::part(status)`, and `--bf-viewer-gap`, `--bf-viewer-background`.
 */

interface ViewerClient {
  $request<O>(path: string, input?: Record<string, unknown>): Promise<O>;
  fileUrl(ticketUrl: string): string;
}

interface PageTicket {
  page: number;
  url: string;
  expiresAt: number;
}

interface OpenResult {
  supported: boolean;
  versionId: string;
  filename: string;
  pages: { number: number; width: number; height: number }[];
  tickets: PageTicket[];
}

export interface ViewerOpenDetail {
  filename: string;
  pages: number;
  supported: boolean;
}

const styles = `
:host { display: block; overflow: auto; background: var(--bf-viewer-background, #f1f1f1); user-select: none;
  -webkit-user-select: none; -webkit-touch-callout: none; position: relative; }
.pages { display: flex; flex-direction: column; align-items: center; gap: var(--bf-viewer-gap, 16px); padding: 16px; }
.page { position: relative; width: min(100%, calc(var(--bf-viewer-zoom, 1) * 900px)); background: #fff;
  box-shadow: 0 1px 4px rgb(0 0 0 / 0.2); }
.page img { display: block; width: 100%; height: 100%; pointer-events: none; }
.status { padding: 24px; text-align: center; font: 14px system-ui, sans-serif; color: #555; }
@media print { :host { display: none !important; } }
`;

/** Registers the element (once). Safe to call on the server, where it does nothing. */
export function defineBetterFilesViewer(tagName = 'bf-viewer') {
  if (typeof customElements === 'undefined' || customElements.get(tagName)) return;

  class BetterFilesViewerElement extends HTMLElement {
    static observedAttributes = ['node-id', 'version-id'];
    client: ViewerClient | undefined;
    private root: ShadowRoot;
    private container: HTMLDivElement;
    private observer: IntersectionObserver | undefined;
    private state:
      | { nodeId: string; versionId: string; tickets: Map<number, PageTicket> }
      | undefined;
    private loading = new Set<number>();
    private generation = 0;

    constructor() {
      super();
      this.root = this.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = styles;
      this.container = document.createElement('div');
      this.container.className = 'pages';
      this.root.append(style, this.container);
      this.root.addEventListener('contextmenu', (event) => event.preventDefault());
      this.root.addEventListener('dragstart', (event) => event.preventDefault());
      this.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && ['s', 'p', 'c'].includes(event.key.toLowerCase()))
          event.preventDefault();
      });
    }

    connectedCallback() {
      if (!this.hasAttribute('tabindex')) this.tabIndex = 0;
      void this.open();
    }

    disconnectedCallback() {
      this.observer?.disconnect();
      this.generation++;
    }

    attributeChangedCallback() {
      if (this.isConnected) void this.open();
    }

    /** Scrolls to a page (1-based). */
    goTo(page: number) {
      this.container
        .querySelector<HTMLElement>(`[data-page="${page}"]`)
        ?.scrollIntoView({ block: 'start' });
    }

    private status(text: string) {
      const status = document.createElement('div');
      status.className = 'status';
      status.setAttribute('part', 'status');
      status.textContent = text;
      this.container.replaceChildren(status);
    }

    private async open() {
      const nodeId = this.getAttribute('node-id');
      const client = this.client;
      if (!nodeId || !client) return;
      const generation = ++this.generation;
      this.observer?.disconnect();
      this.status('Loading…');
      let result: OpenResult;
      try {
        const versionId = this.getAttribute('version-id');
        result = await client.$request<OpenResult>('viewer/open', {
          nodeId,
          ...(versionId ? { versionId } : {}),
        });
      } catch (error) {
        if (generation !== this.generation) return;
        this.status(error instanceof Error ? error.message : 'This document cannot be shown');
        this.dispatchEvent(
          new CustomEvent('bf-viewer-error', { detail: error, bubbles: true, composed: true }),
        );
        return;
      }
      if (generation !== this.generation) return;
      this.dispatchEvent(
        new CustomEvent<ViewerOpenDetail>('bf-viewer-open', {
          detail: {
            filename: result.filename,
            pages: result.pages.length,
            supported: result.supported,
          },
          bubbles: true,
          composed: true,
        }),
      );
      if (!result.supported) {
        this.status(`No preview is available for ${result.filename}`);
        return;
      }
      this.state = {
        nodeId,
        versionId: result.versionId,
        tickets: new Map(result.tickets.map((t) => [t.page, t])),
      };
      this.loading.clear();
      const pages = result.pages.map((size) => {
        const page = document.createElement('div');
        page.className = 'page';
        page.dataset.page = String(size.number);
        page.setAttribute('part', 'page');
        page.style.aspectRatio = `${size.width} / ${size.height}`;
        return page;
      });
      this.container.replaceChildren(...pages);
      // The first pages come with tickets already: show them without waiting for layout.
      for (const ticket of result.tickets) {
        const page = pages[ticket.page - 1];
        if (page) void this.show(page, generation);
      }
      if (typeof IntersectionObserver === 'undefined') {
        for (const page of pages) void this.show(page, generation);
        return;
      }
      this.observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries)
            if (entry.isIntersecting) void this.show(entry.target as HTMLElement, generation);
        },
        { root: this, rootMargin: '600px 0px' },
      );
      for (const page of pages) this.observer.observe(page);
    }

    private async ticket(page: number, fresh = false): Promise<PageTicket | undefined> {
      const state = this.state!;
      const known = state.tickets.get(page);
      if (known && !fresh && known.expiresAt > Date.now() + 5_000) return known;
      const { tickets } = await this.client!.$request<{ tickets: PageTicket[] }>('viewer/pages', {
        nodeId: state.nodeId,
        versionId: state.versionId,
        from: page,
        to: page + 9,
      });
      for (const ticket of tickets) state.tickets.set(ticket.page, ticket);
      return state.tickets.get(page);
    }

    private async show(element: HTMLElement, generation: number, retry = true) {
      const page = Number(element.dataset.page);
      if (this.loading.has(page) || element.querySelector('img')) return;
      this.loading.add(page);
      try {
        const ticket = await this.ticket(page, !retry);
        if (!ticket || generation !== this.generation) return;
        const image = document.createElement('img');
        image.setAttribute('part', 'image');
        image.alt = `Page ${page}`;
        image.draggable = false;
        image.decoding = 'async';
        image.addEventListener(
          'error',
          () => {
            // An expired or used ticket: fetch a new one once.
            image.remove();
            this.loading.delete(page);
            if (retry) void this.show(element, generation, false);
          },
          { once: true },
        );
        image.src = this.client!.fileUrl(ticket.url);
        this.state!.tickets.delete(page);
        element.append(image);
      } finally {
        this.loading.delete(page);
      }
    }
  }

  customElements.define(tagName, BetterFilesViewerElement);
}

declare global {
  interface HTMLElementTagNameMap {
    'bf-viewer': HTMLElement & { client: ViewerClient | undefined; goTo(page: number): void };
  }
}
