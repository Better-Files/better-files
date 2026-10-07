import {
  Capability,
  BetterFilesError,
  definePlugin,
  endpoint,
  notFound,
  v,
  type DataRoomDocument,
  type DataRoomNode,
  type DocumentVersion,
  type PluginContext,
} from '@better-files/core';

/** A rectangle to burn out. PDFs: points, origin bottom-left (as `find` returns them). Images: pixels, origin top-left. */
export interface RedactionArea {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RedactionMatch extends RedactionArea {
  /** The built-in pattern or `term` that matched. */
  rule: string;
  text: string;
}

export interface RedactionOptions {
  /** Host-defined patterns, trusted (user input never becomes a regular expression). */
  patterns?: Record<string, RegExp>;
  /** Render resolution of redacted PDF pages (1 = 72 dpi). Default 2. */
  scale?: number;
  /** Largest file processed. Default 100 MiB. */
  maxBytes?: number;
}

/** Built-in detectors. Opt in per request; review matches with `redaction.find` before applying. */
export const builtInPatterns: Record<string, RegExp> = {
  email: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
  phone: /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])\d{3,4}[\s.-]?\d{3,4}\b/g,
  ssn: /\b\d{3}-\d{2}-\d{4}\b/g,
  iban: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g,
  card: /\b(?:\d[ -]?){12,18}\d\b/g,
};

const isPdf = (bytes: Uint8Array) => new TextDecoder().decode(bytes.subarray(0, 5)) === '%PDF-';
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function load<T>(name: string, loader: () => Promise<T>): Promise<T> {
  try {
    return await loader();
  } catch {
    throw new BetterFilesError('UNSUPPORTED', `Redaction needs the ${name} package`);
  }
}

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
      throw new BetterFilesError('PAYLOAD_TOO_LARGE', 'The file is too large to redact');
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

/** Finds rules' matches in a PDF's text layer, with boxes in PDF points. */
export async function findInPdf(
  bytes: Uint8Array,
  rules: Record<string, RegExp>,
): Promise<RedactionMatch[]> {
  const { extractTextItems } = await load('unpdf', () => import('unpdf'));
  const { items } = await extractTextItems(new Uint8Array(bytes));
  const matches: RedactionMatch[] = [];
  items.forEach((pageItems, index) => {
    for (const item of pageItems) {
      if (!item.str) continue;
      for (const [rule, pattern] of Object.entries(rules)) {
        const global = new RegExp(
          pattern.source,
          pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
        );
        for (const match of item.str.matchAll(global)) {
          if (!match[0]) continue;
          const start = match.index ?? 0;
          const perChar = item.width / item.str.length;
          const height = Math.max(item.height, item.fontSize, 1);
          matches.push({
            page: index + 1,
            rule,
            text: match[0],
            // A little padding covers glyph overhangs and descenders.
            x: item.x + perChar * start - 1,
            y: item.y - height * 0.25 - 1,
            width: perChar * match[0].length + 2,
            height: height * 1.3 + 2,
          });
        }
      }
    }
  });
  return matches;
}

/**
 * Burns areas out of a PDF. Pages with redactions are rasterized with the boxes drawn in, so nothing under a box
 * survives (text, vectors, images); other pages are copied untouched. Document metadata is not carried over.
 */
