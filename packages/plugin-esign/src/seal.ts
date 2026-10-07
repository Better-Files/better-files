import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as signWith,
  verify as verifyWith,
  X509Certificate,
  type KeyObject,
} from 'node:crypto';
import { BetterFilesError } from '@better-files/core';
import { PDFArray, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString } from 'pdf-lib';
import {
  bitString,
  children,
  decodeOid,
  explicit,
  implicit,
  integer,
  nullValue,
  octets,
  oid,
  read,
  sequence,
  set,
  time,
  tlv,
  utf8,
  type Node,
} from './der.js';

const OID = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  sha256: '2.16.840.1.101.3.4.2.1',
  sha256WithRsa: '1.2.840.113549.1.1.11',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  keyUsage: '2.5.29.15',
} as const;

const sha256 = (...parts: Uint8Array[]) => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
};

/**
 * Who seals documents: a certificate chain and a signing key. The key can live anywhere (a file, a cloud KMS, an HSM,
 * Better IAM's private CA), since only `sign` touches it.
 */
export interface PdfSealer {
  /** DER certificates: the signer's first, then any intermediates. */
  certificates(): Promise<readonly Uint8Array[]>;
  /** Signs `data` with SHA-256: RSA PKCS#1 v1.5, or ECDSA with a DER-encoded signature. */
  sign(data: Uint8Array): Promise<Uint8Array>;
  /** The signing key's type. */
  readonly keyType: 'rsa' | 'ec';
}

const derOf = (pem: string) => new Uint8Array(new X509Certificate(pem).raw);
const pemOf = (der: Uint8Array) =>
  `-----BEGIN CERTIFICATE-----\n${Buffer.from(der)
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .trimEnd()}\n-----END CERTIFICATE-----\n`;

function keyTypeOf(key: KeyObject): 'rsa' | 'ec' {
  const type = key.asymmetricKeyType;
  if (type === 'rsa' || type === 'ec') return type;
  throw new BetterFilesError('INVALID_CONFIG', `PDF seals need an RSA or EC key, not ${type}`);
}

const signer = (key: KeyObject) => async (data: Uint8Array) =>
  new Uint8Array(signWith('sha256', data, { key, dsaEncoding: 'der' }));

/** Seals with a private key and its certificate chain (PEM), checking they belong together. */
export function keySealer(options: {
  privateKey: string | KeyObject;
  /** PEM: the signer's certificate first, then intermediates (one string or several). */
  certificates: string | readonly string[];
}): PdfSealer {
  const key =
    typeof options.privateKey === 'string'
      ? createPrivateKey(options.privateKey)
      : options.privateKey;
  const pems = (
    typeof options.certificates === 'string' ? [options.certificates] : options.certificates
  ).flatMap(
    (pem) => pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [],
  );
  if (pems.length === 0)
    throw new BetterFilesError('INVALID_CONFIG', 'keySealer needs a certificate');
  const certificates = pems.map(derOf);
  const spki = (k: KeyObject) => k.export({ type: 'spki', format: 'der' });
  if (!spki(createPublicKey(key)).equals(spki(new X509Certificate(pems[0]!).publicKey)))
    throw new BetterFilesError(
      'INVALID_CONFIG',
      "The private key does not match the signer's certificate",
    );
  return { keyType: keyTypeOf(key), certificates: async () => certificates, sign: signer(key) };
}

const name = (commonName: string, organization?: string) =>
  sequence(
    ...(organization ? [set(sequence(oid(OID.organization), utf8(organization)))] : []),
    set(sequence(oid(OID.commonName), utf8(commonName))),
  );

/**
 * A sealer with a fresh P-256 key and a self-signed certificate, for development and tests. Readers show its
 * signatures as valid but from an unknown identity; production seals need a certificate from a trusted CA (an
 * AATL member for Adobe Reader to trust it) through `keySealer` or your own `PdfSealer`.
 */
