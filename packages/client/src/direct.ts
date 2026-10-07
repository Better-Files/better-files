/**
 * Client-side encryption for direct uploads, in WebCrypto: the same AES-256-GCM segment format the server writes
 * (a 7-byte nonce prefix, the big-endian segment index and a last-segment flag; the tag after each segment), so
 * stored files are indistinguishable from proxied uploads and download the same way.
 */

export interface DirectEncryption {
  algorithm: 'AES-256-GCM-STREAM';
  /** base64url data key for this one file. */
  key: string;
  noncePrefix: string;
  aad: string;
  segmentSize: number;
}

export interface DirectUpload {
  partSize: number;
  parts: { part: number; url: string }[];
  encryption: DirectEncryption | null;
}

export function fromBase64url(value: string): Uint8Array {
  const base64 = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const nonce = (prefix: Uint8Array, index: number, last: boolean) => {
  const out = new Uint8Array(12);
  out.set(prefix, 0);
  new DataView(out.buffer).setUint32(7, index, false);
  out[11] = last ? 1 : 0;
  return out;
};

/** Encrypts one part's plaintext; `start` is its offset in the file, which must be a multiple of the segment size. */
export async function encryptPart(
  plain: Uint8Array,
  encryption: DirectEncryption,
  start: number,
  fileSize: number,
): Promise<Uint8Array> {
  const { segmentSize } = encryption;
  if (start % segmentSize !== 0) throw new Error('Parts must start on a segment boundary');
  const totalSegments = Math.max(1, Math.ceil(fileSize / segmentSize));
  const key = await crypto.subtle.importKey(
    'raw',
    fromBase64url(encryption.key) as BufferSource,
    'AES-GCM',
    false,
    ['encrypt'],
  );
  const prefix = fromBase64url(encryption.noncePrefix);
  const aad = fromBase64url(encryption.aad);
  const sealed: Uint8Array[] = [];
  const first = start / segmentSize;
  const count = Math.max(1, Math.ceil(plain.byteLength / segmentSize));
  for (let i = 0; i < count; i++) {
    const index = first + i;
    const segment = plain.subarray(i * segmentSize, (i + 1) * segmentSize);
    sealed.push(
      new Uint8Array(
        await crypto.subtle.encrypt(
          {
            name: 'AES-GCM',
            iv: nonce(prefix, index, index === totalSegments - 1) as BufferSource,
            additionalData: aad as BufferSource,
            tagLength: 128,
          },
          key,
          segment as BufferSource,
        ),
      ),
    );
  }
  const out = new Uint8Array(sealed.reduce((size, part) => size + part.byteLength, 0));
  let offset = 0;
  for (const part of sealed) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