export async function redactPdf(
  bytes: Uint8Array,
  areas: readonly RedactionArea[],
  scale = 2,
): Promise<Uint8Array> {
  const { PDFDocument } = await load('pdf-lib', () => import('pdf-lib'));
  const { renderPageAsImage } = await load('unpdf', () => import('unpdf'));
  const { createCanvas, loadImage } = await load(
    '@napi-rs/canvas',
    () => import('@napi-rs/canvas'),
  );
  const source = await PDFDocument.load(bytes);
  const out = await PDFDocument.create();
  out.setProducer('Better Files (redacted)');
  const byPage = new Map<number, RedactionArea[]>();
  for (const area of areas) byPage.set(area.page, [...(byPage.get(area.page) ?? []), area]);
  for (const page of byPage.keys())
    if (page < 1 || page > source.getPageCount())
      throw new BetterFilesError('INVALID_INPUT', `No page ${page}`);

  for (let index = 0; index < source.getPageCount(); index++) {
    const boxes = byPage.get(index + 1);
    if (!boxes) {
      const [copy] = await out.copyPages(source, [index]);
      out.addPage(copy!);
      continue;
    }
    const { width, height } = source.getPage(index).getSize();
    const png = await renderPageAsImage(new Uint8Array(bytes), index + 1, {
      canvasImport: () => import('@napi-rs/canvas'),
      scale,
    });
    const image = await loadImage(Buffer.from(png));
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, image.width, image.height);
    context.drawImage(image, 0, 0);
    const sx = image.width / width;
    const sy = image.height / height;
    context.fillStyle = '#000000';
    for (const box of boxes)
      context.fillRect(
        box.x * sx,
        (height - box.y - box.height) * sy,
        box.width * sx,
        box.height * sy,
      );
    const embedded = await out.embedPng(await canvas.encode('png'));
    out.addPage([width, height]).drawImage(embedded, { x: 0, y: 0, width, height });
  }
  return out.save();
}

/** Burns areas (pixels, origin top-left) out of an image; the result is PNG. */
export async function redactImage(
  bytes: Uint8Array,
  areas: readonly RedactionArea[],
): Promise<Uint8Array> {
  const { createCanvas, loadImage } = await load(
    '@napi-rs/canvas',
    () => import('@napi-rs/canvas'),
  );
  const image = await loadImage(Buffer.from(bytes));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  context.fillStyle = '#000000';
  for (const area of areas) {
    if (area.page !== 1) throw new BetterFilesError('INVALID_INPUT', 'Images have one page');
    context.fillRect(area.x, area.y, area.width, area.height);
  }
  return new Uint8Array(await canvas.encode('png'));
}

const areaSchema = v.object({
  page: v.number({ int: true, min: 1, max: 100_000 }),
  x: v.number(),
  y: v.number(),
  width: v.number({ min: 0 }),
  height: v.number({ min: 0 }),
});

/**
 * Redaction: `redaction.find` lists sensitive text in a PDF (built-in detectors, host patterns, literal terms) with
 * boxes to review; `redaction.apply` burns boxes and matches out as a new version or a redacted copy. Both need
 * `EDIT` on the document; a copy also needs `UPLOAD` on its folder. The activity log records counts, never the text.
 */
