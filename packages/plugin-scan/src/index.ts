import { connect } from 'node:net';
import {
  BetterFilesError,
  defineJob,
  definePlugin,
  type DatabaseAdapter,
  type DataRoomDocument,
  type DocumentVersion,
  type Logger,
} from '@better-files/core';

export interface ScanResult {
  clean: boolean;
  /** The signature name when the file is infected. */
  threat?: string;
}

/** Anything that can say whether bytes are safe: ClamAV, a cloud scanner, a sandbox. */
export interface Scanner {
  readonly id: string;
  scan(content: ReadableStream<Uint8Array>): Promise<ScanResult>;
}

export interface ClamavOptions {
  host?: string;
  port?: number;
  /** Milliseconds before a scan gives up. Default 120000. */
  timeoutMs?: number;
}

/**
 * A ClamAV client over clamd's INSTREAM protocol (TCP). Point it at `clamd` (for example the `clamav/clamav`
 * container on port 3310); content streams through without touching disk here.
 */
export function clamavScanner(options: ClamavOptions = {}): Scanner {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 3310;
  const timeoutMs = options.timeoutMs ?? 120_000;
  return {
    id: 'clamav',
    scan(content) {
      return new Promise<ScanResult>((resolve, reject) => {
        const socket = connect({ host, port });
        let reply = '';
        let settled = false;
        const finish = (error: Error | undefined, result?: ScanResult) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          if (error) reject(error);
          else resolve(result!);
        };
        socket.setTimeout(timeoutMs, () =>
          finish(new BetterFilesError('INTERNAL_ERROR', 'The virus scanner timed out')),
        );
        socket.on('error', (error) =>
          finish(
            new BetterFilesError(
              'INTERNAL_ERROR',
              `The virus scanner is unreachable: ${error.message}`,
            ),
          ),
        );
        socket.on('data', (chunk) => {
          reply += chunk.toString('utf8');
          if (!reply.includes('\0')) return;
          const line = reply.slice(0, reply.indexOf('\0')).trim();
          if (/: OK$/.test(line)) finish(undefined, { clean: true });
          else {
            const found = /: (.+) FOUND$/.exec(line);
            if (found) finish(undefined, { clean: false, threat: found[1]! });
            else
              finish(new BetterFilesError('INTERNAL_ERROR', `The virus scanner failed: ${line}`));
          }
        });
        socket.on('connect', async () => {
          try {
            socket.write('zINSTREAM\0');
            const reader = content.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              // clamd takes chunks prefixed with a 4-byte big-endian length; a zero length ends the stream.
              for (let offset = 0; offset < value.byteLength; offset += 1 << 20) {
                const piece = value.subarray(
                  offset,
                  Math.min(offset + (1 << 20), value.byteLength),
                );
                const size = Buffer.alloc(4);
                size.writeUInt32BE(piece.byteLength);
                if (!socket.write(Buffer.concat([size, piece])))
                  await new Promise((r) => socket.once('drain', r));
              }
            }
            socket.write(Buffer.alloc(4));
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        });
      });
    },
  };
}

export interface ScanningOptions {
  scanner: Scanner;
  /**
   * `background` (default): the upload completes as quarantined and the scan runs as a durable `scanning.scan`
   * job (on `dr.jobs`' runner), retried with backoff while the scanner is unreachable.
   * `inline`: the upload request waits for the verdict.
   */
  mode?: 'background' | 'inline';
  /** Delete infected files from storage (default true); the version record stays, marked rejected. */
  deleteInfected?: boolean;
  /** Versions still quarantined after this long are scanned again by `dr.maintain()`. Default 10 minutes. */
  retryAfterMs?: number;
}

async function applyVerdict(
  db: DatabaseAdapter,
  version: DocumentVersion,
  result: ScanResult,
): Promise<'ready' | 'rejected' | undefined> {
  return db.transaction(async (tx) => {
    const status = result.clean ? 'ready' : 'rejected';
    // Only a quarantined version takes a verdict: a second scan of the same version (a retry overlapping
    // maintain()) changes nothing.
    const changed = await tx.update(
      'versions',
      { id: version.id, tenantId: version.tenantId, status: 'quarantined' },
      { status },
    );
    if (changed === 0) return undefined;
    if (result.clean) {
      // The clean version becomes current unless a newer version has been uploaded since.
      const document = await tx.findOne<DataRoomDocument>('documents', {
        id: version.documentId,
        tenantId: version.tenantId,
      });
      if (document && document.latestVersion === version.number)
        await tx.update(
          'documents',
          { id: document.id, tenantId: version.tenantId },
          { currentVersionId: version.id, size: version.size, mimeType: version.mimeType ?? null },
        );
    }
    return status;
  });
}

/**
 * Virus scanning for uploads. New versions are quarantined (nobody can view or download them) until the scanner
 * reports them clean; the document keeps serving its previous clean version meanwhile. Infected versions are
 * rejected, their bytes deleted, and a `document.threat-detected` event is emitted.
 */
