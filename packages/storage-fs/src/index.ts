import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import {
  BetterFilesError,
  invalidInput,
  notFound,
  type ByteSource,
  type StorageAdapter,
  type StoredObject,
} from '@better-files/core';

export interface FileStorageOptions {
  /** Directory the objects live under. Created when missing. */
  root: string;
}

const keyPattern = /^[A-Za-z0-9][A-Za-z0-9/_.=-]{0,1023}$/;

function toWeb(source: ByteSource): ReadableStream<Uint8Array> {
  if (source instanceof ReadableStream) return source;
  if (source instanceof Uint8Array)
    return new ReadableStream({
      start(controller) {
        controller.enqueue(source);
        controller.close();
      },
    });
  return Readable.toWeb(Readable.from(source)) as ReadableStream<Uint8Array>;
}

/** Stores objects as files on local disk: development, single-server and on-premises installs. */
export function fileStorage(options: FileStorageOptions): StorageAdapter {
  const root = resolve(options.root);
  const path = (key: string) => {
    // Keys come from Better Files, but never let one escape the root.
    if (
      !keyPattern.test(key) ||
      key.split('/').some((part) => part === '..' || part === '.' || part === '')
    )
      throw invalidInput('Invalid storage key');
    const full = resolve(root, ...key.split('/'));
    if (!full.startsWith(root + sep)) throw invalidInput('Invalid storage key');
    return full;
  };
  const partsDirectory = (uploadId: string) => {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(uploadId)) throw invalidInput('Invalid upload id');
    return join(root, '.multipart', uploadId);
  };

  async function write(target: string, body: ByteSource): Promise<number> {
    await mkdir(dirname(target), { recursive: true });
    // Write to a temporary file and rename, so readers never see a partial object.
    const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    let size = 0;
    try {
      await toWeb(body)
        .pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              size += chunk.byteLength;
              controller.enqueue(chunk);
            },
          }),
        )
        .pipeTo(Writable.toWeb(createWriteStream(temporary)) as WritableStream<Uint8Array>);
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    return size;
  }

  const head = async (key: string): Promise<StoredObject | null> => {
    try {
      const info = await stat(path(key));
      return info.isFile() ? { key, size: info.size } : null;
    } catch {
      return null;
    }
  };

  return {
    id: 'fs',
    async put(key, body) {
      return { key, size: await write(path(key), body) };
    },
    async get(key, range) {
      const file = path(key);
      const info = await head(key);
      if (!info) throw notFound('Object');
      const stream = createReadStream(file, {
        ...(range
          ? { start: range.start, ...(range.end === undefined ? {} : { end: range.end }) }
          : {}),
      });
      return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
    },
    head,
    async delete(key) {
      await rm(path(key), { force: true });
    },
    async copy(from, to) {
      const info = await head(from);
      if (!info) throw notFound('Object');
      await mkdir(dirname(path(to)), { recursive: true });
      await copyFile(path(from), path(to));
      return { key: to, size: info.size };
    },
    multipart: {
      async create(key) {
        path(key);
        const uploadId = randomBytes(12).toString('base64url');
        await mkdir(partsDirectory(uploadId), { recursive: true });
        return { uploadId };
      },
      async uploadPart(key, uploadId, part, body) {
        path(key);
        if (!Number.isInteger(part) || part < 1 || part > 10_000)
          throw invalidInput('Invalid part number');
        const size = await write(join(partsDirectory(uploadId), String(part)), body);
        return { etag: `${part}-${size}` };
      },
      async complete(key, uploadId, parts) {
        const directory = partsDirectory(uploadId);
        const ordered = [...parts].sort((a, b) => a.part - b.part);
        const present = new Set(await readdir(directory).catch(() => [] as string[]));
        for (const { part } of ordered)
          if (!present.has(String(part)))
            throw new BetterFilesError('INVALID_INPUT', `Part ${part} was not uploaded`);
        const target = path(key);
        await mkdir(dirname(target), { recursive: true });
        const output = await open(target, 'w');
        let size = 0;
        try {
          for (const { part } of ordered) {
            const input = createReadStream(join(directory, String(part)));
            for await (const chunk of input) {
              await output.write(chunk as Buffer);
              size += (chunk as Buffer).byteLength;
            }
          }
        } finally {
          await output.close();
        }
        await rm(directory, { recursive: true, force: true });
        return { key, size };
      },
      async abort(_key, uploadId) {
        await rm(partsDirectory(uploadId), { recursive: true, force: true });
      },
    },
  };
}
