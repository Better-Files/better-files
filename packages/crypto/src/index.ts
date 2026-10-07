import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { BetterFilesError, type EncryptionContext, type KeyProvider } from '@better-files/core';

/**
 * Streaming authenticated encryption for stored files: AES-256-GCM over fixed-size segments (the STREAM
 * construction). Each segment has its own 16-byte tag and a nonce built from a per-file random prefix, the segment
 * index and a last-segment flag, so any byte range decrypts on its own and truncation or reordering is detected.
 */

export const SEGMENT_SIZE = 64 * 1024;
export const TAG_LENGTH = 16;
const PREFIX_LENGTH = 7;

export const segmentCount = (plainSize: number, segmentSize = SEGMENT_SIZE) =>
  Math.max(1, Math.ceil(plainSize / segmentSize));
export const encryptedSize = (plainSize: number, segmentSize = SEGMENT_SIZE) =>
  plainSize + segmentCount(plainSize, segmentSize) * TAG_LENGTH;

export const createNoncePrefix = (): Uint8Array => new Uint8Array(randomBytes(PREFIX_LENGTH));

function nonce(prefix: Uint8Array, index: number, last: boolean): Buffer {
  if (prefix.byteLength !== PREFIX_LENGTH) throw new Error('Invalid nonce prefix');
  const out = Buffer.alloc(12);
  out.set(prefix, 0);
  out.writeUInt32BE(index, PREFIX_LENGTH);
  out[11] = last ? 1 : 0;
  return out;
}

export interface SegmentOptions {
  /** 32-byte data key. */
  key: Uint8Array;
  noncePrefix: Uint8Array;
  /** Additional authenticated data binding the ciphertext to its record (for example the blob id). */
  aad: Uint8Array;
  segmentSize?: number;
  /** Index of the first segment this stream handles (a multipart upload's part starts mid-file). */
  firstSegment?: number;
  /** Total segments in the whole file, so the final one is flagged. */
  totalSegments: number;
}

function encryptSegment(options: SegmentOptions, index: number, plain: Uint8Array): Uint8Array {
  const cipher = createCipheriv(
    'aes-256-gcm',
    options.key,
    nonce(options.noncePrefix, index, index === options.totalSegments - 1),
  );
  cipher.setAAD(options.aad);
  const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
}

function decryptSegment(options: SegmentOptions, index: number, sealed: Uint8Array): Uint8Array {
  if (sealed.byteLength < TAG_LENGTH) throw integrity();
  const decipher = createDecipheriv(
    'aes-256-gcm',
    options.key,
    nonce(options.noncePrefix, index, index === options.totalSegments - 1),
  );
  decipher.setAAD(options.aad);
  decipher.setAuthTag(sealed.subarray(sealed.byteLength - TAG_LENGTH));
  try {
    const plain = Buffer.concat([
      decipher.update(sealed.subarray(0, sealed.byteLength - TAG_LENGTH)),
      decipher.final(),
    ]);
    return new Uint8Array(plain.buffer, plain.byteOffset, plain.byteLength);
  } catch {
    throw integrity();
  }
}

const integrity = () =>
  new BetterFilesError('INTERNAL_ERROR', 'Stored file failed its integrity check');

/** Buffers a byte stream into fixed-size chunks. */
class Chunker {
  private buffer: Uint8Array[] = [];
  private size = 0;
  constructor(private readonly chunkSize: number) {}
  push(bytes: Uint8Array): Uint8Array[] {
    this.buffer.push(bytes);
    this.size += bytes.byteLength;
    const out: Uint8Array[] = [];
    while (this.size >= this.chunkSize) out.push(this.take(this.chunkSize));
    return out;
  }
  rest(): Uint8Array {
    return this.take(this.size);
  }
  private take(count: number): Uint8Array {
    const out = new Uint8Array(count);
    let offset = 0;
    while (offset < count) {
      const head = this.buffer[0]!;
      const need = count - offset;
      if (head.byteLength <= need) {
        out.set(head, offset);
        offset += head.byteLength;
        this.buffer.shift();
      } else {
        out.set(head.subarray(0, need), offset);
        this.buffer[0] = head.subarray(need);
        offset += need;
      }
    }
    this.size -= count;
    return out;
  }
}