export function selfSignedSealer(
  options: { commonName?: string; organization?: string; days?: number } = {},
): PdfSealer & { certificatePem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const subject = name(options.commonName ?? 'Better Files development seal', options.organization);
  const now = Date.now();
  const serial = randomBytes(16);
  serial[0]! &= 0x7f;
  const tbs = sequence(
    explicit(0, integer(2)),
    integer(serial),
    sequence(oid(OID.ecdsaWithSha256)),
    subject,
    sequence(
      time(new Date(now - 60_000)),
      time(new Date(now + (options.days ?? 365) * 86_400_000)),
    ),
    subject,
    new Uint8Array(publicKey.export({ type: 'spki', format: 'der' })),
    explicit(
      3,
      sequence(
        // keyUsage (critical): digitalSignature, nonRepudiation.
        sequence(
          oid(OID.keyUsage),
          tlv(0x01, Uint8Array.of(0xff)),
          octets(bitString(Uint8Array.of(0xc0), 6)),
        ),
      ),
    ),
  );
  const certificate = sequence(
    tbs,
    sequence(oid(OID.ecdsaWithSha256)),
    bitString(new Uint8Array(signWith('sha256', tbs, { key: privateKey, dsaEncoding: 'der' }))),
  );
  return {
    keyType: 'ec',
    certificates: async () => [certificate],
    sign: signer(privateKey),
    certificatePem: pemOf(certificate),
  };
}

/** The issuer and serial number of a DER certificate, as CMS identifies its signer. */
function issuerAndSerial(certificate: Uint8Array): { issuer: Uint8Array; serial: Uint8Array } {
  const tbs = children(children(read(certificate))[0]!);
  const at = tbs[0]!.tag === 0xa0 ? 1 : 0;
  return { serial: tbs[at]!.raw, issuer: tbs[at + 2]!.raw };
}

/** A detached CAdES signature (CMS SignedData) over `digest`, the form PAdES baseline B-B uses. */
async function cadesSignature(digest: Uint8Array, sealer: PdfSealer): Promise<Uint8Array> {
  const certificates = await sealer.certificates();
  const signerCertificate = certificates[0];
  if (!signerCertificate)
    throw new BetterFilesError('INVALID_CONFIG', 'The sealer has no certificate');
  // PAdES leaves the signing time to the signature dictionary (/M), so there is no signing-time attribute.
  const attributes = set(
    sequence(oid(OID.contentType), set(oid(OID.data))),
    sequence(oid(OID.messageDigest), set(octets(digest))),
    sequence(
      oid(OID.signingCertificateV2),
      set(sequence(sequence(sequence(octets(sha256(signerCertificate)))))),
    ),
  );
  const signature = await sealer.sign(attributes);
  const { issuer, serial } = issuerAndSerial(signerCertificate);
  const signerInfo = sequence(
    integer(1),
    sequence(issuer, serial),
    sequence(oid(OID.sha256)),
    implicit(0, attributes),
    sealer.keyType === 'rsa'
      ? sequence(oid(OID.sha256WithRsa), nullValue())
      : sequence(oid(OID.ecdsaWithSha256)),
    octets(signature),
  );
  const signedData = sequence(
    integer(1),
    set(sequence(oid(OID.sha256))),
    sequence(oid(OID.data)),
    tlv(0xa0, ...certificates),
    set(signerInfo),
  );
  return sequence(oid(OID.signedData), explicit(0, signedData));
}

const PLACEHOLDER = 9_999_999_999;
const BYTE_RANGE = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;

export interface SealOptions {
  /** The signer's name as readers show it. Default: from the certificate. */
  name?: string;
  reason?: string;
  location?: string;
  contactInfo?: string;
  /** Default now. */
  signedAt?: Date;
  /** Bytes reserved for the signature. Default 16 KiB, enough for a chain of three or four certificates. */
  reserve?: number;
}

