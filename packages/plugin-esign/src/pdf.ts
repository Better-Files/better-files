import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';

export interface StampField {
  type: 'signature' | 'initials' | 'date' | 'text' | 'checkbox';
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  value: string;
}

export interface CertificateData {
  envelopeId: string;
  title: string;
  documentName: string;
  originalSha256: string;
  completedAt: string;
  recipients: {
    name: string;
    email: string;
    role: string;
    status: string;
    at?: string;
    ip?: string;
    method: string;
  }[];
  events: { at: string; type: string; actor: string; ip?: string }[];
  evidenceHead: string;
}

/** Page count and sizes, to validate field placement before an envelope is sent. */
export async function describePdf(bytes: Uint8Array): Promise<{ width: number; height: number }[]> {
  const pdf = await PDFDocument.load(bytes);
  return pdf.getPages().map((page) => page.getSize());
}

function fit(font: PDFFont, text: string, width: number, height: number): number {
  let size = Math.min(height * 0.8, 28);
  while (size > 6 && font.widthOfTextAtSize(text, size) > width) size -= 0.5;
  return size;
}

function wrap(font: PDFFont, text: string, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) > width && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/** Draws field values on the document and appends a certificate of completion. */
export async function stampAndCertify(
  original: Uint8Array,
  fields: readonly StampField[],
  certificate: CertificateData,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(original);
  const script = await pdf.embedFont(StandardFonts.HelveticaOblique);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pages = pdf.getPages();
  for (const field of fields) {
    const page = pages[field.page - 1];
    if (!page || !field.value) continue;
    if (field.type === 'checkbox') {
      if (field.value === 'true')
        page.drawText('X', {
          x: field.x + 2,
          y: field.y + 2,
          size: Math.min(field.height, 14),
          font: bold,
        });
      continue;
    }
    const font = field.type === 'signature' || field.type === 'initials' ? script : regular;
    const size = fit(font, field.value, field.width, field.height);
    page.drawText(field.value, {
      x: field.x,
      y: field.y + (field.height - size) / 2,
      size,
      font,
      color: rgb(0.05, 0.1, 0.35),
    });
    if (field.type === 'signature')
      page.drawLine({
        start: { x: field.x, y: field.y },
        end: { x: field.x + field.width, y: field.y },
        thickness: 0.5,
        color: rgb(0.4, 0.4, 0.4),
      });
  }

  // Certificate of completion.
  const margin = 50;
  let page: PDFPage = pdf.addPage([595, 842]);
  let y = 842 - margin;
  const width = 595 - margin * 2;
  const line = (text: string, options: { size?: number; font?: PDFFont; gap?: number } = {}) => {
    const size = options.size ?? 9;
    const font = options.font ?? regular;
    for (const part of wrap(font, text, size, width)) {
      if (y < margin + size) {
        page = pdf.addPage([595, 842]);
        y = 842 - margin;
      }
      page.drawText(part, { x: margin, y, size, font });
      y -= size + 3;
    }
    y -= options.gap ?? 0;
  };
  line('Certificate of completion', { size: 18, font: bold, gap: 8 });
  line(`Envelope: ${certificate.envelopeId}`);
  line(`Title: ${certificate.title}`);
  line(`Document: ${certificate.documentName}`);
  line(`Original document SHA-256: ${certificate.originalSha256}`);
  line(`Completed: ${certificate.completedAt}`, { gap: 10 });
  line('Recipients', { size: 12, font: bold, gap: 2 });
  for (const recipient of certificate.recipients)
    line(
      `${recipient.name} <${recipient.email}>, ${recipient.role}: ${recipient.status}${recipient.at ? ` at ${recipient.at}` : ''}${recipient.ip ? ` from ${recipient.ip}` : ''}, authenticated by ${recipient.method}`,
      { gap: 2 },
    );
  y -= 8;
  line('Events', { size: 12, font: bold, gap: 2 });
  for (const event of certificate.events)
    line(`${event.at}  ${event.type}  ${event.actor}${event.ip ? `  ${event.ip}` : ''}`);
  y -= 8;
  line(`Evidence chain head: ${certificate.evidenceHead}`, { size: 8 });
  line(
    'This certificate is part of the signed document. The evidence chain can be verified with esign.verify.',
    { size: 8 },
  );
  pdf.setProducer('Better Files e-signature');
  return pdf.save();
}
