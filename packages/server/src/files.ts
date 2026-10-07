import { createHash } from 'node:crypto';
import {
  BetterFilesError,
  createId,
  invalidInput,
  notFound,
  regionKeyPrefix,
  type BlobRecord,
  type ByteSource,
  type DataRoomDocument,
  type DataRoomNode,
  type DocumentVersion,
  type DownloadTransform,
  type EncryptionContext,
  type Room,
  type RoomExport,
  type Ticket,
  type Upload,
  type UploadPart,
} from '@better-files/core';
import {
  base64url,
  ciphertextRange,
  createNoncePrefix,
  decryptStream,
  encryptedSize,
  encryptStream,
  fromBase64url,
  hashingStream,
  limitStream,
  randomId,
  SEGMENT_SIZE,
  segmentCount,
} from '@better-files/crypto';
import { verifyActivity } from './activity.js';
import type { CoreContext, Engine } from './engine.js';
import { createContext } from './pipeline.js';
import { zipStream } from './zip.js';

const toStream = (source: ByteSource): ReadableStream<Uint8Array> => {
  if (source instanceof ReadableStream) return source;
  if (source instanceof Uint8Array)
    return new ReadableStream({
      start(controller) {
        controller.enqueue(source);
        controller.close();
      },
    });
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
  });
};

/** Storage keys never contain tenant or room ids verbatim (they may hold any character); they hash them. */
const segment = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
/** A room with a residency region keeps its objects under `g/{region}/`, which `regionalStorage` routes on. */
export const storageKeyFor = (tenantId: string, roomId: string, blobId: string, region?: string) =>
  `${region ? regionKeyPrefix(region) : ''}t/${segment(tenantId)}/r/${segment(roomId)}/${blobId}`;

const encryptionContext = (
  blob: Pick<BlobRecord, 'id' | 'tenantId' | 'roomId'>,
): EncryptionContext => ({
  purpose: 'better-files-blob',
  tenantId: blob.tenantId,
  roomId: blob.roomId,
  blobId: blob.id,
});