/**
 * Seals a PDF with an invisible PAdES (baseline B-B) signature: a detached CAdES signature over the whole file
 * except the signature itself, which any later change breaks. Readers such as Adobe Reader validate it against the
 * certificate. The file is rewritten, so seal last: signatures already in it do not survive.
 */
export async function sealPdf(
  pdfBytes: Uint8Array,
  sealer: PdfSealer,
  options: SealOptions = {},
): Promise<Uint8Array> {
  const reserve = options.reserve ?? 16_384;
  const pdf = await PDFDocument.load(pdfBytes);
  const context = pdf.context;
  const byteRange = PDFArray.withContext(context);
  for (const value of [0, PLACEHOLDER, PLACEHOLDER, PLACEHOLDER])
    byteRange.push(PDFNumber.of(value));
  const text = (value?: string) => (value ? PDFHexString.fromText(value) : undefined);
  const signature = context.obj({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'ETSI.CAdES.detached',
    ByteRange: byteRange,
    Contents: PDFHexString.of('0'.repeat(reserve * 2)),
    M: PDFString.fromDate(options.signedAt ?? new Date()),
  });
  for (const [key, value] of [
    ['Name', text(options.name)],
    ['Reason', text(options.reason)],
    ['Location', text(options.location)],
    ['ContactInfo', text(options.contactInfo)],
  ] as const)
    if (value) signature.set(PDFName.of(key), value);
  const page = pdf.getPages().at(-1);
  if (!page) throw new BetterFilesError('INVALID_INPUT', 'The PDF has no pages');
  const existing = pdf.getForm().getFields().length;
  const widget = context.register(
    context.obj({
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Sig',
      Rect: [0, 0, 0, 0],
      V: context.register(signature),
      T: PDFHexString.fromText(`Better Files seal ${existing + 1}`),
      // Print and locked; zero-size, so invisible.
      F: 132,
      P: page.ref,
    }),
  );
  page.node.addAnnot(widget);
  const form = pdf.catalog.getOrCreateAcroForm();
  form.addField(widget);
  form.dict.set(PDFName.of('SigFlags'), PDFNumber.of(3));
  const out = await pdf.save({ useObjectStreams: false });

  const latin1 = Buffer.from(out.buffer, out.byteOffset, out.byteLength).toString('latin1');
  const hole = `<${'0'.repeat(reserve * 2)}>`;
  const start = latin1.indexOf(hole);
  if (start < 0 || latin1.indexOf(hole, start + 1) >= 0)
    throw new BetterFilesError('INTERNAL_ERROR', 'Could not place the signature');
  const end = start + hole.length;
  const placeholder = [...latin1.matchAll(BYTE_RANGE)].find((m) => Number(m[2]) === PLACEHOLDER);
  if (!placeholder) throw new BetterFilesError('INTERNAL_ERROR', 'Could not place the byte range');
  const ranges = `/ByteRange [0 ${start} ${end} ${out.byteLength - end}]`.padEnd(
    placeholder[0].length,
    ' ',
  );
  out.set(new TextEncoder().encode(ranges), placeholder.index!);

  const cms = await cadesSignature(sha256(out.subarray(0, start), out.subarray(end)), sealer);
  if (cms.byteLength > reserve)
    throw new BetterFilesError(
      'INTERNAL_ERROR',
      `The signature needs ${cms.byteLength} bytes; raise reserve`,
    );
  out.set(new TextEncoder().encode(Buffer.from(cms).toString('hex')), start + 1);
  return out;
}

export interface SealVerification {
  /** The signature matches the bytes it covers and the certificate's key. */
  valid: boolean;
  /** It covers the whole file: nothing was appended after sealing. */
  coversWholeDocument: boolean;
  /** The signer certificate's subject, e.g. `CN=Better Files development seal`. */
  signer?: string;
  /** The signer certificate (PEM), to check against the CAs you trust. */
  certificate?: string;
  reason?: string;
}

