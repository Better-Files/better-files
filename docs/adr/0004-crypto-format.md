# ADR-004: Encryption format for stored files

- **Status:** Accepted
- **Date:** 2026-10-03
- **Plan:** PLAN.md §11.1, §11.2

## Context

Every stored file is encrypted at rest with a key the storage provider never sees. The format must:

- **stream.** Files can be gigabytes, so neither upload nor download may buffer a whole file.
- **support random access.** HTTP range requests, viewer pages and resumable multipart uploads touch the middle of a
  file.
- **detect tampering**, including truncation, reordering and swapping one file's ciphertext for another's.
- **be producible in a browser.** Direct-mode uploads encrypt on the client with WebCrypto and send ciphertext straight
  to presigned S3 parts (PLAN §11.1).
- **support crypto-shredding.** Destroying one key must make a whole room unreadable.

## Decision

**Segmented AES-256-GCM, in the STREAM construction** (`packages/crypto/src/index.ts`):

| Parameter      | Value                                                                                 |
| -------------- | ------------------------------------------------------------------------------------- |
| Cipher         | AES-256-GCM with a 32-byte data key (DEK), fresh per blob                             |
| Segment size   | 64 KiB of plaintext (`SEGMENT_SIZE`); every segment but the last is full              |
| Stored segment | ciphertext followed by its 16-byte tag; stored size = plain size + 16 × segment count |
| Nonce (12 B)   | 7-byte random per-blob prefix ‖ uint32 big-endian segment index ‖ last-segment flag   |
| AAD            | the blob id (UTF-8), on every segment                                                 |
| Empty file     | one empty, final segment                                                              |

- The index in the nonce detects reordering. The final-segment flag detects truncation at a segment boundary. The blob
  id in the AAD stops ciphertext from being moved to another blob row.
- Segment `n` starts at byte `n × (SEGMENT_SIZE + 16)`. `ciphertextRange` turns a plaintext byte range into the stored
  range to fetch and the bytes to skip, so range reads decrypt only the segments they need.
- A multipart part encrypts with `firstSegment` and `totalSegments`, so parts can be encrypted independently and in
  parallel.

**There is no in-object header.** The format metadata lives on the blob row, in `blobs.encryption`:
`{ algorithm: 'AES-256-GCM-STREAM', segmentSize, noncePrefix }`. The row also stores the wrapped DEK and the `keyRef`
it was wrapped under. Objects in storage are opaque ciphertext. A future format gets a new `algorithm` value, and old
blobs stay readable.

**Envelope encryption through the `KeyProvider` port** (`generateDataKey`, `decryptDataKey`, and optionally
`createRoomKey` and `retireRoomKey`):

- Each DEK is wrapped under an encryption context `{ purpose: 'better-files-blob', tenantId, roomId, blobId }`. The
  context is canonicalized as sorted JSON (`contextBytes`), so a wrapped key unwraps only for the blob and room it was
  made for.
- Plaintext DEKs are zeroed after use.
- Providers:
  - `localKeyProvider` derives a per-tenant key-encryption key from one secret (HKDF-SHA256, info `better-files:kek:v1`)
    and wraps with AES-256-GCM, using the context as AAD. It is for development, tests and single-server installs.
  - `betterIamKeys` uses Better IAM's KMS, with a key per room by default (`keys.perRoom: false` uses one tenant
    alias).
  - Cloud KMS providers live in `packages/kms` (BYOK).
- **Crypto-shredding.** `rooms.delete` calls `retireRoomKey` after removing rows and blobs. Better IAM schedules
  deletion of the room key with a 7-day waiting period. After that, any copy of the room's ciphertext, including
  backups, is unreadable.

**The browser uses the same format.** `packages/client/src/direct.ts` reimplements the nonce, AAD and tag layout with
WebCrypto. For a direct upload, the server generates and wraps the DEK, then hands the plaintext DEK, nonce prefix and
AAD to the authorized uploader for that one blob. On `finish`, the server reads the whole object back and decrypts it,
and rejects the upload if any segment fails. The client therefore cannot store data the server cannot read.

## Consequences

- Downloads, range reads and viewer rendering stream with constant memory.
- Server-side and browser-side encryption are interchangeable, and both are tested against the same decrypt path.
- Each segment adds 16 bytes (0.024% overhead at 64 KiB).
- In direct mode, the client briefly holds the DEK for the blob it is uploading. That is inherent to client-side
  encryption. The DEK covers only that blob, and the read-back check still applies.
- Changing the cipher is a new `algorithm` value recorded on the blob row. The segment size is already per blob
  (`encryption.segmentSize`).

## Status of the implementation (2026-10-03)

- Key rotation by re-wrapping DEKs (`keys.reEncrypt`, `better-files keys rewrap`, PLAN §11.2) is not implemented. Rotating
  a KMS key that keeps old versions decryptable works without it. Retiring an old key version requires it.
- Only `AES-256-GCM-STREAM` exists, and readers do not check `encryption.algorithm` today (the type admits only that
  value). The read path should refuse unknown values before a second format is added.
