import { randomBytes } from 'node:crypto';
import { degrees, PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import {
  BetterFilesError,
  defineTable,
  definePlugin,
  endpoint,
  field,
  notFound,
  prefixedId,
  v,
  type DataRoomDocument,
  type DocumentVersion,
  type DownloadTransform,
  type DownloadTransformInput,
  type DownloadVariant,
} from '@better-files/core';
import { embedInPixels, extractForensicCode, markPdf, type ForensicMethod } from './forensic.js';

export {
  embedInPixels,
  extractForensicCode,
  extractFromPixels,
  type ForensicMatch,
  type ForensicMethod,
  type Pixels,
} from './forensic.js';

/** One watermarked copy: who received it, of what, when and from where. */
export interface WatermarkIssue {
  id: string;
  tenantId: string;
  roomId: string;
  nodeId: string;
  versionId: string;
  /** The forensic code stamped on the copy, visibly and hidden. */
  code: string;
  identityId: string;
  name?: string;
  email?: string;
  ip?: string;
  variant: DownloadVariant;
  filename: string;
  mimeType: string;
  /** Whether the hidden mark was embedded too (images under 64 × 56 pixels carry only the visible one). */
  hidden: boolean;
  createdAt: number;
}

export interface WatermarkContext {
  name: string;
  email: string;
  ip: string;
  /** ISO time of the download. */
  time: string;
  room: string;
  filename: string;
  /** A short forensic code unique to this copy; also emitted in the `document.watermarked` event. */
  code: string;
}

export interface WatermarkOptions {
  /** The stamped text. Default: `{email or name} · {time} · {ip} · {code}`. */
  text?: (context: WatermarkContext) => string;
  /** 0–1. Default 0.18. */
  opacity?: number;
  /** Points. Default 28. */
  fontSize?: number;
  /** Degrees counter-clockwise. Default 35. */
  angle?: number;
  /** RGB 0–1. Default a neutral grey. */
  color?: [number, number, number];
  /** Largest file stamped in memory, in bytes. Default 200 MiB. */
  maxBytes?: number;
  /** Also serve the `view` variant (inline, watermarked). Default true. */
  view?: boolean;
  /**
   * Hidden forensic marks that survive removal of the visible stamp: PDF keywords and invisible text, and a pixel mark
   * in images. `strength` is the image mark's step in luma levels (default 8; higher survives harsher
   * re-compression and is more visible). `false` stamps visibly only.
   */
  forensic?: false | { strength?: number };
  /** Record every watermarked copy for `watermark.trace` (the `watermarkIssues` table). Default true. */
  record?: boolean;
}

type Style = Required<Pick<WatermarkOptions, 'opacity' | 'fontSize' | 'angle' | 'color'>>;
type Hidden = { code: string; strength: number } | undefined;

const defaultText = (c: WatermarkContext) =>
  [c.email || c.name, c.time.replace('T', ' ').slice(0, 16) + ' UTC', c.ip, c.code]
    .filter(Boolean)
    .join('  ·  ');

type Kind = 'pdf' | 'image' | 'unsupported';

/** Content type from the declared MIME type, confirmed by the file's magic bytes (declared types can lie). */
function sniff(bytes: Uint8Array): Kind {
  const head = Buffer.from(bytes.subarray(0, 12));
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image';
  if (
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    head.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image';
  return 'unsupported';
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
      throw new BetterFilesError(
        'PAYLOAD_TOO_LARGE',
        'The file is too large to watermark; ask for the original',
      );
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

const streamOf = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

/**
 * Where to draw the stamp on a `width` × `height` surface (y up), rotated by `angle` degrees. The font shrinks (to
 * `minSize` at least) until one whole line fits, one copy sits in the middle, and staggered copies tile the rest, so
 * every part of the line, the identity included, shows on any page size and cropping one copy leaves others.
 * `widthAt` is the line's width at a font size.
 */
export function tileStamp(input: {
  width: number;
  height: number;
  angle: number;
  size: number;
  minSize?: number;
  widthAt: (size: number) => number;
}): { size: number; positions: [number, number][] } {
  const radians = (input.angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const unit = input.widthAt(1);
  const fits = Math.min(
    Math.abs(cos) > 1e-6 ? (0.9 * input.width) / Math.abs(cos) : Infinity,
    Math.abs(sin) > 1e-6 ? (0.9 * input.height) / Math.abs(sin) : Infinity,
  );
  const size = Math.max(input.minSize ?? 6, Math.min(input.size, fits / Math.max(unit, 1e-6)));
  const length = unit * size;
  // The line runs from its start point along (cos, sin); center the middle copy.
  const anchorX = input.width / 2 - (length / 2) * cos;
  const anchorY = input.height / 2 - (length / 2) * sin;
  const stepX = length + size * 4;
  const stepY = size * 7;
  const reach = input.width + input.height + length;
  const positions: [number, number][] = [];
  for (let row = -Math.ceil(reach / stepY); row <= Math.ceil(reach / stepY); row++)
    for (let col = -Math.ceil(reach / stepX) - 1; col <= Math.ceil(reach / stepX) + 1; col++) {
      // Rows are offset by half a step so line starts do not line up in one column.
      const x = anchorX + (col + (row % 2) / 2) * stepX;
      const y = anchorY + row * stepY;
      const xs = [x, x + length * cos];
      const ys = [y, y + length * sin];
      if (
        Math.max(...xs) + size >= 0 &&
        Math.min(...xs) - size <= input.width &&
        Math.max(...ys) + size >= 0 &&
        Math.min(...ys) - size <= input.height
      )
        positions.push([x, y]);
    }
  return { size, positions };
}

async function stampPdf(bytes: Uint8Array, text: string, options: Style, hidden: Hidden) {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const [r, g, b] = options.color;
  for (const page of pdf.getPages()) {
    const { width, height } = page.getSize();
    const { size, positions } = tileStamp({
      width,
      height,
      angle: options.angle,
      size: options.fontSize,
      widthAt: (at) => font.widthOfTextAtSize(text, at),
    });
    for (const [x, y] of positions)
      page.drawText(text, {
        x,
        y,
        size,
        font,
        color: rgb(r, g, b),
        opacity: options.opacity,
        rotate: degrees(options.angle),
      });
  }
  if (hidden) markPdf(pdf, font, hidden.code);
  pdf.setProducer('Better Files');
  return { bytes: await pdf.save(), hidden: hidden !== undefined };
}

async function stampImage(bytes: Uint8Array, text: string, options: Style, hidden: Hidden) {
  let sharp: typeof import('sharp');
  try {
    sharp = (await import('sharp')).default as unknown as typeof import('sharp');
  } catch {
    throw new BetterFilesError('UNSUPPORTED', 'Image watermarking needs the sharp package');
  }
  const image = sharp(Buffer.from(bytes));
  const { width = 1024, height = 1024, format, hasAlpha } = await image.metadata();
  const escaped = text.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const [r, g, b] = options.color.map((channel) => Math.round(channel * 255));
  // Helvetica averages a little over half an em per character; overestimate so lines are not cut short.
  const { size, positions } = tileStamp({
    width,
    height,
    angle: options.angle,
    size: Math.max(12, Math.round(Math.min(width, height) / 22)),
    minSize: 8,
    widthAt: (at) => text.length * at * 0.6,
  });
  // SVG's y axis points down: mirror the positions and the rotation.
  const lines = positions
    .map(([x, y]) => {
      const top = (height - y).toFixed(1);
      return `<text x="${x.toFixed(1)}" y="${top}" transform="rotate(${-options.angle} ${x.toFixed(1)} ${top})">${escaped}</text>`;
    })
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
<g font-family="Helvetica, Arial, sans-serif" font-size="${size.toFixed(1)}" fill="rgb(${r},${g},${b})" fill-opacity="${options.opacity}">${lines}</g></svg>`;
  let output = image.composite([{ input: Buffer.from(svg), top: 0, left: 0 }]);
  let marked = false;
  if (hidden) {
    // The pixel mark goes on top of the visible stamp, so the stamp does not disturb it.
    const { data, info } = await output.raw().toBuffer({ resolveWithObject: true });
    const pixels = { data, width: info.width, height: info.height, channels: info.channels };
    marked = embedInPixels(pixels, hidden.code, hidden.strength);
    output = sharp(data, {
      raw: { width: info.width, height: info.height, channels: info.channels },
    });
    if (!hasAlpha && info.channels === 4) output = output.removeAlpha();
  }
  const encoded =
    format === 'png'
      ? output.png()
      : format === 'webp'
        ? output.webp()
        : output.jpeg({ quality: 90 });
  return { bytes: new Uint8Array(await encoded.toBuffer()), hidden: marked };
}

/** Ten hex digits, unguessable: a code is a lookup key into who received which copy. */
const newCode = () => randomBytes(5).toString('hex').toUpperCase();

/**
 * Serves the `watermarked` download variant (and the `view` variant, inline) by stamping PDFs and images with who
 * downloaded them, when, from where, and a forensic code. Other file types are refused for these variants: people
 * who may only have watermarked copies never get an unmarked original.
 *
 * Each copy also carries the code hidden (see `forensic`) and is recorded, so a leaked copy leads back to its
 * recipient: `watermark.identify` reads the code from a copy uploaded to the room, `watermark.trace` looks a code up
 * across the tenant, and `extractForensicCode` reads it outside any request.
 */
export function watermarkPlugin(options: WatermarkOptions = {}) {
  const style: Style = {
    opacity: options.opacity ?? 0.18,
    fontSize: options.fontSize ?? 28,
    angle: options.angle ?? 35,
    color: options.color ?? ([0.35, 0.35, 0.4] as [number, number, number]),
  };
  const maxBytes = options.maxBytes ?? 200 * 1024 * 1024;
  const strength = options.forensic === false ? 0 : (options.forensic?.strength ?? 8);
  if (options.forensic !== false && !(strength >= 2 && strength <= 64))
    throw new BetterFilesError('INVALID_INPUT', 'forensic.strength must be between 2 and 64');
  const record = options.record !== false;

  return definePlugin({
    id: 'watermark',
    actions: ['better-files:watermark:read', 'better-files:watermark:trace'],
    accessModel: [
      { relations: ['owner', 'admin', 'auditor'], actions: ['better-files:watermark:read'] },
      { relations: ['owner', 'admin'], actions: ['better-files:watermark:trace'] },
    ],
    schema: {
      watermarkIssues: defineTable({
        fields: {
          roomId: field.string(),
          nodeId: field.string(),
          versionId: field.string(),
          code: field.string(),
          identityId: field.string(),
          name: field.string({ required: false }),
          email: field.string({ required: false }),
          ip: field.string({ required: false }),
          variant: field.string(),
          filename: field.string(),
          mimeType: field.string(),
          hidden: field.boolean(),
        },
        indexes: [
          { fields: ['tenantId', 'code'], unique: true },
          { fields: ['tenantId', 'roomId', 'nodeId'] },
        ],
      }),
    },
    hooks: {
      async transformDownload(
        input: DownloadTransformInput,
      ): Promise<DownloadTransform | undefined> {
        if (
          input.variant !== 'watermarked' &&
          !(input.variant === 'view' && options.view !== false)
        )
          return undefined;
        const bytes = await readAll(input.stream, maxBytes);
        const kind = sniff(bytes);
        const principal = input.context.principal;
        const time = new Date(input.context.now).toISOString();
        const code = newCode();
        const hidden: Hidden = strength ? { code, strength } : undefined;
        const context: WatermarkContext = {
          name: principal.name ?? '',
          email: principal.email ?? '',
          ip: input.context.request?.ip ?? '',
          time,
          room: input.room.name,
          filename: input.version.filename,
          code,
        };
        const text = (options.text ?? defaultText)(context);
        let stamped: { bytes: Uint8Array; hidden: boolean };
        let mimeType: string;
        let filename: string | undefined;
        // Office and other formats: stamp their PDF rendition (from the processing plugin) when there is one.
        const rendition =
          kind === 'unsupported'
            ? await input.context.renditions.get(input.version.id, 'pdf')
            : undefined;
        if (kind === 'pdf') {
          stamped = await stampPdf(bytes, text, style, hidden);
          mimeType = 'application/pdf';
        } else if (kind === 'image') {
          stamped = await stampImage(bytes, text, style, hidden);
          mimeType = input.mimeType.startsWith('image/') ? input.mimeType : 'image/jpeg';
        } else if (rendition) {
          stamped = await stampPdf(
            await readAll(await rendition.read(), maxBytes),
            text,
            style,
            hidden,
          );
          mimeType = 'application/pdf';
          filename = `${input.version.filename.replace(/\.[^.]+$/, '')}.pdf`;
        } else
          throw new BetterFilesError(
            'UNSUPPORTED',
            'This file type cannot be watermarked; ask a room administrator for access to the original',
          );
        if (record) {
          const issue: WatermarkIssue = {
            id: prefixedId('wmk', input.context.now),
            tenantId: input.context.tenantId,
            roomId: input.room.id,
            nodeId: input.document.id,
            versionId: input.version.id,
            code,
            identityId: principal.id,
            ...(principal.name ? { name: principal.name } : {}),
            ...(principal.email ? { email: principal.email } : {}),
            ...(input.context.request?.ip ? { ip: input.context.request.ip } : {}),
            variant: input.variant,
            filename: filename ?? input.version.filename,
            mimeType,
            hidden: stamped.hidden,
            createdAt: input.context.now,
          };
          // Recorded before the copy leaves: a copy that cannot be traced is not served.
          await input.context.db.transaction((tx) => tx.insert('watermarkIssues', issue));
        }
        input.context.emit('document.watermarked', {
          nodeId: input.document.id,
          versionId: input.version.id,
          principalId: principal.id,
          code,
          variant: input.variant,
          hidden: stamped.hidden,
        });
        return {
          stream: streamOf(stamped.bytes),
          mimeType,
          size: stamped.bytes.byteLength,
          ...(filename ? { filename } : {}),
        };
      },
    },
    endpoints: {
      /** Who received the copy carrying `code`, anywhere in the tenant (tenant administrators). */
      trace: endpoint({
        operation: { action: 'better-files:watermark:trace', target: 'tenant', mutates: false },
        input: v.object({ code: v.string({ pattern: /^[0-9A-Fa-f]{10}$/ }) }),
        async handler(context, input) {
          const issue = await context.db.findOne<WatermarkIssue>('watermarkIssues', {
            tenantId: context.tenantId,
            code: input.code.toUpperCase(),
          });
          if (!issue) throw notFound('Watermarked copy');
          return issue;
        },
      }),
      /** The watermarked copies handed out in a room, newest first; filter by document, recipient or code. */
      issues: endpoint({
        operation: {
          action: 'better-files:watermark:read',
          target: 'room',
          mutates: false,
          allowClosed: true,
        },
        input: v.object({
          roomId: v.id(),
          nodeId: v.optional(v.id()),
          identityId: v.optional(v.string({ min: 1, max: 200 })),
          code: v.optional(v.string({ pattern: /^[0-9A-Fa-f]{10}$/ })),
          limit: v.optional(v.number({ int: true, min: 1, max: 1000 })),
        }),
        target: (input) => ({ roomId: input.roomId }),
        async handler(context, input) {
          return context.db.findMany<WatermarkIssue>('watermarkIssues', {
            where: {
              tenantId: context.tenantId,
              roomId: context.room!.id,
              ...(input.nodeId ? { nodeId: input.nodeId } : {}),
              ...(input.identityId ? { identityId: input.identityId } : {}),
              ...(input.code ? { code: input.code.toUpperCase() } : {}),
            },
            orderBy: [{ field: 'createdAt', direction: 'desc' }],
            limit: input.limit ?? 100,
          });
        },
      }),
      /**
       * Reads the forensic code from a document in the room (a leaked copy someone uploaded) and says whose copy it
       * was. Copies issued in other rooms are reported without their details; tenant administrators use `trace`.
       */
      identify: endpoint({
        operation: {
          action: 'better-files:watermark:trace',
          target: 'node',
          capabilities: ['MANAGE'],
          mutates: false,
          allowClosed: true,
        },
        input: v.object({ nodeId: v.id(), versionId: v.optional(v.id()) }),
        target: (input) => ({ nodeId: input.nodeId }),
        async handler(context, input) {
          const node = context.node!;
          if (node.kind !== 'document')
            throw new BetterFilesError('INVALID_INPUT', 'Only documents carry watermarks');
          const document = await context.db.findOne<DataRoomDocument>('documents', {
            id: node.id,
            tenantId: context.tenantId,
          });
          const id = input.versionId ?? document?.currentVersionId;
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
          const match = await extractForensicCode(
            await readAll(await context.readVersion(version.id), maxBytes),
            strength ? { strength } : {},
          );
          const result: {
            versionId: string;
            code: string | null;
            method: ForensicMethod | null;
            issue: WatermarkIssue | null;
            otherRoom: boolean;
          } = { versionId: version.id, code: null, method: null, issue: null, otherRoom: false };
          if (!match) return result;
          const issue = await context.db.findOne<WatermarkIssue>('watermarkIssues', {
            tenantId: context.tenantId,
            code: match.code,
          });
          const here = issue?.roomId === context.room!.id;
          await context.activity({
            roomId: context.room!.id,
            nodeId: node.id,
            action: 'watermark.identified',
            metadata: {
              code: match.code,
              method: match.method,
              ...(here ? { recipientId: issue.identityId } : {}),
            },
          });
          return {
            ...result,
            code: match.code,
            method: match.method,
            issue: here ? issue : null,
            otherRoom: issue !== undefined && !here,
          };
        },
      }),
    },
  });
}

export { sniff as sniffWatermarkable };
