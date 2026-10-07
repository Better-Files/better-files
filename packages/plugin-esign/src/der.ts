/** Just enough ASN.1 DER to build CMS signatures and X.509 certificates, and to read them back. */

const concat = (parts: readonly Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
};

function length(size: number): Uint8Array {
  if (size < 0x80) return Uint8Array.of(size);
  const bytes: number[] = [];
  for (let rest = size; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

/** A TLV with `tag` around `content` (or the concatenation of several encoded values). */
export const tlv = (tag: number, ...content: readonly Uint8Array[]) => {
  const body = concat(content);
  return concat([Uint8Array.of(tag), length(body.byteLength), body]);
};

export const sequence = (...items: readonly Uint8Array[]) => tlv(0x30, ...items);
/** A SET OF, sorted by encoding as DER requires. */
export const set = (...items: readonly Uint8Array[]) => tlv(0x31, ...[...items].sort(compareBytes));
export const octets = (bytes: Uint8Array) => tlv(0x04, bytes);
export const nullValue = () => Uint8Array.of(0x05, 0x00);
export const utf8 = (text: string) => tlv(0x0c, new TextEncoder().encode(text));
export const bitString = (bytes: Uint8Array, unusedBits = 0) =>
  tlv(0x03, Uint8Array.of(unusedBits), bytes);
/** `[n] EXPLICIT` (constructed context tag). */
export const explicit = (n: number, ...content: readonly Uint8Array[]) => tlv(0xa0 | n, ...content);
/** `[n] IMPLICIT` for a constructed value: replaces the outer tag of `encoded`. */
export const implicit = (n: number, encoded: Uint8Array) => {
  const out = encoded.slice();
  out[0] = 0xa0 | n;
  return out;
};

/** A non-negative INTEGER from big-endian magnitude bytes (or a small number). */
export function integer(value: number | Uint8Array): Uint8Array {
  let bytes: Uint8Array;
  if (typeof value === 'number') {
    const digits: number[] = [];
    for (let rest = value; rest > 0; rest = Math.floor(rest / 256)) digits.unshift(rest & 0xff);
    bytes = Uint8Array.from(digits.length ? digits : [0]);
  } else {
    let start = 0;
    while (start < value.byteLength - 1 && value[start] === 0) start++;
    bytes = value.subarray(start);
  }
  return tlv(0x02, bytes[0]! & 0x80 ? concat([Uint8Array.of(0), bytes]) : bytes);
}

export function oid(dotted: string): Uint8Array {
  const parts = dotted.split('.').map(Number);
  const body: number[] = [40 * parts[0]! + parts[1]!];
  for (const part of parts.slice(2)) {
    const chunk: number[] = [part & 0x7f];
    for (let rest = Math.floor(part / 128); rest > 0; rest = Math.floor(rest / 128))
      chunk.unshift((rest & 0x7f) | 0x80);
    body.push(...chunk);
  }
  return tlv(0x06, Uint8Array.from(body));
}

/** UTCTime until 2049, GeneralizedTime after, as RFC 5280 requires. */
export function time(at: Date): Uint8Array {
  const iso = at.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return at.getUTCFullYear() < 2050
    ? tlv(0x17, new TextEncoder().encode(`${iso.slice(2)}Z`))
    : tlv(0x18, new TextEncoder().encode(`${iso}Z`));
}

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.byteLength, b.byteLength); i++)
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.byteLength - b.byteLength;
}

/** One decoded TLV: `raw` is the whole encoding, `content` its value bytes. */
export interface Node {
  tag: number;
  raw: Uint8Array;
  content: Uint8Array;
}

export function read(bytes: Uint8Array, offset = 0): Node {
  const tag = bytes[offset];
  if (tag === undefined || offset + 2 > bytes.byteLength) throw new Error('Truncated DER');
  let size = bytes[offset + 1]!;
  let header = 2;
  if (size & 0x80) {
    const count = size & 0x7f;
    if (count === 0 || count > 4) throw new Error('Unsupported DER length');
    size = 0;
    for (let i = 0; i < count; i++) size = size * 256 + bytes[offset + 2 + i]!;
    header += count;
  }
  const end = offset + header + size;
  if (end > bytes.byteLength) throw new Error('Truncated DER');
  return {
    tag,
    raw: bytes.subarray(offset, end),
    content: bytes.subarray(offset + header, end),
  };
}

/** The TLVs inside a constructed value. */
export function children(node: Node): Node[] {
  const out: Node[] = [];
  for (let offset = 0; offset < node.content.byteLength; ) {
    const child = read(node.content, offset);
    out.push(child);
    offset += child.raw.byteLength;
  }
  return out;
}

export const decodeOid = (node: Node): string => {
  const bytes = node.content;
  const parts = [Math.floor(bytes[0]! / 40), bytes[0]! % 40];
  let value = 0;
  for (const byte of bytes.subarray(1)) {
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) {
      parts.push(value);
      value = 0;
    }
  }
  return parts.join('.');
};

export { concat };