export function createFiles(engine: Engine) {
  const encrypting = engine.keys !== undefined;

  /** A fresh blob record with its wrapped data key; the plaintext key is never stored. */
  async function newBlob(input: {
    tenantId: string;
    room: Room;
    size: number;
    now: number;
  }): Promise<BlobRecord> {
    const id = createId('blob', input.now);
    const base = {
      id,
      tenantId: input.tenantId,
      roomId: input.room.id,
      createdAt: input.now,
      size: input.size,
      storedSize: encrypting ? encryptedSize(input.size) : input.size,
      storageKey: storageKeyFor(input.tenantId, input.room.id, id, input.room.region),
    };
    if (!engine.keys) return base;
    const key = await engine.keys.generateDataKey({
      tenantId: input.tenantId,
      ...(input.room.kmsKeyId ? { keyRef: input.room.kmsKeyId } : {}),
      context: encryptionContext(base),
    });
    key.plaintext.fill(0);
    return {
      ...base,
      wrappedKey: key.wrapped,
      keyRef: key.keyRef,
      encryption: {
        algorithm: 'AES-256-GCM-STREAM',
        segmentSize: SEGMENT_SIZE,
        noncePrefix: base64url(createNoncePrefix()),
      },
    };
  }

  async function dataKey(blob: BlobRecord): Promise<Uint8Array> {
    if (!engine.keys || !blob.wrappedKey || !blob.keyRef)
      throw new BetterFilesError('INTERNAL_ERROR', 'The blob has no data key');
    return engine.keys.decryptDataKey({
      tenantId: blob.tenantId,
      keyRef: blob.keyRef,
      wrapped: blob.wrappedKey,
      context: encryptionContext(blob),
    });
  }

  const segmentOptions = (blob: BlobRecord, key: Uint8Array) => ({
    key,
    noncePrefix: fromBase64url(blob.encryption!.noncePrefix),
    aad: new TextEncoder().encode(blob.id),
    segmentSize: blob.encryption!.segmentSize,
    totalSegments: segmentCount(blob.size, blob.encryption!.segmentSize),
  });

  /** Plaintext range [start, end) of one part. */
  const partBounds = (upload: Upload, part: number) => {
    const start = (part - 1) * upload.partSize;
    return { start, end: Math.min(start + upload.partSize, upload.size) };
  };
  const partCount = (upload: Upload) => Math.max(1, Math.ceil(upload.size / upload.partSize));

  /** Receives the whole file (`part` undefined) or one part of a multipart upload, encrypting as it streams. */
  async function receive(
    upload: Upload,
    body: ByteSource,
    part?: number,
  ): Promise<{ size: number; sha256?: string }> {
    const blob = await engine.db.findOne<BlobRecord>('blobs', {
      id: upload.blobId,
      tenantId: upload.tenantId,
    });
    if (!blob) throw notFound('Upload');
    const key = blob.encryption ? await dataKey(blob) : undefined;
    try {
      if (part === undefined) {
        if (upload.multipartId) throw invalidInput('This upload takes parts');
        const hashing = hashingStream();
        let stream = toStream(body)
          .pipeThrough(limitStream(upload.size))
          .pipeThrough(hashing.stream);
        if (key)
          stream = stream.pipeThrough(
            encryptStream({ ...segmentOptions(blob, key), firstSegment: 0 }),
          );
        await engine.storage.put(upload.storageKey, stream, { contentLength: blob.storedSize });
        const digest = await hashing.digest;
        if (digest.size !== upload.size) {
          await engine.storage.delete(upload.storageKey);
          throw invalidInput(`Expected ${upload.size} bytes, received ${digest.size}`);
        }
        return digest;
      }
      if (!upload.multipartId || !engine.storage.multipart)
        throw invalidInput('This upload takes the whole file');
      if (!Number.isInteger(part) || part < 1 || part > partCount(upload))
        throw invalidInput('Invalid part number');
      const bounds = partBounds(upload, part);
      const expected = bounds.end - bounds.start;
      const hashing = hashingStream();
      let stream = toStream(body).pipeThrough(limitStream(expected)).pipeThrough(hashing.stream);
      if (key)
        stream = stream.pipeThrough(
          encryptStream({
            ...segmentOptions(blob, key),
            firstSegment: bounds.start / blob.encryption!.segmentSize,
          }),
        );
      const { etag } = await engine.storage.multipart.uploadPart(
        upload.storageKey,
        upload.multipartId,
        part,
        stream,
      );
      const digest = await hashing.digest;
      if (digest.size !== expected)
        throw invalidInput(`Part ${part} must be ${expected} bytes, received ${digest.size}`);
      await engine.db.transaction(async (tx) => {
        const existing = await tx.findOne<UploadPart>('uploadParts', {
          tenantId: upload.tenantId,
          uploadId: upload.id,
          part,
        });
        if (existing)
          await tx.update(
            'uploadParts',
            { id: existing.id, tenantId: upload.tenantId },
            { etag, size: expected },
          );
        else
          await tx.insert('uploadParts', {
            id: createId('upload', engine.clock.now()),
            tenantId: upload.tenantId,
            uploadId: upload.id,
            part,
            etag,
            size: expected,
            createdAt: engine.clock.now(),
          });
      });
      return { size: expected };
    } finally {
      key?.fill(0);
    }
  }

  /** Decrypted content of a blob, optionally a byte range (inclusive end). */
  async function read(
    blob: BlobRecord,
    range?: { start: number; end: number },
  ): Promise<ReadableStream<Uint8Array>> {
    if (!blob.encryption) return engine.storage.get(blob.storageKey, range);
    const key = await dataKey(blob);
    const options = segmentOptions(blob, key);
    if (!range) {
      const stored = await engine.storage.get(blob.storageKey);
      return stored.pipeThrough(decryptStream({ ...options, length: blob.size }));
    }
    const mapped = ciphertextRange(range, blob.size, options.segmentSize);
    const stored = await engine.storage.get(blob.storageKey, {
      start: mapped.start,
      end: mapped.end,
    });
    return stored.pipeThrough(
      decryptStream({
        ...options,
        firstSegment: mapped.firstSegment,
        skip: mapped.skip,
        length: mapped.length,
      }),
    );
  }

  /** Encrypts and stores bytes produced on the server (plugin outputs such as signed PDFs). */
  async function storeBytes(blob: BlobRecord, bytes: Uint8Array): Promise<string> {
    const hashing = hashingStream();
    let stream = toStream(bytes).pipeThrough(hashing.stream);
    const key = blob.encryption ? await dataKey(blob) : undefined;
    try {
      if (key)
        stream = stream.pipeThrough(
          encryptStream({ ...segmentOptions(blob, key), firstSegment: 0 }),
        );
      await engine.storage.put(blob.storageKey, stream, { contentLength: blob.storedSize });
    } finally {
      key?.fill(0);
    }
    return (await hashing.digest).sha256;
  }

  /** Decrypted content of a version, for plugins (scanners, converters, indexers). */
  async function readVersion(
    tenantId: string,
    versionId: string,
  ): Promise<ReadableStream<Uint8Array>> {
    const version = await engine.db.findOne<DocumentVersion>('versions', {
      id: versionId,
      tenantId,
    });
    if (!version?.blobId) throw notFound('Version');
    const blob = await engine.db.findOne<BlobRecord>('blobs', { id: version.blobId, tenantId });
    if (!blob) throw notFound('Version');
    return read(blob);
  }

  /** Assembles a multipart upload and verifies the stored size and the content hash. */
  /**
   * Direct uploads: presigned part URLs plus what the client needs to encrypt exactly as `receive` would (the data
   * key, nonce prefix and AAD of this one blob). `finish` then reads the file back, which proves every segment
   * decrypts and yields the SHA-256, so a client that encrypts wrongly cannot complete the upload.
   */
  async function directUpload(upload: Upload, blob: BlobRecord, expiresInSeconds: number) {
    const presign = engine.storage.multipart?.presignPart;
    if (!upload.multipartId || !presign)
      throw new BetterFilesError(
        'UNSUPPORTED',
        'The storage adapter does not support direct uploads',
      );
    const parts: { part: number; url: string }[] = [];
    for (let part = 1; part <= partCount(upload); part++)
      parts.push({
        part,
        url: await presign.call(
          engine.storage.multipart,
          upload.storageKey,
          upload.multipartId,
          part,
          {
            expiresInSeconds,
          },
        ),
      });
    let encryption: {
      algorithm: 'AES-256-GCM-STREAM';
      key: string;
      noncePrefix: string;
      aad: string;
      segmentSize: number;
    } | null = null;
    if (blob.encryption) {
      const key = await dataKey(blob);
      try {
        encryption = {
          algorithm: 'AES-256-GCM-STREAM',
          key: base64url(key),
          noncePrefix: blob.encryption.noncePrefix,
          aad: base64url(new TextEncoder().encode(blob.id)),
          segmentSize: blob.encryption.segmentSize,
        };
      } finally {
        key.fill(0);
      }
    }
    return { partSize: upload.partSize, parts, encryption };
  }

  async function finish(upload: Upload): Promise<{ sha256: string }> {
    const blob = await engine.db.findOne<BlobRecord>('blobs', {
      id: upload.blobId,
      tenantId: upload.tenantId,
    });
    if (!blob) throw notFound('Upload');
    if (upload.multipartId) {
      const parts = await engine.db.findMany<UploadPart>('uploadParts', {
        where: { tenantId: upload.tenantId, uploadId: upload.id },
        orderBy: [{ field: 'part' }],
      });
      const count = partCount(upload);
      if (parts.length !== count || parts.some((p, index) => p.part !== index + 1))
        throw invalidInput(`Upload all ${count} parts before completing`);
      await engine.storage.multipart!.complete(
        upload.storageKey,
        upload.multipartId,
        parts.map(({ part, etag }) => ({ part, etag })),
      );
    }
    const head = await engine.storage.head(upload.storageKey);
    if (!head || head.size !== blob.storedSize) throw invalidInput('The upload is incomplete');
    let sha256 = upload.receivedSha256;
    if (!sha256) {
      // Multipart uploads are hashed by reading them back, which also proves every segment decrypts.
      const hashing = hashingStream();
      try {
        const reader = (await read(blob)).pipeThrough(hashing.stream).getReader();
        while (!(await reader.read()).done);
      } catch {
        // Parts that do not decrypt (a direct upload encrypted wrongly, or tampered with) are never accepted.
        await engine.storage.delete(upload.storageKey).catch(() => undefined);
        throw invalidInput(
          'The uploaded parts failed their integrity check; upload the file again',
        );
      }
      sha256 = (await hashing.digest).sha256;
    }
    if (upload.sha256 && upload.sha256.toLowerCase() !== sha256) {
      await engine.storage.delete(upload.storageKey);
      throw invalidInput('The file does not match its SHA-256 checksum');
    }
    return { sha256 };
  }

  async function issueTicket(
    context: CoreContext,
    input: {
      room: Room;
      document: DataRoomDocument;
      version: DocumentVersion;
      variant: string;
      disposition: 'attachment' | 'inline';
      /** Who the copy is for, when not the caller (share-link visitors). */
      recipient?: { id: string; name?: string; email?: string };
    },
  ) {
    const recipient = input.recipient ?? context.principal;
    const id = `tkt_${randomId()}`;
    const now = engine.clock.now();
    const expiresAt = now + engine.limits.ticketTtlMs;
    await context.db.transaction((tx) =>
      tx.insert('tickets', {
        id,
        tenantId: context.tenantId,
        roomId: input.room.id,
        principalId: recipient.id,
        documentId: input.document.id,
        versionId: input.version.id,
        variant: input.variant,
        disposition: input.disposition,
        uses: 0,
        maxUses: engine.limits.ticketUses,
        meta: {
          name: recipient.name ?? '',
          email: recipient.email ?? '',
          ...(context.request?.ip ? { ip: context.request.ip } : {}),
        },
        expiresAt,
        createdAt: now,
      }),
    );
    const token = engine.tickets.sign(id);
    return { token, url: `${engine.basePath}/files/${token}`, expiresAt };
  }

  /** A single-use-limited ticket for a prepared room export. */
  async function issueExportTicket(context: CoreContext, record: RoomExport) {
    const id = `tkt_${randomId()}`;
    const now = engine.clock.now();
    await context.db.transaction((tx) =>
      tx.insert('tickets', {
        id,
        tenantId: record.tenantId,
        roomId: record.roomId,
        principalId: record.principalId,
        documentId: record.id,
        versionId: record.id,
        variant: 'export',
        disposition: 'attachment',
        uses: 0,
        maxUses: 2,
        // Who asked, for watermarks stamped as a folder download is zipped.
        meta: {
          name: context.principal.name ?? '',
          email: context.principal.email ?? '',
          ...(context.request?.ip ? { ip: context.request.ip } : {}),
        },
        expiresAt: record.expiresAt,
        createdAt: now,
      }),
    );
    const token = engine.tickets.sign(id);
    return { token, url: `${engine.basePath}/files/${token}`, expiresAt: record.expiresAt };
  }

  async function exportResponse(
    ticket: Ticket,
    headers: Record<string, string>,
  ): Promise<Response> {
    const record = await engine.db.findOne<RoomExport>('exports', {
      id: ticket.documentId,
      tenantId: ticket.tenantId,
    });
    const room = await engine.db.findOne<Room>('rooms', {
      id: ticket.roomId,
      tenantId: ticket.tenantId,
    });
    if (!record || !room) return new Response(null, { status: 404 });
    if (record.folderId) return folderResponse(ticket, record, room, headers);
    const chain = record.includeActivity
      ? await verifyActivity(engine.db, ticket.tenantId, room.id)
      : undefined;
    const csv = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const index = [
      'path,version,size,sha256',
      ...record.items.map((item) =>
        [item.path, item.versionId, item.size, item.sha256 ?? ''].map(csv).join(','),
      ),
    ].join('\n');
    const manifest = {
      room: { id: room.id, name: room.name, slug: room.slug, status: room.status },
      generatedAt: new Date(record.createdAt).toISOString(),
      generatedBy: record.principalId,
      files: record.items,
      excluded: record.excluded,
      ...(chain ? { activity: chain } : {}),
    };
    const encoder = new TextEncoder();
    async function* entries() {
      yield {
        name: 'manifest.json',
        content: async () => encoder.encode(JSON.stringify(manifest, null, 2)),
      };
      yield { name: 'index.csv', content: async () => encoder.encode(index) };
      for (const item of record!.items)
        yield {
          name: `documents/${item.path}`,
          content: async () => {
            const version = await engine.db.findOne<DocumentVersion>('versions', {
              id: item.versionId,
              tenantId: ticket.tenantId,
            });
            const blob = version?.blobId
              ? await engine.db.findOne<BlobRecord>('blobs', {
                  id: version.blobId,
                  tenantId: ticket.tenantId,
                })
              : null;
            if (!blob) return encoder.encode('');
            return read(blob);
          },
        };
      if (record!.includeActivity)
        yield {
          name: 'activity.jsonl',
          content: async () => {
            const lines: string[] = [];
            for (let offset = 0; ; offset += 500) {
              const page = await engine.db.findMany<Record<string, unknown>>('activity', {
                where: { tenantId: ticket.tenantId, roomId: room!.id },
                orderBy: [{ field: 'sequence' }],
                limit: 500,
                offset,
              });
              for (const { tenantId: _tenant, ...entry } of page) lines.push(JSON.stringify(entry));
              if (page.length < 500) break;
            }
            return encoder.encode(lines.join('\n'));
          },
        };
    }
    headers['content-type'] = 'application/zip';
    headers['content-disposition'] = contentDisposition('attachment', `${room.slug}-export.zip`);
    return new Response(zipStream(entries()), { status: 200, headers });
  }

  /**
   * A folder download: its documents in index order plus `index.csv`. Watermarked bundles run every file through
   * the download-transform hooks for the requester; a file no hook can stamp is left out (with a note), never
   * replaced by its original.
   */
  async function folderResponse(
    ticket: Ticket,
    record: RoomExport,
    room: Room,
    headers: Record<string, string>,
  ): Promise<Response> {
    const encoder = new TextEncoder();
    const watermarked = record.variant === 'watermarked';
    const principal = {
      id: ticket.principalId,
      tenantId: ticket.tenantId,
      kind: 'user' as const,
      groups: [],
      guest: false,
      mfa: false,
      ...(ticket.meta?.name ? { name: ticket.meta.name } : {}),
      ...(ticket.meta?.email ? { email: ticket.meta.email } : {}),
    };
    const scope = createContext(engine, {
      tenantId: ticket.tenantId,
      principal,
      credential: {},
      ...(ticket.meta?.ip ? { request: { ip: ticket.meta.ip } } : {}),
    });
    const skipped: string[] = [];
    const csv = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    async function* entries() {
      for (const item of record.items) {
        const [version, node, document] = await Promise.all([
          engine.db.findOne<DocumentVersion>('versions', {
            id: item.versionId,
            tenantId: ticket.tenantId,
          }),
          item.nodeId
            ? engine.db.findOne<DataRoomNode>('nodes', {
                id: item.nodeId,
                tenantId: ticket.tenantId,
              })
            : null,
          item.nodeId
            ? engine.db.findOne<DataRoomDocument>('documents', {
                id: item.nodeId,
                tenantId: ticket.tenantId,
              })
            : null,
        ]);
        const blob = version?.blobId
          ? await engine.db.findOne<BlobRecord>('blobs', {
              id: version.blobId,
              tenantId: ticket.tenantId,
            })
          : null;
        if (!version || !blob || !node || node.deletedAt !== undefined || !document) {
          skipped.push(`${item.path} (no longer available)`);
          continue;
        }
        if (!watermarked) {
          yield { name: item.path, content: () => read(blob) };
          continue;
        }
        let transformed: DownloadTransform | undefined;
        const context = scope.make(engine.db, { room, node });
        for (const hooks of engine.hooks) {
          if (!hooks.transformDownload) continue;
          const original = await read(blob);
          try {
            transformed = await hooks.transformDownload({
              context,
              room,
              node,
              variant: 'watermarked',
              document,
              version,
              mimeType: version.mimeType ?? 'application/octet-stream',
              stream: original,
            });
          } catch (error) {
            // One file that cannot be stamped must not break the whole archive mid-stream.
            if (!(error instanceof BetterFilesError))
              engine.logger.error('Watermarking a folder download failed', {
                path: item.path,
                error: String(error),
              });
            await original.cancel().catch(() => undefined);
            transformed = undefined;
            break;
          }
          if (transformed) break;
          await original.cancel().catch(() => undefined);
        }
        if (!transformed) {
          skipped.push(`${item.path} (cannot be watermarked)`);
          continue;
        }
        const stream = transformed.stream;
        const renamed = transformed.filename
          ? item.path.replace(/[^/]+$/, transformed.filename.replace(/[\\/]/g, '_'))
          : item.path;
        yield { name: renamed, content: async () => stream };
      }
      await scope.flush();
      yield {
        name: 'index.csv',
        content: async () =>
          encoder.encode(
            [
              'path,version,size,sha256',
              ...record.items.map((item) =>
                [item.path, item.versionId, item.size, item.sha256 ?? ''].map(csv).join(','),
              ),
            ].join('\n'),
          ),
      };
      if (skipped.length || record.excluded)
        yield {
          name: 'NOT-INCLUDED.txt',
          content: async () =>
            encoder.encode(
              [
                ...(record.excluded
                  ? [`${record.excluded} document(s) you may not download were left out.`]
                  : []),
                ...skipped,
              ].join('\n'),
            ),
        };
    }
    headers['content-type'] = 'application/zip';
    headers['content-disposition'] = contentDisposition(
      'attachment',
      record.label ?? `${room.slug}.zip`,
    );
    return new Response(zipStream(entries()), { status: 200, headers });
  }

  const contentDisposition = (disposition: 'attachment' | 'inline', filename: string) => {
    const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
    return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
  };

  /** Serves a ticket: `GET {basePath}/files/{token}`, with single byte ranges for originals. */
  async function serve(
    token: string,
    request: { method: string; range?: string | null },
  ): Promise<Response> {
    const id = engine.tickets.verify(token);
    const refuse = (status: number, code: string, message: string) =>
      new Response(JSON.stringify({ error: { code, message } }), {
        status,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    if (!id) return refuse(404, 'NOT_FOUND', 'Unknown or expired link');
    const ticket = await engine.db.findOne<Ticket>('tickets', { id });
    const now = engine.clock.now();
    if (!ticket || ticket.expiresAt <= now)
      return refuse(404, 'NOT_FOUND', 'Unknown or expired link');
    const uses = await engine.db.transaction((tx) =>
      tx.increment('tickets', { id, tenantId: ticket.tenantId }, 'uses'),
    );
    if (uses === null || uses > ticket.maxUses)
      return refuse(410, 'NOT_FOUND', 'This link has been used');
    if (ticket.variant === 'export')
      return exportResponse(ticket, {
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      });
    const [version, document, room] = await Promise.all([
      engine.db.findOne<DocumentVersion>('versions', {
        id: ticket.versionId,
        tenantId: ticket.tenantId,
      }),
      engine.db.findOne<DataRoomDocument>('documents', {
        id: ticket.documentId,
        tenantId: ticket.tenantId,
      }),
      engine.db.findOne<Room>('rooms', { id: ticket.roomId, tenantId: ticket.tenantId }),
    ]);
    const node = await engine.db.findOne<DataRoomNode>('nodes', {
      id: ticket.documentId,
      tenantId: ticket.tenantId,
    });
    if (!version?.blobId || !document || !room || !node || node.deletedAt !== undefined)
      return refuse(404, 'NOT_FOUND', 'The document is no longer available');
    const blob = await engine.db.findOne<BlobRecord>('blobs', {
      id: version.blobId,
      tenantId: ticket.tenantId,
    });
    if (!blob) return refuse(404, 'NOT_FOUND', 'The document is no longer available');

    const mimeType = version.mimeType ?? 'application/octet-stream';
    const headers: Record<string, string> = {
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'referrer-policy': 'no-referrer',
      'cross-origin-resource-policy': 'same-origin',
    };

    if (ticket.variant === 'original') {
      headers['content-type'] =
        ticket.disposition === 'inline' ? mimeType : 'application/octet-stream';
      headers['content-disposition'] = contentDisposition(ticket.disposition, version.filename);
      headers['accept-ranges'] = 'bytes';
      const match = request.range ? /^bytes=(\d*)-(\d*)$/.exec(request.range.trim()) : null;
      if (match && (match[1] || match[2]) && blob.size > 0) {
        let start = match[1] ? Number(match[1]) : Math.max(0, blob.size - Number(match[2]));
        let end = match[1] && match[2] ? Number(match[2]) : blob.size - 1;
        end = Math.min(end, blob.size - 1);
        if (start > end || start >= blob.size)
          return new Response(null, {
            status: 416,
            headers: { ...headers, 'content-range': `bytes */${blob.size}` },
          });
        start = Math.max(0, start);
        headers['content-range'] = `bytes ${start}-${end}/${blob.size}`;
        headers['content-length'] = String(end - start + 1);
        if (request.method === 'HEAD') return new Response(null, { status: 206, headers });
        return new Response(await read(blob, { start, end }), { status: 206, headers });
      }
      headers['content-length'] = String(blob.size);
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
      return new Response(await read(blob), { status: 200, headers });
    }

    // Other variants come from plugins (watermarked copies, viewer pages); none means refusal, never the original.
    const principal = {
      id: ticket.principalId,
      tenantId: ticket.tenantId,
      kind: 'user' as const,
      groups: [],
      guest: false,
      mfa: false,
      ...(ticket.meta?.name ? { name: ticket.meta.name } : {}),
      ...(ticket.meta?.email ? { email: ticket.meta.email } : {}),
    };
    const scope = createContext(engine, {
      tenantId: ticket.tenantId,
      principal,
      credential: {},
      ...(ticket.meta?.ip ? { request: { ip: ticket.meta.ip } } : {}),
    });
    const context = scope.make(engine.db, { room, node });
    for (const hooks of engine.hooks) {
      if (!hooks.transformDownload) continue;
      const original = await read(blob);
      const transformed = await hooks.transformDownload({
        context,
        room,
        node,
        variant: ticket.variant,
        document,
        version,
        mimeType,
        stream: original,
      });
      if (!transformed) {
        await original.cancel().catch(() => undefined);
        continue;
      }
      headers['content-type'] =
        ticket.disposition === 'inline'
          ? (transformed.mimeType ?? mimeType)
          : 'application/octet-stream';
      headers['content-disposition'] = contentDisposition(
        ticket.disposition,
        transformed.filename ?? version.filename,
      );
      if (transformed.size !== undefined) headers['content-length'] = String(transformed.size);
      await scope.flush();
      return new Response(request.method === 'HEAD' ? null : transformed.stream, {
        status: 200,
        headers,
      });
    }
    return refuse(501, 'UNSUPPORTED', `No plugin produces the ${ticket.variant} variant`);
  }

  return {
    newBlob,
    receive,
    finish,
    directUpload,
    read,
    readVersion,
    storeBytes,
    issueTicket,
    issueExportTicket,
    serve,
    partCount,
  };
}

export type Files = ReturnType<typeof createFiles>;