/**
 * Encrypts plaintext into sealed segments. The stream must carry exactly the plaintext for segments
 * `firstSegment … firstSegment + n - 1`; every segment but the file's last must be full.
 */
export function encryptStream(options: SegmentOptions): TransformStream<Uint8Array, Uint8Array> {
  const segmentSize = options.segmentSize ?? SEGMENT_SIZE;
  const chunker = new Chunker(segmentSize);
  let index = options.firstSegment ?? 0;
  let emitted = 0;
  return new TransformStream({
    transform(chunk, controller) {
      for (const segment of chunker.push(chunk)) {
        if (index >= options.totalSegments)
          throw new BetterFilesError('INVALID_INPUT', 'More data than declared');
        controller.enqueue(encryptSegment(options, index++, segment));
        emitted++;
      }
    },
    flush(controller) {
      const rest = chunker.rest();
      // An empty file still has one (empty) final segment; otherwise only a partial remainder is emitted.
      if (rest.byteLength > 0 || (emitted === 0 && index === options.totalSegments - 1)) {
        if (index >= options.totalSegments)
          throw new BetterFilesError('INVALID_INPUT', 'More data than declared');
        controller.enqueue(encryptSegment(options, index++, rest));
      }
    },
  });
}

/** Decrypts sealed segments starting at `firstSegment`, dropping `skip` leading bytes and stopping after `length`. */
export function decryptStream(
  options: SegmentOptions & { skip?: number; length?: number },
): TransformStream<Uint8Array, Uint8Array> {
  const segmentSize = options.segmentSize ?? SEGMENT_SIZE;
  const chunker = new Chunker(segmentSize + TAG_LENGTH);
  let index = options.firstSegment ?? 0;
  let skip = options.skip ?? 0;
  let remaining = options.length ?? Number.POSITIVE_INFINITY;
  const emit = (plain: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>) => {
    let out = plain;
    if (skip > 0) {
      const dropped = Math.min(skip, out.byteLength);
      out = out.subarray(dropped);
      skip -= dropped;
    }
    if (out.byteLength > remaining) out = out.subarray(0, remaining);
    remaining -= out.byteLength;
    if (out.byteLength > 0) controller.enqueue(out);
  };
  return new TransformStream({
    transform(chunk, controller) {
      for (const sealed of chunker.push(chunk)) {
        if (remaining <= 0) return;
        emit(decryptSegment(options, index++, sealed), controller);
      }
    },
    flush(controller) {
      const rest = chunker.rest();
      if (rest.byteLength > 0 && remaining > 0)
        emit(decryptSegment(options, index++, rest), controller);
      if (options.length !== undefined && remaining > 0) throw integrity();
    },
  });
}

/**
 * Maps a plaintext byte range (inclusive `end`, as in HTTP) to the stored ciphertext bytes to fetch and the bytes to
 * skip after decrypting the first segment.
 */
export function ciphertextRange(
  range: { start: number; end: number },
  plainSize: number,
  segmentSize = SEGMENT_SIZE,
): { firstSegment: number; start: number; end: number; skip: number; length: number } {
  const start = Math.max(0, Math.min(range.start, plainSize));
  const end = Math.max(start, Math.min(range.end, plainSize - 1));
  const firstSegment = Math.floor(start / segmentSize);
  const lastSegment = Math.floor(end / segmentSize);
  const sealed = segmentSize + TAG_LENGTH;
  const storedEnd = Math.min((lastSegment + 1) * sealed, encryptedSize(plainSize, segmentSize)) - 1;
  return {
    firstSegment,
    start: firstSegment * sealed,
    end: storedEnd,
    skip: start - firstSegment * segmentSize,
    length: end - start + 1,
  };
}

