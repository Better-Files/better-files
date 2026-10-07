import {
  Capability,
  BetterFilesError,
  defineTable,
  definePlugin,
  endpoint,
  field,
  notFound,
  prefixedId,
  v,
  type DataRoomDocument,
  type DataRoomNode,
  type DocumentVersion,
  type MaintenanceContext,
  type PluginContext,
} from '@better-files/core';

export { libreOffice, type LibreOfficeOptions } from './libreoffice.js';

/** Turns a document into PDF. `libreOffice()` handles Office formats; wrap a conversion API the same way. */
export interface Converter {
  readonly id: string;
  accepts(input: { mimeType?: string; filename: string }): boolean;
  toPdf(input: { bytes: Uint8Array; filename: string; mimeType?: string }): Promise<Uint8Array>;
}

export interface ProcessingOptions {
  converters?: readonly Converter[];
  /** Thumbnail width in pixels, or `false` for none. Default 320. */
  thumbnails?: number | false;
  /** Largest file processed. Default 100 MiB. */
  maxBytes?: number;
  /** `background` (default) returns before processing finishes; `inline` waits (tests, scripts). */
  mode?: 'background' | 'inline';
}

export interface ProcessingJob {
  id: string;
  tenantId: string;
  roomId: string;
  documentId: string;
  versionId: string;
  status: 'done' | 'failed' | 'skipped';
  pdf: boolean;
  thumbnail: boolean;
  converter?: string;
  error?: string;
  attempts: number;
  updatedAt: number;
  createdAt: number;
}

const isPdf = (bytes: Uint8Array) => new TextDecoder().decode(bytes.subarray(0, 5)) === '%PDF-';
const isImage = (mimeType?: string) =>
  !!mimeType && /^image\/(png|jpe?g|webp|gif|avif|bmp)$/.test(mimeType);

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
      throw new BetterFilesError('PAYLOAD_TOO_LARGE', 'The file is too large to process');
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

async function thumbnail(
  source: Uint8Array,
  width: number,
): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  let image: Uint8Array = source;
  if (isPdf(source)) {
    const { renderPageAsImage } = await import('unpdf');
    image = new Uint8Array(
      await renderPageAsImage(new Uint8Array(source), 1, {
        canvasImport: () => import('@napi-rs/canvas'),
        width,
      }),
    );
  }
  const loaded = await loadImage(Buffer.from(image));
  const scale = Math.min(1, width / loaded.width);
  const w = Math.max(1, Math.round(loaded.width * scale));
  const h = Math.max(1, Math.round(loaded.height * scale));
  const canvas = createCanvas(w, h);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, w, h);
  context.drawImage(loaded, 0, 0, w, h);
  return { bytes: new Uint8Array(await canvas.encode('webp', 75)), width: w, height: h };
}

/**
 * Processing after upload: Office and other formats become a PDF rendition (so the viewer, watermarked downloads
 * and search work for them) and every document gets a thumbnail. Runs when a version is uploaded or passes a scan,
 * and retries failures from `dr.maintain()`. Renditions are encrypted like the file and deleted with it.
 */