export function redactionPlugin(options: RedactionOptions = {}) {
  const patterns = { ...builtInPatterns, ...options.patterns };
  const maxBytes = options.maxBytes ?? 100 * 1024 * 1024;
  const scale = options.scale ?? 2;

  function rules(input: {
    patterns?: readonly string[] | undefined;
    terms?: readonly string[] | undefined;
  }) {
    const out: Record<string, RegExp> = {};
    for (const name of input.patterns ?? []) {
      const pattern = patterns[name];
      if (!pattern) throw new BetterFilesError('INVALID_INPUT', `Unknown pattern ${name}`);
      out[name] = pattern;
    }
    for (const term of input.terms ?? []) out[`term:${term}`] = new RegExp(escape(term), 'gi');
    return out;
  }

  async function source(context: PluginContext, versionId: string | undefined) {
    const node = context.node!;
    if (node.kind !== 'document')
      throw new BetterFilesError('INVALID_INPUT', 'Only documents can be redacted');
    const document = await context.db.findOne<DataRoomDocument>('documents', {
      id: node.id,
      tenantId: context.tenantId,
    });
    const id = versionId ?? document?.currentVersionId;
    const version = id
      ? await context.db.findOne<DocumentVersion>('versions', {
          id,
          tenantId: context.tenantId,
          documentId: node.id,
        })
      : undefined;
    if (!version) throw notFound('Version');
    if (version.status !== 'ready')
      throw new BetterFilesError('CONFLICT', `The file is ${version.status}`);
    const bytes = await readAll(await context.readVersion(version.id), maxBytes);
    return { node, version, bytes };
  }

  const ruleInput = {
    patterns: v.optional(v.array(v.string({ min: 1, max: 64 }), { max: 20 })),
    terms: v.optional(v.array(v.string({ min: 2, max: 200 }), { max: 100 })),
  };

  return definePlugin({
    id: 'redaction',
    endpoints: {
      find: endpoint({
        operation: {
          action: 'better-files:documents:edit',
          target: 'node',
          capabilities: ['EDIT'],
          mutates: false,
        },
        input: v.object({ nodeId: v.id(), versionId: v.optional(v.id()), ...ruleInput }),
        target: (input) => ({ nodeId: input.nodeId }),
        async handler(context, input) {
          const { version, bytes } = await source(context, input.versionId);
          if (!isPdf(bytes))
            throw new BetterFilesError(
              'UNSUPPORTED',
              'Text search works on PDFs; mark areas on images',
            );
          const matches = await findInPdf(bytes, rules(input));
          return { versionId: version.id, matches };
        },
      }),
      apply: endpoint({
        operation: {
          action: 'better-files:documents:edit',
          target: 'node',
          capabilities: ['EDIT'],
          mutates: true,
        },
        input: v.object({
          nodeId: v.id(),
          versionId: v.optional(v.id()),
          areas: v.optional(v.array(areaSchema, { max: 10_000 })),
          ...ruleInput,
          mode: v.optional(v.enum(['version', 'copy'] as const)),
          comment: v.optional(v.string({ max: 500 })),
        }),
        target: (input) => ({ nodeId: input.nodeId }),
        async handler(context, input) {
          const { node, version, bytes } = await source(context, input.versionId);
          const mode = input.mode ?? 'version';
          const pdf = isPdf(bytes);
          const matched =
            pdf && (input.patterns?.length || input.terms?.length)
              ? await findInPdf(bytes, rules(input))
              : [];
          if (!pdf && (input.patterns?.length || input.terms?.length))
            throw new BetterFilesError(
              'UNSUPPORTED',
              'Text search works on PDFs; mark areas on images',
            );
          const areas = [...(input.areas ?? []), ...matched];
          if (areas.length === 0) throw new BetterFilesError('INVALID_INPUT', 'Nothing to redact');
          let content: Uint8Array;
          let mimeType: string;
          let filename = version.filename;
          if (pdf) {
            content = await redactPdf(bytes, areas, scale);
            mimeType = 'application/pdf';
          } else if ((version.mimeType ?? '').startsWith('image/')) {
            content = await redactImage(bytes, areas);
            mimeType = 'image/png';
            filename = filename.replace(/\.[^.]+$/, '') + '.png';
          } else throw new BetterFilesError('UNSUPPORTED', 'Only PDFs and images can be redacted');

          if (mode === 'copy') {
            const parent = await context.db.findOne<DataRoomNode>('nodes', {
              id: node.parentId!,
              tenantId: context.tenantId,
            });
            const masks = parent
              ? await context.capabilitiesOf([parent])
              : new Map<string, number>();
            if (!parent || ((masks.get(parent.id) ?? 0) & Capability.UPLOAD) === 0)
              throw new BetterFilesError(
                'FORBIDDEN',
                'A redacted copy needs upload access to the folder',
              );
            const ext = filename.match(/\.[^.]+$/)?.[0] ?? '';
            filename = `${filename.slice(0, filename.length - ext.length)} (redacted)${ext}`;
          }
          const stored = await context.addDocument({
            ...(mode === 'copy' ? { parentId: node.parentId! } : { versionOf: node.id }),
            filename,
            mimeType,
            content,
            comment:
              input.comment ?? `Redacted ${areas.length} area${areas.length === 1 ? '' : 's'}`,
          });
          const pages = [...new Set(areas.map((area) => area.page))].sort((a, b) => a - b);
          await context.activity({
            roomId: node.roomId,
            action: 'document.redacted',
            nodeId: node.id,
            metadata: {
              mode,
              areas: areas.length,
              pages,
              rules: [
                ...new Set(
                  matched.map((match) => (match.rule.startsWith('term:') ? 'term' : match.rule)),
                ),
              ],
              sourceVersionId: version.id,
              resultNodeId: stored.nodeId,
            },
          });
          return {
            nodeId: stored.nodeId,
            versionId: stored.versionId,
            mode,
            areas: areas.length,
            pages,
          };
        },
      }),
    },
  });
}
