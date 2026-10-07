import {
  notFound,
  type ByteSource,
  type StorageAdapter,
  type StoredObject,
} from '@better-files/core';

export async function readAll(source: ByteSource): Promise<Uint8Array> {
  if (source instanceof Uint8Array) return source;
  const chunks: Uint8Array[] = [];
  if (source instanceof ReadableStream) {
    const reader = source.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } else for await (const chunk of source) chunks.push(chunk);
  const out = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

const streamOf = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

/**
 * An in-memory `StorageAdapter` with multipart support, for tests and examples. Presigned part URLs
 * (`memory://parts/…`) are answered by `storage.fetch`, standing in for the object store a browser would PUT to.
 */
export function memoryStorage(): StorageAdapter & {
  readonly objects: ReadonlyMap<string, Uint8Array>;
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
} {
  const objects = new Map<string, Uint8Array>();
  const uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
  let counter = 0;
  const stored = (key: string, bytes: Uint8Array): StoredObject => ({
    key,
    size: bytes.byteLength,
  });
  return {
    id: 'memory',
    objects,
    async put(key, body) {
      const bytes = await readAll(body);
      objects.set(key, bytes);
      return stored(key, bytes);
    },
    async get(key, range) {
      const bytes = objects.get(key);
      if (!bytes) throw notFound('Object');
      if (!range) return streamOf(bytes);
      return streamOf(
        bytes.subarray(range.start, range.end === undefined ? undefined : range.end + 1),
      );
    },
    async head(key) {
      const bytes = objects.get(key);
      return bytes ? stored(key, bytes) : null;
    },
    async delete(key) {
      objects.delete(key);
    },
    async copy(from, to) {
      const bytes = objects.get(from);
      if (!bytes) throw notFound('Object');
      objects.set(to, bytes);
      return stored(to, bytes);
    },
    multipart: {
      async create(key) {
        const uploadId = `mp-${++counter}`;
        uploads.set(uploadId, { key, parts: new Map() });
        return { uploadId };
      },
      async uploadPart(key, uploadId, part, body) {
        const upload = uploads.get(uploadId);
        if (!upload || upload.key !== key) throw notFound('Upload');
        upload.parts.set(part, await readAll(body));
        return { etag: `${uploadId}-${part}` };
      },
      async complete(key, uploadId, parts) {
        const upload = uploads.get(uploadId);
        if (!upload || upload.key !== key) throw notFound('Upload');
        const ordered = [...parts]
          .sort((a, b) => a.part - b.part)
          .map(({ part }) => {
            const bytes = upload.parts.get(part);
            if (!bytes) throw notFound(`Part ${part}`);
            return bytes;
          });
        const bytes = await readAll(
          (async function* () {
            yield* ordered;
          })(),
        );
        objects.set(key, bytes);
        uploads.delete(uploadId);
        return stored(key, bytes);
      },
      async abort(_key, uploadId) {
        uploads.delete(uploadId);
      },
      async presignPart(key, uploadId, part, options) {
        const expires = Date.now() + options.expiresInSeconds * 1000;
        return `memory://parts/${encodeURIComponent(uploadId)}/${part}?key=${encodeURIComponent(key)}&expires=${expires}`;
      },
    },
    async fetch(input, init) {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = input instanceof Request ? input.method : (init?.method ?? 'GET');
      const match = /^\/([^/]+)\/(\d+)$/.exec(url.pathname);
      if (url.protocol !== 'memory:' || url.host !== 'parts' || !match || method !== 'PUT')
        return new Response('Not found', { status: 404 });
      const body =
        input instanceof Request
          ? await input.arrayBuffer()
          : await new Response(init?.body ?? null).arrayBuffer();
      if (Number(url.searchParams.get('expires')) < Date.now())
        return new Response('Expired', { status: 403 });
      const uploadId = decodeURIComponent(match[1]!);
      const upload = uploads.get(uploadId);
      if (!upload || upload.key !== url.searchParams.get('key'))
        return new Response('No upload', { status: 404 });
      upload.parts.set(Number(match[2]), new Uint8Array(body));
      return new Response(null, { status: 200, headers: { etag: `"${uploadId}-${match[2]}"` } });
    },
  };
}