export function processingPlugin(options: ProcessingOptions = {}) {
  const converters = options.converters ?? [];
  const width = options.thumbnails === undefined ? 320 : options.thumbnails;
  const maxBytes = options.maxBytes ?? 100 * 1024 * 1024;
  const inline = options.mode === 'inline';

  async function process(context: MaintenanceContext, tenantId: string, versionId: string) {
    const version = await context.db.findOne<DocumentVersion>('versions', {
      id: versionId,
      tenantId,
    });
    // Quarantined or still uploading: `version.scanned` or maintain() brings it back.
    if (!version || version.status !== 'ready') return;
    const existing = await context.db.findOne<ProcessingJob>('processingJobs', {
      tenantId,
      versionId,
    });
    const store = context.renditions(tenantId);
    const result: Pick<ProcessingJob, 'status' | 'pdf' | 'thumbnail'> & {
      converter?: string;
      error?: string;
    } = {
      status: 'skipped',
      pdf: false,
      thumbnail: false,
    };
    try {
      const bytes = await readAll(await context.readVersion(tenantId, versionId), maxBytes);
      let pdf: Uint8Array | undefined = isPdf(bytes) ? bytes : undefined;
      if (!pdf && !isImage(version.mimeType)) {
        const converter = converters.find((candidate) =>
          candidate.accepts({
            filename: version.filename,
            ...(version.mimeType ? { mimeType: version.mimeType } : {}),
          }),
        );
        if (converter) {
          pdf = await converter.toPdf({
            bytes,
            filename: version.filename,
            ...(version.mimeType ? { mimeType: version.mimeType } : {}),
          });
          if (!isPdf(pdf)) throw new Error(`${converter.id} did not produce a PDF`);
          await store.put({
            versionId,
            kind: 'pdf',
            mimeType: 'application/pdf',
            content: pdf,
            meta: { converter: converter.id },
          });
          result.pdf = true;
          result.converter = converter.id;
        }
      }
      if (width && (pdf || isImage(version.mimeType))) {
        const thumb = await thumbnail(pdf ?? bytes, width);
        await store.put({
          versionId,
          kind: 'thumbnail',
          mimeType: 'image/webp',
          content: thumb.bytes,
          meta: { width: thumb.width, height: thumb.height },
        });
        result.thumbnail = true;
      }
      if (result.pdf || result.thumbnail) result.status = 'done';
    } catch (error) {
      result.status = 'failed';
      result.error = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      context.logger.warn('Better Files processing failed', { versionId, error: result.error });
    }
    const now = Date.now();
    await context.db.transaction(async (tx) => {
      if (existing)
        await tx.update(
          'processingJobs',
          { id: existing.id, tenantId },
          {
            ...result,
            error: result.error ?? null,
            converter: result.converter ?? null,
            attempts: existing.attempts + 1,
            updatedAt: now,
          },
        );
      else
        await tx.insert('processingJobs', {
          id: prefixedId('proc', now),
          tenantId,
          roomId: version.roomId,
          documentId: version.documentId,
          versionId,
          attempts: 1,
          updatedAt: now,
          createdAt: now,
          ...result,
        });
    });
    await context.emit({
      type: 'version.processed',
      tenantId,
      roomId: version.roomId,
      data: {
        nodeId: version.documentId,
        versionId,
        status: result.status,
        pdf: result.pdf,
        thumbnail: result.thumbnail,
      },
    });
  }

  const run = (context: MaintenanceContext, tenantId: string, versionId: string) => {
    const work = process(context, tenantId, versionId).catch((error: unknown) =>
      context.logger.error('Better Files processing crashed', { versionId, error: String(error) }),
    );
    return inline ? work : undefined;
  };

  /** A MaintenanceContext over a request's context, for endpoints. */
  const asMaintenance = (context: PluginContext): MaintenanceContext => ({
    db: context.db,
    storage: context.storage,
    now: context.now,
    logger: context.logger,
    readVersion: (_tenantId, versionId) => context.readVersion(versionId),
    renditions: () => context.renditions,
    emit: async (event) => context.emit(event.type, event.data, { immediate: true }),
    enqueue: (_tenantId, name, payload, options) => context.enqueue(name, payload, options),
  });

  async function currentVersion(context: PluginContext, node: DataRoomNode) {
    if (node.kind !== 'document')
      throw new BetterFilesError('INVALID_INPUT', 'Only documents are processed');
    const document = await context.db.findOne<DataRoomDocument>('documents', {
      id: node.id,
      tenantId: context.tenantId,
    });
    if (!document?.currentVersionId) throw notFound('Version');
    return document.currentVersionId;
  }

  return definePlugin({
    id: 'processing',
    schema: {
      processingJobs: defineTable({
        fields: {
          roomId: field.string(),
          documentId: field.string(),
          versionId: field.string(),
          status: field.enum(['done', 'failed', 'skipped'] as const),
          pdf: field.boolean(),
          thumbnail: field.boolean(),
          converter: field.string({ required: false }),
          error: field.string({ required: false }),
          attempts: field.number(),
          updatedAt: field.timestamp(),
        },
        indexes: [
          { fields: ['tenantId', 'versionId'], unique: true },
          { fields: ['status', 'attempts'] },
        ],
      }),
    },
    async onEvent(event, context) {
      if (
        !['document.uploaded', 'version.created', 'version.scanned', 'version.restored'].includes(
          event.type,
        )
      )
        return;
      const versionId = event.data.versionId;
      if (typeof versionId === 'string') await run(context, event.tenantId, versionId);
    },
    async maintain(context) {
      const failed = await context.db.findMany<ProcessingJob>('processingJobs', {
        where: {
          status: 'failed',
          attempts: { lt: 3 },
          updatedAt: { lt: Date.now() - 5 * 60_000 },
        },
        limit: 20,
      });
      for (const job of failed) await process(context, job.tenantId, job.versionId);
    },
    endpoints: {
      status: endpoint({
        operation: {
          action: 'better-files:documents:view',
          target: 'node',
          capabilities: ['VIEW'],
          mutates: false,
        },
        input: v.object({ nodeId: v.id() }),
        target: (input) => ({ nodeId: input.nodeId }),
        async handler(context) {
          const versionId = await currentVersion(context, context.node!);
          const job = await context.db.findOne<ProcessingJob>('processingJobs', {
            tenantId: context.tenantId,
            versionId,
          });
          return {
            versionId,
            status: job?.status ?? ('pending' as const),
            pdf: job?.pdf ?? false,
            thumbnail: job?.thumbnail ?? false,
            ...(job?.error ? { error: job.error } : {}),
          };
        },
      }),
      /** Thumbnails of the current versions the caller may view, as data URLs, for listings. */
      thumbnails: endpoint({
        operation: {
          action: 'better-files:documents:list',
          target: 'room',
          mutates: false,
          allowClosed: true,
        },
        input: v.object({ roomId: v.id(), nodeIds: v.array(v.id(), { min: 1, max: 100 }) }),
        target: (input) => ({ roomId: input.roomId }),
        async handler(context, input) {
          const nodes = await context.db.findMany<DataRoomNode>('nodes', {
            where: {
              tenantId: context.tenantId,
              roomId: context.room!.id,
              id: { in: input.nodeIds },
              kind: 'document',
              deletedAt: { isNull: true },
            },
          });
          const masks = await context.capabilitiesOf(nodes);
          const out: Record<string, { url: string; width?: number; height?: number }> = {};
          for (const node of nodes) {
            if (((masks.get(node.id) ?? 0) & Capability.VIEW) === 0) continue;
            const document = await context.db.findOne<DataRoomDocument>('documents', {
              id: node.id,
              tenantId: context.tenantId,
            });
            if (!document?.currentVersionId) continue;
            const rendition = await context.renditions.get(document.currentVersionId, 'thumbnail');
            if (!rendition) continue;
            const bytes = await readAll(await rendition.read(), 2 * 1024 * 1024);
            out[node.id] = {
              url: `data:${rendition.mimeType};base64,${Buffer.from(bytes).toString('base64')}`,
              ...(typeof rendition.meta?.width === 'number' ? { width: rendition.meta.width } : {}),
              ...(typeof rendition.meta?.height === 'number'
                ? { height: rendition.meta.height }
                : {}),
            };
          }
          return out;
        },
      }),
      reprocess: endpoint({
        operation: {
          action: 'better-files:documents:edit',
          target: 'node',
          capabilities: ['EDIT'],
          mutates: true,
        },
        transaction: 'manual',
        input: v.object({ nodeId: v.id() }),
        target: (input) => ({ nodeId: input.nodeId }),
        async handler(context) {
          const versionId = await currentVersion(context, context.node!);
          await process(asMaintenance(context), context.tenantId, versionId);
          const job = await context.db.findOne<ProcessingJob>('processingJobs', {
            tenantId: context.tenantId,
            versionId,
          });
          return {
            versionId,
            status: job?.status ?? 'skipped',
            pdf: job?.pdf ?? false,
            thumbnail: job?.thumbnail ?? false,
          };
        },
      }),
    },
  });
}
