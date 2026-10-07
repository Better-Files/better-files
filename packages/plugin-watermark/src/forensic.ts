import { decodePDFRawStream, PDFDocument, PDFRawStream, type PDFFont } from 'pdf-lib';

/**
 * Hidden forensic marks: the copy's code, carried where a visible stamp is easy to remove.
 *
 * - PDFs: the document keywords, plus invisible text on every page (survives metadata stripping and copy-paste).
 * - Images: the code's bits in the mean brightness of a grid of cells (quantization index modulation). The grid is
 *   relative to the image size, so the mark survives JPEG re-compression (down to quality 40), format changes, mild
 *   blur and resizing of ordinary photos. Cropping, rotation, brightness or contrast changes and heavy filtering
 *   defeat it; the visible stamp remains the first line of defense.
 *
 * Every payload is the 10-hex-digit code plus a CRC-16, so random content is not mistaken for a mark.
 */

export const FORENSIC_CODE = /^[0-9A-F]{10}$/;
const MARKER = 'DRFC:';
const PAYLOAD_TEXT = /DRFC:([0-9A-F]{14})/;

export type ForensicMethod = 'pdf-metadata' | 'pdf-text' | 'image-pixels';

export interface ForensicMatch {
  code: string;
  method: ForensicMethod;
}

/** CRC-16/CCITT-FALSE. */
function crc16(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++)
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

const codeBytes = (code: string) => Uint8Array.from(Buffer.from(code, 'hex'));

/** `code` followed by its CRC, as 14 hex digits. */
function payloadHex(code: string): string {
  return code + crc16(codeBytes(code)).toString(16).toUpperCase().padStart(4, '0');
}

/** The code in a 14-digit payload, when its CRC matches. */
function codeOf(payload: string): string | undefined {
  const code = payload.slice(0, 10).toUpperCase();
  return FORENSIC_CODE.test(code) && payloadHex(code) === payload.toUpperCase() ? code : undefined;
}

// ── PDFs ────────────────────────────────────────────────────────────────────

/** Adds the hidden marks to a PDF that is about to be saved. */
export function markPdf(pdf: PDFDocument, font: PDFFont, code: string) {
  const text = MARKER + payloadHex(code);
  const keywords = pdf.getKeywords();
  pdf.setKeywords([...(keywords ? [keywords] : []), text]);
  for (const page of pdf.getPages()) page.drawText(text, { x: 1, y: 1, size: 1, font, opacity: 0 });
}

const hexOf = (text: string) => Buffer.from(text, 'latin1').toString('hex').toUpperCase();
const MARKER_HEX = hexOf(MARKER);

function findInContent(content: string): string | undefined {
  // Literal strings, then the hex strings pdf-lib writes for standard fonts.
  const literal = PAYLOAD_TEXT.exec(content);
  const fromLiteral = literal ? codeOf(literal[1]!) : undefined;
  if (fromLiteral) return fromLiteral;
  const upper = content.toUpperCase();
  for (let at = upper.indexOf(MARKER_HEX); at >= 0; at = upper.indexOf(MARKER_HEX, at + 1)) {
    const hex = upper.slice(at + MARKER_HEX.length, at + MARKER_HEX.length + 28);
    if (!/^[0-9A-F]{28}$/.test(hex)) continue;
    const code = codeOf(Buffer.from(hex, 'hex').toString('latin1'));
    if (code) return code;
  }
  return undefined;
}

async function extractFromPdf(bytes: Uint8Array): Promise<ForensicMatch | undefined> {
  let pdf: PDFDocument;
  try {
    pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    return undefined;
  }
  const keywords = PAYLOAD_TEXT.exec(pdf.getKeywords() ?? '');
  const fromKeywords = keywords ? codeOf(keywords[1]!) : undefined;
  if (fromKeywords) return { code: fromKeywords, method: 'pdf-metadata' };
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    let content: string;
    try {
      content = Buffer.from(decodePDFRawStream(object).decode()).toString('latin1');
    } catch {
      continue;
    }
    const code = findInContent(content);
    if (code) return { code, method: 'pdf-text' };
  }
  return undefined;
}

