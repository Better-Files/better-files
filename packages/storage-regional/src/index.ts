import {
  BetterFilesError,
  invalidConfig,
  invalidInput,
  notFound,
  regionKeyPrefix,
  type BlobRecord,
  type ByteSource,
  type DatabaseAdapter,
  type MultipartStorage,
  type Room,
  type StorageAdapter,
  type StorageResidency,
  type StoredObject,
} from '@better-files/core';

export interface RegionalStorageOptions {
  /** One storage adapter per region, by region name (`eu`, `us`, `ch`): lower-case letters, digits and dashes. */
  regions: Record<string, StorageAdapter>;
  /** The region rooms get when `rooms.create` names none: a region name, or one per tenant. */
  defaultRegion: StorageResidency['defaultRegion'];
  /** Whether a tenant may place rooms in a region (contractual residency). Default: every region. */
  allows?: StorageResidency['allows'];
  /**
   * Where objects without a region prefix live: files stored before residency was turned on. Default: `defaultRegion`
   * when it is a name; required when `defaultRegion` is a function.
   */
  unplacedRegion?: string;
}

export interface RegionalStorage extends StorageAdapter {
  readonly residency: StorageResidency;
  /** The region a storage key routes to. */
  regionOf(key: string): string;
  /** Within a region through the region adapter's copy; across regions by streaming. */
  copy(from: string, to: string): Promise<StoredObject>;
}

const regionName = /^[a-z0-9][a-z0-9-]{0,31}$/;
const prefixed = /^g\/([a-z0-9][a-z0-9-]{0,31})\//;

/**
 * Data residency: one `StorageAdapter` that routes each object to the adapter of its region. Rooms get a region at
 * creation (`rooms.create({ region })` or the default), and their files' keys start with `g/{region}/`, so routing
 * needs no lookups. Each region's adapter receives the key without that prefix.
 *
 * ```ts
 * storage: regionalStorage({
 *   regions: { eu: s3Storage({ region: 'eu-central-1', … }), us: s3Storage({ region: 'us-east-1', … }) },
 *   defaultRegion: ({ tenantId }) => tenantRegions.get(tenantId) ?? 'eu',
 *   unplacedRegion: 'eu',
 * })
 * ```
 */
export function regionalStorage(options: RegionalStorageOptions): RegionalStorage {
  const names = Object.keys(options.regions);
  if (names.length === 0) throw invalidConfig('regionalStorage needs at least one region');
  for (const name of names)
    if (!regionName.test(name))
      throw invalidConfig(
        `Region "${name}" must be lower-case letters, digits and dashes (at most 32 characters)`,
      );
  if (typeof options.defaultRegion === 'string' && !options.regions[options.defaultRegion])
    throw invalidConfig(`defaultRegion "${options.defaultRegion}" is not one of the regions`);
  const unplaced =
    options.unplacedRegion ??
    (typeof options.defaultRegion === 'string' ? options.defaultRegion : undefined);
  if (unplaced === undefined)
    throw invalidConfig('regionalStorage needs unplacedRegion when defaultRegion is a function');
  if (!options.regions[unplaced])
    throw invalidConfig(`unplacedRegion "${unplaced}" is not one of the regions`);

  function route(key: string): { region: string; adapter: StorageAdapter; inner: string } {
    const match = prefixed.exec(key);
    const region = match ? match[1]! : unplaced!;
    const adapter = options.regions[region];
    // A key naming a region this deployment no longer has: refuse rather than read or write elsewhere.
    if (!adapter)
      throw new BetterFilesError('INTERNAL_ERROR', `Storage region "${region}" is not configured`);
    return { region, adapter, inner: match ? key.slice(match[0].length) : key };
  }
  const outer = (key: string, object: StoredObject): StoredObject => ({ ...object, key });

  const adapters = Object.values(options.regions);
  const everyMultipart = adapters.every((adapter) => adapter.multipart);
  const multipart: MultipartStorage | undefined = everyMultipart
    ? {
        create: (key) => {
          const { adapter, inner } = route(key);
          return adapter.multipart!.create(inner);
        },
        uploadPart: (key, uploadId, part, body) => {
          const { adapter, inner } = route(key);
          return adapter.multipart!.uploadPart(inner, uploadId, part, body);
        },
        complete: async (key, uploadId, parts) => {
          const { adapter, inner } = route(key);
          return outer(key, await adapter.multipart!.complete(inner, uploadId, parts));
        },
        abort: (key, uploadId) => {
          const { adapter, inner } = route(key);
          return adapter.multipart!.abort(inner, uploadId);
        },
        ...(adapters.every((adapter) => adapter.multipart?.presignPart)
          ? {
              presignPart: (
                key: string,
                uploadId: string,
                part: number,
                presign: { expiresInSeconds: number },
              ) => {
                const { adapter, inner } = route(key);
                return adapter.multipart!.presignPart!(inner, uploadId, part, presign);
              },
            }
          : {}),
      }
    : undefined;

  const storage: RegionalStorage = {
    id: `regional(${names.map((name) => `${name}:${options.regions[name]!.id}`).join(',')})`,
    residency: {
      regions: names,
      defaultRegion: options.defaultRegion,
      ...(options.allows ? { allows: options.allows } : {}),
    },
    regionOf: (key) => route(key).region,
    async put(key, body, putOptions) {
      const { adapter, inner } = route(key);
      return outer(key, await adapter.put(inner, body, putOptions));
    },
    get(key, range) {
      const { adapter, inner } = route(key);
      return adapter.get(inner, range);
    },
    async head(key) {
      const { adapter, inner } = route(key);
      const object = await adapter.head(inner);
      return object ? outer(key, object) : null;
    },
    delete(key) {
      const { adapter, inner } = route(key);
      return adapter.delete(inner);
    },
    async copy(from, to) {
      const source = route(from);
      const target = route(to);
      if (source.adapter === target.adapter && source.adapter.copy)
        return outer(to, await source.adapter.copy(source.inner, target.inner));
      return outer(to, await transfer(source, target));
    },
    ...(multipart ? { multipart } : {}),
    ...(adapters.every((adapter) => adapter.presign)
      ? {
          presign: (
            key: string,
            presign: Parameters<NonNullable<StorageAdapter['presign']>>[1],
          ) => {
            const { adapter, inner } = route(key);
            return adapter.presign!(inner, presign);
          },
        }
      : {}),
  };
  return storage;
}