export function scanningPlugin(options: ScanningOptions) {
  const mode = options.mode ?? 'background';
  const retryAfterMs = options.retryAfterMs ?? 10 * 60_000;

  async function scan(
    input: {
      db: DatabaseAdapter;
      logger: Logger;
      now: () => number;
      read: (versionId: string) => Promise<ReadableStream<Uint8Array>>;
      emit: (type: string, data: Record<string, unknown>) => Promise<void> | void;
      deleteBlob: (version: DocumentVersion) => Promise<void>;
    },
    version: DocumentVersion,
    /** Throw scanner failures (a job, which retries) instead of logging them. */
    rethrow = false,
  ) {
    try {
      const result = await options.scanner.scan(await input.read(version.id));
      const status = await applyVerdict(input.db, version, result);
      if (status === undefined) return;
      if (status === 'rejected') {
        if (options.deleteInfected !== false) await input.deleteBlob(version);
        await input.emit('document.threat-detected', {
          nodeId: version.documentId,
          versionId: version.id,
          threat: result.threat ?? 'unknown',
          filename: version.filename,
        });
      } else
        await input.emit('version.scanned', { nodeId: version.documentId, versionId: version.id });
    } catch (error) {
      if (rethrow) throw error;
      // Leave it quarantined; maintain() tries again.
      input.logger.error('Virus scan failed', {
        versionId: version.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const deleteBlob =
    (db: DatabaseAdapter, storage: { delete(key: string): Promise<void> }) =>
    async (version: DocumentVersion) => {
      if (!version.blobId) return;
      const blob = await db.findOne<{ storageKey: string }>('blobs', {
        id: version.blobId,
        tenantId: version.tenantId,
      });
      if (blob) await storage.delete(blob.storageKey).catch(() => undefined);
    };

  return definePlugin({
    id: 'scanning',
    hooks: {
      async afterUpload({ context, versionId }) {
        const version = await context.db.findOne<DocumentVersion>('versions', {
          id: versionId,
          tenantId: context.tenantId,
        });
        if (!version) return;
        await context.db.update(
          'versions',
          { id: version.id, tenantId: version.tenantId },
          { status: 'quarantined' },
        );
        // Keep serving the previous clean version until this one passes.
        const previous = await context.db.findMany<DocumentVersion>('versions', {
          where: {
            tenantId: version.tenantId,
            documentId: version.documentId,
            status: 'ready',
            id: { ne: version.id },
          },
          orderBy: [{ field: 'number', direction: 'desc' }],
          limit: 1,
        });
        await context.db.update(
          'documents',
          { id: version.documentId, tenantId: version.tenantId },
          previous[0]
            ? {
                currentVersionId: previous[0].id,
                size: previous[0].size,
                mimeType: previous[0].mimeType ?? null,
              }
            : { currentVersionId: null },
        );
        const quarantined = { ...version, status: 'quarantined' as const };
        // Background: a durable job, committed with the upload, so a crash or a scanner outage only delays it.
        if (mode === 'background') {
          await context.enqueue('scanning.scan', { versionId: version.id }, { key: version.id });
          return;
        }
        // After the commit, the callback's context is on the plain adapter and publishes events at once.
        context.afterCommit((after) =>
          scan(
            {
              db: after.db,
              logger: after.logger,
              now: () => Date.now(),
              read: (id) => after.readVersion(id),
              emit: (type, data) => after.emit(type, data),
              deleteBlob: deleteBlob(after.db, after.storage),
            },
            quarantined,
          ),
        );
      },
    },
    jobs: {
      scan: defineJob<{ versionId: string }>({
        maxAttempts: 8,
        async handler({ versionId }, context) {
          const version = await context.db.findOne<DocumentVersion>('versions', {
            id: versionId,
            tenantId: context.tenantId,
          });
          if (version?.status !== 'quarantined') return;
          await scan(
            {
              db: context.db,
              logger: context.logger,
              now: () => context.now,
              read: (id) => context.readVersion(context.tenantId, id),
              emit: (type, data) =>
                context.emit({ type, tenantId: context.tenantId, roomId: version.roomId, data }),
              deleteBlob: deleteBlob(context.db, context.storage),
            },
            version,
            true,
          );
        },
      }),
    },
    async maintain(context) {
      const stale = await context.db.findMany<DocumentVersion>('versions', {
        where: { status: 'quarantined', createdAt: { lt: context.now - retryAfterMs } },
        limit: 50,
      });
      for (const version of stale)
        await scan(
          {
            db: context.db,
            logger: context.logger,
            now: () => context.now,
            read: (id) => context.readVersion(version.tenantId, id),
            emit: (type, data) =>
              context.emit({ type, tenantId: version.tenantId, roomId: version.roomId, data }),
            deleteBlob: deleteBlob(context.db, context.storage),
          },
          version,
        );
    },
  });
}
