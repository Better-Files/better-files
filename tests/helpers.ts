import type { StandardSchemaV1 } from '@better-files/core';

/** A minimal Standard Schema validator, so tests need no validation library (apps would use zod, valibot, …). */
export function objectSchema<T extends Record<string, 'string' | 'number' | 'boolean'>>(
  shape: T,
): StandardSchemaV1<{
  [K in keyof T]: T[K] extends 'string' ? string : T[K] extends 'number' ? number : boolean;
}> {
  type Output = {
    [K in keyof T]: T[K] extends 'string' ? string : T[K] extends 'number' ? number : boolean;
  };
  return {
    '~standard': {
      version: 1,
      vendor: 'tests',
      validate(value) {
        if (typeof value !== 'object' || value === null)
          return { issues: [{ message: 'Expected an object' }] };
        const issues: StandardSchemaV1.Issue[] = [];
        const output: Record<string, unknown> = {};
        for (const [key, type] of Object.entries(shape)) {
          const field = (value as Record<string, unknown>)[key];
          if (typeof field !== type) issues.push({ message: `Expected ${type}`, path: [key] });
          else output[key] = field;
        }
        return issues.length ? { issues } : { value: output as Output };
      },
    },
  };
}

export const jsonRequest = (
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request =>
  new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-better-files': '1', ...headers },
    body: JSON.stringify(body),
  });

/** Reads a stored (uncompressed) ZIP through its central directory. */
export function unzip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.byteLength - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const files = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('Bad central directory');
    const size = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const local = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    const localName = view.getUint16(local + 26, true);
    const start = local + 30 + localName + view.getUint16(local + 28, true);
    files.set(name, bytes.subarray(start, start + size));
    offset += 46 + nameLength;
  }
  return files;
}
