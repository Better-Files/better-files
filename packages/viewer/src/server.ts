import { createHash } from 'node:crypto';
import {
  Capability,
  BetterFilesError,
  definePlugin,
  endpoint,
  notFound,
  v,
  type DataRoomDocument,
  type DocumentVersion,
  type PluginContext,
} from '@better-files/core';

export interface ViewerStamp {
  name?: string;
  email?: string;
  principalId: string;
  at: number;
  ip?: string;
  /** A short code tying a screenshot back to this viewer and version. */
  code: string;
}

export interface PageSize {
  number: number;
  width: number;
  height: number;
}

/** Renders one page of a document to an image; the default uses unpdf (PDF) and @napi-rs/canvas. */
export interface PageRenderer {
  /** Page sizes in points (PDF) or pixels (images); `undefined` when the file cannot be previewed. */
  pages(bytes: Uint8Array, mimeType: string): Promise<PageSize[] | undefined>;
  /** The page as an image, watermarked with `stamp` when it is given. */
  render(input: {
    bytes: Uint8Array;
    mimeType: string;
    page: number;
    scale: number;
    stamp?: string;
  }): Promise<{ bytes: Uint8Array; mimeType: string }>;
}

export interface ViewerOptions {
  /** Render scale for PDF pages (1 = 72 dpi). Default 1.5. */
  scale?: number;
  /** Page tickets issued per call. Default 10. */
  batch?: number;
  /** Largest file previewed, in bytes. Default 100 MiB. */
  maxBytes?: number;
  /** The stamped text, or `false` for no watermark. Default `{email or name} · {time} · {code}`. */
  watermark?: false | ((stamp: ViewerStamp) => string);
  renderer?: PageRenderer;
}

const pageVariant = /^page:(\d{1,5})$/;
const isPdf = (bytes: Uint8Array) => new TextDecoder().decode(bytes.subarray(0, 5)) === '%PDF-';

async function readAll(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new BetterFilesError('PAYLOAD_TOO_LARGE', 'The file is too large to preview');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function canvasModule() {
  try {
    return await import('@napi-rs/canvas');
  } catch {
    throw new BetterFilesError('UNSUPPORTED', 'The viewer needs the @napi-rs/canvas package');
  }
}

async function pdfModule() {
  try {
    return await import('unpdf');
  } catch {
    throw new BetterFilesError('UNSUPPORTED', 'PDF previews need the unpdf package');
  }
}

/** Tiles `text` diagonally across the whole image, like the watermark plugin does on PDFs. */
function stampCanvas(
  context: import('@napi-rs/canvas').SKRSContext2D,
  width: number,
  height: number,
  text: string,
) {
  const size = Math.max(14, Math.round(Math.min(width, height) / 28));
  context.save();
  context.globalAlpha = 0.16;
  context.fillStyle = '#404040';
  context.font = `${size}px sans-serif`;
  context.translate(width / 2, height / 2);
  context.rotate((-30 * Math.PI) / 180);
  const diagonal = Math.hypot(width, height);
  const step = Math.max(size * 20, context.measureText(text).width + size * 4);
  for (let y = -diagonal / 2; y < diagonal / 2; y += size * 6)
    for (let x = -diagonal / 2; x < diagonal / 2; x += step) context.fillText(text, x, y);
  context.restore();
}

/** PDFs through unpdf (pdf.js) and images through @napi-rs/canvas; output is WebP. */
export const canvasRenderer: PageRenderer = {
  async pages(bytes, mimeType) {
    if (isPdf(bytes)) {
      const { getDocumentProxy } = await pdfModule();
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      try {
        const sizes: PageSize[] = [];
        for (let number = 1; number <= pdf.numPages; number++) {
          const viewport = (await pdf.getPage(number)).getViewport({ scale: 1 });
          sizes.push({
            number,
            width: Math.round(viewport.width),
            height: Math.round(viewport.height),
          });
        }
        return sizes;
      } finally {
        await (pdf as { destroy?: () => Promise<void> }).destroy?.();
      }
    }
    if (!mimeType.startsWith('image/')) return undefined;
    const { loadImage } = await canvasModule();
    try {
      const image = await loadImage(Buffer.from(bytes));
      return [{ number: 1, width: image.width, height: image.height }];
    } catch {
      return undefined;
    }
  },
  async render({ bytes, page, scale, stamp }) {
    const { createCanvas, loadImage } = await canvasModule();
    let source: Uint8Array = bytes;
    if (isPdf(bytes)) {
      const { renderPageAsImage } = await pdfModule();
      source = new Uint8Array(
        await renderPageAsImage(new Uint8Array(bytes), page, {
          canvasImport: () => import('@napi-rs/canvas'),
          scale,
        }),
      );
    } else if (page !== 1) throw notFound('Page');
    const image = await loadImage(Buffer.from(source));
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, image.width, image.height);
    context.drawImage(image, 0, 0);
    if (stamp) stampCanvas(context, image.width, image.height, stamp);
    return { bytes: new Uint8Array(await canvas.encode('webp', 82)), mimeType: 'image/webp' };
  },
};