/** Streams one object between adapters (across regions, or where the adapter cannot copy). */
async function transfer(
  source: { adapter: StorageAdapter; inner: string },
  target: { adapter: StorageAdapter; inner: string },
): Promise<StoredObject> {
  const head = await source.adapter.head(source.inner);
  if (!head) throw notFound('Stored object');
  const body: ByteSource = await source.adapter.get(source.inner);
  return target.adapter.put(target.inner, body, { contentLength: head.size });
}

/** The key an object gets in another region: the same key under that region's prefix. */
export function rekey(key: string, region: string): string {
  return regionKeyPrefix(region) + key.replace(prefixed, '');
}

export interface MoveRoomOptions {
  /** The database and storage given to `betterFiles()` (after it was created, so the database is bound). */
  database: DatabaseAdapter;
  storage: RegionalStorage;
  tenantId: string;
  roomId: string;
  /** The region to move the room's files to. */
  to: string;
  /** Delete each object from its old region once the blob points at the new copy. Default true. */
  deleteSource?: boolean;
  /** Called after each object moves, for progress reporting. */
  onProgress?(progress: { moved: number; total: number }): void;
}

export interface MoveRoomResult {
  from: string | undefined;
  to: string;
  /** Objects copied to the new region in this run. */
  moved: number;
  /** Objects already in the new region (a resumed or repeated move). */
  skipped: number;
  /**
   * Uploads still open with keys in an old region. Their files land there when they complete: run `moveRoom` again
   * once they finish or expire.
   */
  pendingUploads: number;
}

/**
 * Moves a room's files to another region and records the new region on the room, so later uploads go there too.
 * Safe to interrupt and re-run: objects already in the target region are skipped, and the copy is verified by size
 * before the blob is repointed. Wrapped data keys stay valid (they do not depend on the storage key); keys created in
 * a regional KMS stay in that KMS. Run it from a maintenance script or job, not a request handler: it copies every
 * version of every document.
 */
export async function moveRoom(options: MoveRoomOptions): Promise<MoveRoomResult> {
  const { database, storage, tenantId, roomId, to } = options;
  if (!storage.residency.regions.includes(to))
    throw invalidInput(
      `Unknown region "${to}"; available: ${storage.residency.regions.join(', ')}`,
    );
  const room = await database.findOne<Room>('rooms', { tenantId, id: roomId });
  if (!room) throw notFound('Room');
  if (storage.residency.allows && !(await storage.residency.allows({ tenantId, region: to })))
    throw new BetterFilesError(
      'FORBIDDEN',
      `This organization may not store rooms in region "${to}"`,
    );

  // Point the room at the new region first, so blobs created while the copy runs are stored there already.
  if (room.region !== to)
    await database.transaction((tx) =>
      tx.update('rooms', { tenantId, id: roomId }, { region: to }),
    );

  // A blob row exists from the moment an upload opens; its bytes are not complete until the upload is, and an aborted
  // upload's bytes are gone. Only blobs of completed uploads (or written directly) move.
  const unfinished = await database.findMany<{
    blobId: string;
    storageKey: string;
    status: string;
  }>('uploads', {
    where: { tenantId, roomId, status: { in: ['pending', 'uploaded', 'aborted'] } },
  });
  const open = unfinished.filter((upload) => upload.status !== 'aborted');
  const leave = new Set(unfinished.map((upload) => upload.blobId));
  const blobs = (
    await database.findMany<BlobRecord>('blobs', { where: { tenantId, roomId } })
  ).filter((blob) => !leave.has(blob.id));
  let moved = 0;
  let skipped = 0;
  for (const blob of blobs) {
    if (storage.regionOf(blob.storageKey) === to) {
      skipped++;
      continue;
    }
    const target = rekey(blob.storageKey, to);
    const existing = await storage.head(target);
    const copied =
      existing && existing.size === blob.storedSize
        ? existing
        : await storage.copy(blob.storageKey, target);
    if (copied.size !== blob.storedSize)
      throw new BetterFilesError(
        'INTERNAL_ERROR',
        `Copy of ${blob.id} to region "${to}" has ${copied.size} bytes, expected ${blob.storedSize}`,
      );
    await database.transaction((tx) =>
      tx.update('blobs', { tenantId, id: blob.id }, { storageKey: target }),
    );
    if (options.deleteSource !== false)
      await storage.delete(blob.storageKey).catch(() => undefined);
    moved++;
    options.onProgress?.({ moved: moved + skipped, total: blobs.length });
  }

  const pendingUploads = open.filter((upload) => storage.regionOf(upload.storageKey) !== to).length;
  return { from: room.region, to, moved, skipped, pendingUploads };
}