/** A SHA-256 of everything that passes through, available once the stream ends. */
export function hashingStream(): {
  stream: TransformStream<Uint8Array, Uint8Array>;
  digest: Promise<{ sha256: string; size: number }>;
} {
  const hash = createHash('sha256');
  let size = 0;
  let resolve!: (value: { sha256: string; size: number }) => void;
  const digest = new Promise<{ sha256: string; size: number }>((r) => (resolve = r));
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      hash.update(chunk);
      size += chunk.byteLength;
      controller.enqueue(chunk);
    },
    flush() {
      resolve({ sha256: hash.digest('hex'), size });
    },
  });
  return { stream, digest };
}

/** Rejects once more than `limit` bytes pass. */
export function limitStream(limit: number): TransformStream<Uint8Array, Uint8Array> {
  let size = 0;
  return new TransformStream({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > limit) throw new BetterFilesError('PAYLOAD_TOO_LARGE', 'More data than declared');
      controller.enqueue(chunk);
    },
  });
}

const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const fromBase64url = (text: string) => new Uint8Array(Buffer.from(text, 'base64url'));
export { base64url, fromBase64url };

/** Canonical bytes for an encryption context, so wrapping and unwrapping bind the same pairs. */
export function contextBytes(context: EncryptionContext): Uint8Array {
  const sorted = Object.keys(context)
    .sort()
    .map((key) => [key, context[key]]);
  return new TextEncoder().encode(JSON.stringify(sorted));
}

/**
 * A key provider that derives a key-encryption key per tenant from one secret (HKDF-SHA256) and wraps data keys with
 * AES-256-GCM bound to the encryption context. For development, tests and single-server installs; production
 * deployments on Better IAM use its KMS (`betterIamKeys`) or a cloud KMS so keys can be rotated and destroyed.
 */
export function localKeyProvider(options: { secret: string }): KeyProvider {
  if (options.secret.length < 32)
    throw new BetterFilesError('INVALID_CONFIG', 'The key secret must have at least 32 characters');
  const kek = (tenantId: string) =>
    new Uint8Array(hkdfSync('sha256', options.secret, 'better-files:kek:v1', tenantId, 32));
  return {
    id: 'local',
    async generateDataKey({ tenantId, context }) {
      const plaintext = new Uint8Array(randomBytes(32));
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', kek(tenantId), iv);
      cipher.setAAD(contextBytes(context));
      const sealed = Buffer.concat([
        iv,
        cipher.update(plaintext),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      return { plaintext, wrapped: `v1.${base64url(sealed)}`, keyRef: 'local:v1' };
    },
    async decryptDataKey({ tenantId, wrapped, context }) {
      if (!wrapped.startsWith('v1.')) throw integrity();
      const sealed = fromBase64url(wrapped.slice(3));
      if (sealed.byteLength !== 12 + 32 + TAG_LENGTH) throw integrity();
      const decipher = createDecipheriv('aes-256-gcm', kek(tenantId), sealed.subarray(0, 12));
      decipher.setAAD(contextBytes(context));
      decipher.setAuthTag(sealed.subarray(44));
      try {
        return new Uint8Array(
          Buffer.concat([decipher.update(sealed.subarray(12, 44)), decipher.final()]),
        );
      } catch {
        throw integrity();
      }
    },
  };
}

/** HMAC-SHA256 tokens: `{prefix}{id}.{mac}`. Ids are random; the MAC stops probing the store with guessed ids. */
export function tokenSigner(secret: string, purpose: string) {
  const key = hkdfSync('sha256', secret, 'better-files:token:v1', purpose, 32);
  const mac = (id: string) =>
    createHmac('sha256', Buffer.from(key)).update(id).digest('base64url').slice(0, 32);
  return {
    sign: (id: string) => `${id}.${mac(id)}`,
    verify(token: string): string | undefined {
      const dot = token.lastIndexOf('.');
      if (dot <= 0) return undefined;
      const id = token.slice(0, dot);
      const given = Buffer.from(token.slice(dot + 1));
      const expected = Buffer.from(mac(id));
      return given.byteLength === expected.byteLength && timingSafeEqual(given, expected)
        ? id
        : undefined;
    },
  };
}

export const randomId = (bytes = 18) => randomBytes(bytes).toString('base64url');
