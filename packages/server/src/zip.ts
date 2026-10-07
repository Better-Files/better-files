import { BetterFilesError } from '@better-files/core';

/**
 * A streaming ZIP writer (stored entries, UTF-8 names, data descriptors), so exports stream straight from encrypted
 * storage to the client without temporary files, one chunk at a time as the client reads. ZIP32: archives are
 * limited to 4 GiB and 65 535 entries.
 */

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(crc: number, bytes: Uint8Array): number {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(date: Date): { time: number; date: number } {
  return {
    time:
      (date.getUTCHours() << 11) |
      (date.getUTCMinutes() << 5) |
      Math.floor(date.getUTCSeconds() / 2),
    date:
      ((Math.max(1980, date.getUTCFullYear()) - 1980) << 9) |
      ((date.getUTCMonth() + 1) << 5) |
      date.getUTCDate(),
  };
}

export interface ZipEntry {
  /** Path inside the archive, with `/` separators. */
  name: string;
  modified?: Date;
  content: () => Promise<ReadableStream<Uint8Array> | Uint8Array>;
}

const LIMIT = 0xffffffff;

async function* archive(
  entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>,
): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  const central: Uint8Array[] = [];
  let offset = 0;
  let count = 0;
  const account = (bytes: Uint8Array) => {
    offset += bytes.byteLength;
    if (offset > LIMIT)
      throw new BetterFilesError('PAYLOAD_TOO_LARGE', 'Exports are limited to 4 GiB');
    return bytes;
  };
  for await (const entry of entries as AsyncIterable<ZipEntry>) {
    if (++count > 0xffff)
      throw new BetterFilesError('PAYLOAD_TOO_LARGE', 'Exports are limited to 65 535 files');
    const name = encoder.encode(entry.name);
    const { time, date } = dosTime(entry.modified ?? new Date());
    const start = offset;
    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, 0x0808, true); // data descriptor follows; names are UTF-8
    header.setUint16(8, 0, true); // stored
    header.setUint16(10, time, true);
    header.setUint16(12, date, true);
    header.setUint16(26, name.byteLength, true);
    yield account(new Uint8Array(header.buffer));
    yield account(name);
    let crc = 0;
    let size = 0;
    const content = await entry.content();
    if (content instanceof Uint8Array) {
      crc = crc32(crc, content);
      size = content.byteLength;
      yield account(content);
    } else
      for await (const chunk of content as unknown as AsyncIterable<Uint8Array>) {
        crc = crc32(crc, chunk);
        size += chunk.byteLength;
        yield account(chunk);
      }
    const descriptor = new DataView(new ArrayBuffer(16));
    descriptor.setUint32(0, 0x08074b50, true);
    descriptor.setUint32(4, crc, true);
    descriptor.setUint32(8, size, true);
    descriptor.setUint32(12, size, true);
    yield account(new Uint8Array(descriptor.buffer));
    const record = new DataView(new ArrayBuffer(46));
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(4, 20, true);
    record.setUint16(6, 20, true);
    record.setUint16(8, 0x0808, true);
    record.setUint16(12, time, true);
    record.setUint16(14, date, true);
    record.setUint32(16, crc, true);
    record.setUint32(20, size, true);
    record.setUint32(24, size, true);
    record.setUint16(28, name.byteLength, true);
    record.setUint32(42, start, true);
    central.push(new Uint8Array(record.buffer), name);
  }
  const directoryStart = offset;
  for (const part of central) yield account(part);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, count, true);
  end.setUint16(10, count, true);
  end.setUint32(12, offset - directoryStart, true);
  end.setUint32(16, directoryStart, true);
  yield new Uint8Array(end.buffer);
}

export function zipStream(
  entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>,
): ReadableStream<Uint8Array> {
  const chunks = archive(entries);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await chunks.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
}