// ── Images ──────────────────────────────────────────────────────────────────

/** Raw interleaved pixels, as sharp's `raw()` output. */
export interface Pixels {
  data: Uint8Array;
  width: number;
  height: number;
  channels: number;
}

/** One payload block is 8 × 7 cells (56 bits); the image holds 1–4 copies across and down. */
const BLOCK_COLS = 8;
const BLOCK_ROWS = 7;
const MIN_CELL = 8;
const MAX_REPEAT = 4;

function bitsOf(code: string): number[] {
  const bytes = Buffer.from(payloadHex(code), 'hex');
  const bits: number[] = [];
  for (const byte of bytes) for (let bit = 7; bit >= 0; bit--) bits.push((byte >> bit) & 1);
  return bits;
}

const bounds = (index: number, count: number, size: number): [number, number] => [
  Math.floor((index * size) / count),
  Math.floor(((index + 1) * size) / count),
];

/** The part of a cell that is measured: its edges blur into neighbors when the image is resized. */
const inner = ([start, end]: [number, number]): [number, number] => {
  const margin = Math.floor((end - start) * 0.2);
  return [start + margin, end - margin];
};

/** Color channels to shift and how luma is read: grey (1–2 channels) or RGB (3–4). */
function lumaOf(pixels: Pixels, offset: number): number {
  const { data } = pixels;
  return pixels.channels >= 3
    ? 0.299 * data[offset]! + 0.587 * data[offset + 1]! + 0.114 * data[offset + 2]!
    : data[offset]!;
}

function meanLuma(pixels: Pixels, x0: number, x1: number, y0: number, y1: number): number {
  let sum = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) sum += lumaOf(pixels, (y * pixels.width + x) * pixels.channels);
  return sum / Math.max(1, (x1 - x0) * (y1 - y0));
}

/**
 * Embeds the code in place. Returns false when the image is too small to carry it (under 64 × 56 pixels).
 * `strength` is the quantization step in luma levels: each cell's mean moves by at most half of it.
 */
export function embedInPixels(pixels: Pixels, code: string, strength = 8): boolean {
  const across = Math.min(MAX_REPEAT, Math.floor(pixels.width / (BLOCK_COLS * MIN_CELL)));
  const down = Math.min(MAX_REPEAT, Math.floor(pixels.height / (BLOCK_ROWS * MIN_CELL)));
  if (across < 1 || down < 1) return false;
  const bits = bitsOf(code);
  const cols = BLOCK_COLS * across;
  const rows = BLOCK_ROWS * down;
  const color = Math.min(3, pixels.channels);
  const step = strength;
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < cols; col++) {
      const bit = bits[(row % BLOCK_ROWS) * BLOCK_COLS + (col % BLOCK_COLS)]!;
      const [x0, x1] = bounds(col, cols, pixels.width);
      const [y0, y1] = bounds(row, rows, pixels.height);
      // Quantize what the decoder measures (the inner part), shift the whole cell.
      const [ix0, ix1] = inner([x0, x1]);
      const [iy0, iy1] = inner([y0, y1]);
      const mean = meanLuma(pixels, ix0, ix1, iy0, iy1);
      const offset = (bit ? 0.75 : 0.25) * step;
      const base = Math.floor(mean / step) * step;
      let target = Number.NaN;
      for (const candidate of [base - step + offset, base + offset, base + step + offset])
        if (
          candidate > 0.5 &&
          candidate < 254.5 &&
          (Number.isNaN(target) || Math.abs(candidate - mean) < Math.abs(target - mean))
        )
          target = candidate;
      // Shift the cell: fully over the measured part, fading to nothing at the edges so no block outlines show.
      // Repeat to make up for values clipped at 0 and 255.
      const fade = (
        at: number,
        start: number,
        end: number,
        innerStart: number,
        innerEnd: number,
      ) =>
        at < innerStart
          ? (at - start + 1) / (innerStart - start + 1)
          : at >= innerEnd
            ? (end - at) / (end - innerEnd + 1)
            : 1;
      for (let pass = 0; pass < 3; pass++) {
        const delta = target - meanLuma(pixels, ix0, ix1, iy0, iy1);
        if (Math.abs(delta) < 0.25) break;
        for (let y = y0; y < y1; y++) {
          const wy = fade(y, y0, y1, iy0, iy1);
          for (let x = x0; x < x1; x++) {
            const shift = delta * wy * fade(x, x0, x1, ix0, ix1);
            const at = (y * pixels.width + x) * pixels.channels;
            for (let c = 0; c < color; c++)
              pixels.data[at + c] = Math.max(
                0,
                Math.min(255, Math.round(pixels.data[at + c]! + shift)),
              );
          }
        }
      }
    }
  return true;
}

