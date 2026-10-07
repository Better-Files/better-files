import {
  notFound,
  prefixedId,
  type BlobRecord,
  type DatabaseAdapter,
  type DocumentVersion,
  type PluginContext,
  type Rendition,
  type Room,
} from '@better-files/core';
import type { Engine } from './engine.js';

/** Derived artifacts of versions, encrypted and stored like files, removed with them (purge, room deletion). */
export function renditionStore(
  engine: Engine,
  db: DatabaseAdapter,
  tenantId: string,
): PluginContext['renditions'] {
  return {
    async put(input) {
      const version = await db.findOne<DocumentVersion>('versions', {
        id: input.versionId,
        tenantId,
      });
      if (!version) throw notFound('Version');
      const room = await db.findOne<Room>('rooms', { id: version.roomId, tenantId });
      if (!room) throw notFound('Room');
      const now = engine.clock.now();
      const blob = await engine.files.newBlob({
        tenantId,
        room,
        size: input.content.byteLength,
        now,
      });
      await engine.files.storeBytes(blob, input.content);
      const previous = await db.findOne<Rendition>('renditions', {
        tenantId,
        versionId: version.id,
        kind: input.kind,
      });
      const previousBlob = previous
        ? await db.findOne<BlobRecord>('blobs', { id: previous.blobId, tenantId })
        : null;
      const id = prefixedId('rnd', now);
      await db.transaction(async (tx) => {
        await tx.insert('blobs', blob);
        if (previous) {
          await tx.delete('renditions', { id: previous.id, tenantId });
          await tx.delete('blobs', { id: previous.blobId, tenantId });
        }
        await tx.insert('renditions', {
          id,
          tenantId,
          roomId: room.id,
          versionId: version.id,
          kind: input.kind,
          blobId: blob.id,
          mimeType: input.mimeType,
          ...(input.meta ? { meta: input.meta } : {}),
          createdAt: now,
        });
      });
      if (previousBlob) await engine.storage.delete(previousBlob.storageKey).catch(() => undefined);
      return { id, blobId: blob.id };
    },
    async get(versionId, kind) {
      const rendition = await db.findOne<Rendition>('renditions', { tenantId, versionId, kind });
      if (!rendition) return undefined;
      const blob = await db.findOne<BlobRecord>('blobs', { id: rendition.blobId, tenantId });
      if (!blob) return undefined;
      return {
        id: rendition.id,
        mimeType: rendition.mimeType,
        ...(rendition.meta ? { meta: rendition.meta } : {}),
        read: () => engine.files.read(blob),
      };
    },
  };
}