const defaultStamp = (stamp: ViewerStamp) =>
  [
    stamp.email ?? stamp.name ?? stamp.principalId,
    new Date(stamp.at).toISOString().slice(0, 16).replace('T', ' '),
    stamp.code,
  ].join(' · ');

/**
 * The secure viewer's server side. `viewer.open` checks the view the regular way (NDA gates, network rules, the
 * `document.viewed` record) and returns page sizes with the first page tickets; `viewer.pages` hands out more.
 * Each page is rendered to a watermarked image when its ticket is served, so the file never reaches the browser.
 */
export function viewerPlugin(options: ViewerOptions = {}) {
  const renderer = options.renderer ?? canvasRenderer;
  const scale = options.scale ?? 1.5;
  const batch = options.batch ?? 10;
  const maxBytes = options.maxBytes ?? 100 * 1024 * 1024;
  const watermark = options.watermark === undefined ? defaultStamp : options.watermark;
  // Page sizes per version: stable, so computed once.
  const sizes = new Map<string, PageSize[] | null>();

  async function load(context: PluginContext, nodeId: string, versionId?: string) {
    const document = await context.db.findOne<DataRoomDocument>('documents', {
      id: nodeId,
      tenantId: context.tenantId,
    });
    if (!document) throw notFound('Document');
    const id = versionId ?? document.currentVersionId;
    // As `documents.requestView`: earlier versions (an unredacted original) are for people who may edit.
    if (id !== document.currentVersionId) {
      const masks = await context.capabilitiesOf([context.node!]);
      if (((masks.get(nodeId) ?? 0) & Capability.EDIT) === 0)
        throw new BetterFilesError(
          'FORBIDDEN',
          'Earlier versions need edit access to the document',
        );
    }
    const version = id
      ? await context.db.findOne<DocumentVersion>('versions', {
          id,
          tenantId: context.tenantId,
          documentId: nodeId,
        })
      : undefined;
    if (!version) throw notFound('Version');
    if (version.status !== 'ready')
      throw new BetterFilesError('CONFLICT', `The file is ${version.status}`);
    return { document, version };
  }

  /**
   * What to render: the file itself when it is a PDF or an image, otherwise its PDF rendition (an Office file
   * converted by the processing plugin), otherwise the file (which then has no preview).
   */
  async function sourceOf(context: PluginContext, version: DocumentVersion, original?: Uint8Array) {
    const bytes = original ?? (await readAll(await context.readVersion(version.id), maxBytes));
    const mimeType = version.mimeType ?? 'application/octet-stream';
    if (isPdf(bytes) || mimeType.startsWith('image/')) return { bytes, mimeType };
    const rendition = await context.renditions.get(version.id, 'pdf');
    if (!rendition) return { bytes, mimeType };
    return { bytes: await readAll(await rendition.read(), maxBytes), mimeType: 'application/pdf' };
  }

  async function pagesOf(context: PluginContext, version: DocumentVersion) {
    if (!sizes.has(version.id)) {
      if (version.size > maxBytes) sizes.set(version.id, null);
      else {
        const source = await sourceOf(context, version);
        const pages = (await renderer.pages(source.bytes, source.mimeType)) ?? null;
        // "No preview" for an unconverted file may change once it is converted: remember only final answers.
        const final = pages !== null || isPdf(source.bytes) || source.mimeType.startsWith('image/');
        if (!final) return undefined;
        sizes.set(version.id, pages);
      }
      if (sizes.size > 1000) sizes.delete(sizes.keys().next().value!);
    }
    return sizes.get(version.id) ?? undefined;
  }

  async function tickets(
    context: PluginContext,
    nodeId: string,
    versionId: string,
    from: number,
    to: number,
  ) {
    const out: { page: number; url: string; expiresAt: number }[] = [];
    for (let page = from; page <= to; page++) {
      const ticket = await context.issueTicket({
        documentId: nodeId,
        versionId,
        variant: `page:${page}`,
        disposition: 'inline',
      });
      out.push({ page, url: ticket.url, expiresAt: ticket.expiresAt });
    }
    return out;
  }

  const operation = {
    action: 'better-files:documents:view',
    target: 'node',
    capabilities: ['VIEW'],
    mutates: false,
  } as const;

  return definePlugin({
    id: 'viewer',
    endpoints: {
      open: endpoint({
        operation,
        input: v.object({ nodeId: v.id(), versionId: v.optional(v.id()) }),
        target: (input) => ({ nodeId: input.nodeId }),
        async handler(context, input) {
          if (context.node!.kind !== 'document')
            throw new BetterFilesError('INVALID_INPUT', 'Only documents can be viewed');
          // The regular view request: document state, NDA and network hooks, and the activity record.
          await context.call('documents.requestView', {
            nodeId: input.nodeId,
            ...(input.versionId ? { versionId: input.versionId } : {}),
          });
          const { version } = await load(context, input.nodeId, input.versionId);
          const pages = await pagesOf(context, version);
          const base = {
            versionId: version.id,
            filename: version.filename,
            mimeType: version.mimeType ?? null,
          };
          if (!pages?.length) return { ...base, supported: false as const, pages: [], tickets: [] };
          return {
            ...base,
            supported: true as const,
            pages,
            tickets: await tickets(
              context,
              input.nodeId,
              version.id,
              1,
              Math.min(batch, pages.length),
            ),
          };
        },
      }),
      pages: endpoint({
        operation,
        input: v.object({
          nodeId: v.id(),
          versionId: v.id(),
          from: v.number({ int: true, min: 1 }),
          to: v.number({ int: true, min: 1 }),
        }),
        target: (input) => ({ nodeId: input.nodeId }),
        async handler(context, input) {
          const { version } = await load(context, input.nodeId, input.versionId);
          const pages = await pagesOf(context, version);
          if (!pages?.length) throw new BetterFilesError('UNSUPPORTED', 'This file has no preview');
          const to = Math.min(input.to, pages.length, input.from + batch - 1);
          if (input.from > to) throw new BetterFilesError('INVALID_INPUT', 'No such pages');
          return { tickets: await tickets(context, input.nodeId, version.id, input.from, to) };
        },
      }),
    },
    hooks: {
      async transformDownload(input) {
        const match = pageVariant.exec(input.variant);
        if (!match) return undefined;
        const page = Number(match[1]);
        const bytes = await readAll(input.stream, maxBytes);
        const principal = input.context.principal;
        const at = input.context.now;
        const code = createHash('sha256')
          .update(`${principal.id}:${input.version.id}:${Math.floor(at / 60_000)}`)
          .digest('hex')
          .slice(0, 8)
          .toUpperCase();
        const stamp = watermark
          ? watermark({
              principalId: principal.id,
              at,
              code,
              ...(principal.name ? { name: principal.name } : {}),
              ...(principal.email ? { email: principal.email } : {}),
              ...(input.context.request?.ip ? { ip: input.context.request.ip } : {}),
            })
          : undefined;
        const source = await sourceOf(input.context, input.version, bytes);
        const rendered = await renderer.render({
          bytes: source.bytes,
          mimeType: source.mimeType,
          page,
          scale,
          ...(stamp ? { stamp } : {}),
        });
        return {
          stream: new Blob([rendered.bytes as Uint8Array<ArrayBuffer>]).stream(),
          mimeType: rendered.mimeType,
          filename: `page-${page}.${rendered.mimeType.split('/')[1]}`,
          size: rendered.bytes.byteLength,
        };
      },
    },
  });
}
