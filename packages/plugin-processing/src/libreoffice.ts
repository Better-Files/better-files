import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Converter } from './index.js';

const officeExtensions =
  /\.(docx?|docm|dotx?|rtf|odt|ott|xlsx?|xlsm|xlsb|ods|csv|pptx?|pptm|ppsx?|odp|vsdx?|pages|numbers|key|wpd|txt|html?)$/i;

export interface LibreOfficeOptions {
  /** The `soffice` executable. Default `soffice` on the PATH. */
  binary?: string;
  /** Per conversion. Default 120 s. */
  timeoutMs?: number;
}

/**
 * Converts Office, OpenDocument, iWork, RTF and similar files to PDF with LibreOffice in headless mode. Each
 * conversion gets its own profile directory, so conversions can run in parallel; files never leave the machine.
 */
export function libreOffice(options: LibreOfficeOptions = {}): Converter {
  const binary = options.binary ?? 'soffice';
  const timeout = options.timeoutMs ?? 120_000;
  return {
    id: 'libreoffice',
    accepts: ({ filename }) => officeExtensions.test(filename),
    async toPdf({ bytes, filename }) {
      const work = await mkdtemp(join(tmpdir(), 'better-files-lo-'));
      try {
        // A neutral file name: the original is untrusted input and only its extension matters to LibreOffice.
        const input = join(work, `document${extname(basename(filename)).toLowerCase()}`);
        await writeFile(input, bytes);
        await new Promise<void>((resolve, reject) =>
          execFile(
            binary,
            [
              `-env:UserInstallation=${pathToFileURL(join(work, 'profile')).href}`,
              '--headless',
              '--norestore',
              '--nolockcheck',
              '--convert-to',
              'pdf',
              '--outdir',
              work,
              input,
            ],
            { timeout, windowsHide: true },
            (error) => (error ? reject(error) : resolve()),
          ),
        );
        return new Uint8Array(await readFile(join(work, 'document.pdf')));
      } finally {
        await rm(work, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}