const attribute = (attributes: Node[], type: string) =>
  attributes.find((a) => decodeOid(children(a)[0]!) === type);

/**
 * Checks the PAdES / CAdES seals in a PDF (the last one first): the digest of the covered bytes, the signature over
 * the signed attributes and the signing-certificate binding. It does not decide whether to trust the certificate:
 * compare `certificate` with the CAs you trust.
 */
export function verifyPdfSeal(pdfBytes: Uint8Array): SealVerification[] {
  const latin1 = Buffer.from(pdfBytes.buffer, pdfBytes.byteOffset, pdfBytes.byteLength).toString(
    'latin1',
  );
  return [...latin1.matchAll(BYTE_RANGE)].reverse().map((match): SealVerification => {
    const [a, b, c, d] = match.slice(1, 5).map(Number) as [number, number, number, number];
    const coversWholeDocument = a === 0 && c + d === pdfBytes.byteLength;
    const invalid = { valid: false, coversWholeDocument };
    if (
      b <= a ||
      c <= b ||
      c + d > pdfBytes.byteLength ||
      latin1[b] !== '<' ||
      latin1[c - 1] !== '>'
    )
      return invalid;
    try {
      const cms = read(new Uint8Array(Buffer.from(latin1.slice(b + 1, c - 1), 'hex')));
      const [type, wrapped] = children(cms);
      if (decodeOid(type!) !== OID.signedData) return invalid;
      const signedData = children(children(wrapped!)[0]!);
      const certificates = children(signedData.find((n) => n.tag === 0xa0)!).map((n) => n.raw);
      const signerInfo = children(children(signedData.at(-1)!)[0]!);
      const [, sid, , signedAttributes, , signatureNode] = signerInfo;
      if (signedAttributes?.tag !== 0xa0 || !sid || !signatureNode) return invalid;
      const [issuer, serial] = children(sid);
      const certificate = certificates.find((der) => {
        const ids = issuerAndSerial(der);
        return (
          Buffer.from(ids.issuer).equals(issuer!.raw) && Buffer.from(ids.serial).equals(serial!.raw)
        );
      });
      if (!certificate) return invalid;
      const x509 = new X509Certificate(certificate);
      const attributes = children(signedAttributes);
      const digest = attribute(attributes, OID.messageDigest);
      const binding = attribute(attributes, OID.signingCertificateV2);
      const expected = sha256(pdfBytes.subarray(a, a + b), pdfBytes.subarray(c, c + d));
      const asSet = signedAttributes.raw.slice();
      asSet[0] = 0x31;
      const reason = /\/Reason\s*<([0-9A-Fa-f]*)>/.exec(
        latin1.slice(Math.max(0, match.index! - 2048), match.index! + 4096),
      );
      const valid =
        !!digest &&
        Buffer.from(children(children(digest)[1]!)[0]!.content).equals(expected) &&
        verifyWith(
          'sha256',
          asSet,
          { key: x509.publicKey, dsaEncoding: 'der' },
          signatureNode.content,
        );
      // signingCertificateV2 → SET → SigningCertificateV2 → certs → first ESSCertIDv2 → certHash.
      const certHash = binding
        ? children(children(children(children(children(binding)[1]!)[0]!)[0]!)[0]!).find(
            (n) => n.tag === 0x04,
          )
        : undefined;
      const bound =
        !binding || (!!certHash && Buffer.from(certHash.content).equals(sha256(certificate)));
      return {
        valid: valid && bound,
        coversWholeDocument,
        signer: x509.subject.replace(/\n/g, ', '),
        certificate: pemOf(certificate),
        ...(reason?.[1] ? { reason: decodePdfText(reason[1]) } : {}),
      };
    } catch {
      return invalid;
    }
  });
}

/** A PDF text string written as hex (UTF-16BE with a byte order mark, or PDFDocEncoding). */
function decodePdfText(hex: string): string {
  const bytes = Buffer.from(hex, 'hex');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  return bytes.toString('latin1');
}