/** Reads a code embedded by `embedInPixels`, trying every grid the original size could have used. */
export function extractFromPixels(pixels: Pixels, strength = 8): string | undefined {
  let best: { code: string; confidence: number } | undefined;
  for (let across = 1; across <= MAX_REPEAT; across++)
    for (let down = 1; down <= MAX_REPEAT; down++) {
      const cols = BLOCK_COLS * across;
      const rows = BLOCK_ROWS * down;
      if (pixels.width < cols * 3 || pixels.height < rows * 3) continue;
      const scores = new Array<number>(BLOCK_COLS * BLOCK_ROWS).fill(0);
      for (let row = 0; row < rows; row++)
        for (let col = 0; col < cols; col++) {
          const [x0, x1] = inner(bounds(col, cols, pixels.width));
          const [y0, y1] = inner(bounds(row, rows, pixels.height));
          const mean = meanLuma(pixels, x0, x1, y0, y1);
          const phase = mean / strength - Math.floor(mean / strength);
          // +1 at a quarter step past the grid (bit 0's target), −1 at three quarters (bit 1's).
          scores[(row % BLOCK_ROWS) * BLOCK_COLS + (col % BLOCK_COLS)]! += Math.sin(
            2 * Math.PI * phase,
          );
        }
      const copies = across * down;
      const confidence = scores.reduce((sum, s) => sum + Math.abs(s), 0) / (scores.length * copies);
      let hex = '';
      for (let byte = 0; byte < 7; byte++) {
        let value = 0;
        for (let bit = 0; bit < 8; bit++)
          value = (value << 1) | (scores[byte * 8 + bit]! < 0 ? 1 : 0);
        hex += value.toString(16).toUpperCase().padStart(2, '0');
      }
      const code = codeOf(hex);
      if (code && confidence > 0.3 && (!best || confidence > best.confidence))
        best = { code, confidence };
    }
  return best?.code;
}

async function extractFromImage(
  bytes: Uint8Array,
  strength: number,
): Promise<ForensicMatch | undefined> {
  let sharp: typeof import('sharp');
  try {
    sharp = (await import('sharp')).default as unknown as typeof import('sharp');
  } catch {
    return undefined;
  }
  try {
    const { data, info } = await sharp(Buffer.from(bytes))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const code = extractFromPixels(
      { data, width: info.width, height: info.height, channels: info.channels },
      strength,
    );
    return code ? { code, method: 'image-pixels' } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Finds the forensic code hidden in a watermarked copy: a PDF (keywords or invisible text) or an image (pixel mark).
 * Look the code up with `watermark.trace` to learn whose copy it was. Image marks need the sharp package, and the
 * `strength` the plugin was configured with (default 8).
 */
export async function extractForensicCode(
  bytes: Uint8Array,
  options: { strength?: number } = {},
): Promise<ForensicMatch | undefined> {
  const head = Buffer.from(bytes.subarray(0, 5)).toString('latin1');
  if (head === '%PDF-') return extractFromPdf(bytes);
  return extractFromImage(bytes, options.strength ?? 8);
}
