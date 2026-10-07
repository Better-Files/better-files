import {
  BetterFilesError,
  definePlugin,
  endpoint,
  notFound,
  v,
  type DataRoomDocument,
  type DocumentVersion,
} from '@better-files/core';
import { textExtractor, type TextExtractor } from './tools.js';

export interface McpPluginOptions {
  /** Text extractors; the search plugin's `pdfExtractor` adds PDF. Default: UTF-8 text formats. */
  extractors?: readonly TextExtractor[];
  /** Largest file read. Default 25 MiB. */
  maxBytes?: number;
}

async function readBytes(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array | undefined> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return undefined;
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

/**
 * Lets agents read the text of documents the caller may VIEW, without a viewer plugin: `mcp.readText`. Each read is
 * a regular view request first (document state, NDA and network hooks, the `document.viewed` activity record), then
 * the text is extracted on the server; the file itself never leaves. Install it when on-screen viewing and text
 * access are equivalent for your rooms, which is the usual reading of "view only".
 */
export function mcpPlugin(options: McpPluginOptions = {}) {
  const extractors = options.extractors ?? [textExtractor];
  const maxBytes = options.maxBytes ?? 25 * 1024 * 1024;

  return definePlugin({
    id: 'mcp',
    endpoints: {
      readText: endpoint({
        operation: {
          action: 'better-files:documents:view',
          target: 'node',
          capabilities: ['VIEW'],
          mutates: false,
        },
        input: v.object({
          nodeId: v.id(),
          versionId: v.optional(v.id()),
          offset: v.optional(v.number({ int: true, min: 0 })),
          limit: v.optional(v.number({ int: true, min: 1, max: 500_000 })),
        }),
        target: (input) => ({ nodeId: input.nodeId }),
        async handler(context, input) {
          const node = context.node!;
          if (node.kind !== 'document')
            throw new BetterFilesError('INVALID_INPUT', 'Only documents have text');
          await context.call('documents.requestView', {
            nodeId: node.id,
            ...(input.versionId ? { versionId: input.versionId } : {}),
          });
          const document = await context.db.findOne<DataRoomDocument>('documents', {
            id: node.id,
            tenantId: context.tenantId,
          });
          const versionId = input.versionId ?? document?.currentVersionId;
          const version = versionId
            ? await context.db.findOne<DocumentVersion>('versions', {
                id: versionId,
                tenantId: context.tenantId,
                documentId: node.id,
              })
            : undefined;
          if (!version) throw notFound('Version');
          const base = {
            filename: version.filename,
            mimeType: version.mimeType,
            size: version.size,
          };
          if (version.size > maxBytes)
            return { ...base, readable: false as const, reason: 'too-large' as const };
          const probe = {
            filename: version.filename,
            head: new Uint8Array(0),
            ...(version.mimeType ? { mimeType: version.mimeType } : {}),
          };
          // Most extractors decide by type or name; content sniffing needs the first bytes, so read before deciding.
          const bytes = await readBytes(await context.readVersion(version.id), maxBytes);
          if (!bytes) return { ...base, readable: false as const, reason: 'too-large' as const };
          const extractor = extractors.find((candidate) =>
            candidate.accepts({ ...probe, head: bytes.subarray(0, 1024) }),
          );
          if (!extractor)
            return { ...base, readable: false as const, reason: 'unsupported-type' as const };
          const text = await extractor.extract(bytes);
          const offset = Math.min(input.offset ?? 0, text.length);
          const page = text.slice(offset, offset + (input.limit ?? 30_000));
          const end = offset + page.length;
          return {
            ...base,
            readable: true as const,
            text: page,
            offset,
            totalChars: text.length,
            ...(end < text.length ? { nextOffset: end } : {}),
          };
        },
      }),
    },
  });
}
