import { describe, expect, it } from 'vitest';
import { definePlugin } from '@better-files/core';
import { encryptedSize } from '@better-files/crypto';
import { as, fixture, TENANT } from '../fixtures.js';

describe('uploads and downloads', () => {
  it('stores a single upload encrypted and serves the original with ranges', async () => {
    const f = await fixture();
    const room = await f.room();
    const content = f.bytes(100_000);
    const { document, version } = await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'model.xlsx',
      content,
      mimeType: 'application/vnd.ms-excel',
    });
    expect(version).toMatchObject({
      number: 1,
      status: 'ready',
      size: 100_000,
      sha256: f.sha256(content),
      filename: 'model.xlsx',
    });
    expect(document.document).toMatchObject({
      latestVersion: 1,
      size: 100_000,
      currentVersionId: version.id,
    });

    // At rest: one object, larger than the plaintext by one tag per segment, with no plaintext in it.
    const [stored] = [...f.storage.objects.values()];
    expect(stored!.byteLength).toBe(encryptedSize(100_000));
    expect(Buffer.from(stored!).includes(Buffer.from(content.subarray(1000, 1064)))).toBe(false);

    const ticket = await f.dr.api.documents.requestOriginal(as('alice'), {
      tenantId: TENANT,
      nodeId: document.id,
    });
    expect(ticket.url).toMatch(/^\/api\/better-files\/files\/tkt_/);
    const full = await f.download(ticket.url);
    expect(full.response.status).toBe(200);
    expect(full.response.headers.get('content-disposition')).toContain(
      'attachment; filename="model.xlsx"',
    );
    expect(full.response.headers.get('content-type')).toBe('application/octet-stream');
    expect(full.response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(full.body).equals(Buffer.from(content))).toBe(true);

    // A range across a segment boundary decrypts only the segments it touches.
    const partial = await f.download(ticket.url, 'bytes=65530-65545');
    expect(partial.response.status).toBe(206);
    expect(partial.response.headers.get('content-range')).toBe('bytes 65530-65545/100000');
    expect(Buffer.from(partial.body).equals(Buffer.from(content.subarray(65530, 65546)))).toBe(
      true,
    );
    const suffix = await f.download(ticket.url, 'bytes=-10');
    expect(Buffer.from(suffix.body).equals(Buffer.from(content.subarray(99_990)))).toBe(true);
    expect((await f.download(ticket.url, 'bytes=200000-')).response.status).toBe(416);
  });

  it('assembles multipart uploads out of order and verifies the checksum', async () => {
    const f = await fixture();
    const room = await f.room();
    const content = f.bytes(150_000, 7);
    const { document, version } = await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'big.bin',
      content,
    });
    expect(version.sha256).toBe(f.sha256(content));
    const ticket = await f.dr.api.documents.requestOriginal(as('alice'), {
      tenantId: TENANT,
      nodeId: document.id,
    });
    expect(Buffer.from((await f.download(ticket.url)).body).equals(Buffer.from(content))).toBe(
      true,
    );

    const session = await f.dr.api.uploads.create(as('alice'), {
      tenantId: TENANT,
      parentId: room.rootNodeId,
      filename: 'wrong.bin',
      size: 10,
      sha256: '0'.repeat(64),
    });
    await f.dr.files.upload(as('alice'), {
      tenantId: TENANT,
      uploadId: session.uploadId,
      body: f.bytes(10),
    });
    await expect(
      f.dr.api.uploads.complete(as('alice'), { tenantId: TENANT, uploadId: session.uploadId }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('refuses too much or too little data, other people’s sessions and incomplete multipart uploads', async () => {
    const f = await fixture();
    const room = await f.room();
    const session = await f.dr.api.uploads.create(as('alice'), {
      tenantId: TENANT,
      parentId: room.rootNodeId,
      filename: 'a.txt',
      size: 5,
    });
    await expect(
      f.dr.files.upload(as('alice'), {
        tenantId: TENANT,
        uploadId: session.uploadId,
        body: f.bytes(6),
      }),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    await expect(
      f.dr.files.upload(as('alice'), {
        tenantId: TENANT,
        uploadId: session.uploadId,
        body: f.bytes(4),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      f.dr.files.upload(as('bob'), {
        tenantId: TENANT,
        uploadId: session.uploadId,
        body: f.bytes(5),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const multi = await f.dr.api.uploads.create(as('alice'), {
      tenantId: TENANT,
      parentId: room.rootNodeId,
      filename: 'm.bin',
      size: 200_000,
    });
    expect(multi).toMatchObject({ multipart: true, parts: 4 });
    await f.dr.files.upload(as('alice'), {
      tenantId: TENANT,
      uploadId: multi.uploadId,
      part: 1,
      body: f.bytes(65_536),
    });
    await expect(
      f.dr.api.uploads.complete(as('alice'), { tenantId: TENANT, uploadId: multi.uploadId }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(
      await f.dr.api.uploads.abort(as('alice'), { tenantId: TENANT, uploadId: multi.uploadId }),
    ).toEqual({ aborted: true });
    await expect(
      f.dr.api.uploads.create(as('alice'), {
        tenantId: TENANT,
        parentId: room.rootNodeId,
        filename: 'a.txt',
        size: 1,
        documentId: 'x',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('keeps versions and restores an older one', async () => {
    const f = await fixture();
    const room = await f.room();
    const first = await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'deck.pdf',
      content: f.bytes(1000, 1),
    });
    const second = await f.upload('alice', {
      documentId: first.document.id,
      filename: 'deck-v2.pdf',
      content: f.bytes(2000, 2),
    });
    expect(second.version.number).toBe(2);
    const versions = await f.dr.api.versions.list(as('alice'), {
      tenantId: TENANT,
      nodeId: first.document.id,
    });
    expect(versions.map((v) => v.number)).toEqual([2, 1]);
    await f.dr.api.versions.restore(as('alice'), {
      tenantId: TENANT,
      nodeId: first.document.id,
      versionId: first.version.id,
    });
    const document = await f.dr.api.documents.get(as('alice'), {
      tenantId: TENANT,
      nodeId: first.document.id,
    });
    expect(document.currentVersion?.number).toBe(1);
    const ticket = await f.dr.api.documents.requestOriginal(as('alice'), {
      tenantId: TENANT,
      nodeId: first.document.id,
    });
    expect((await f.download(ticket.url)).body.byteLength).toBe(1000);
  });

  it('limits ticket uses and lifetime and rejects forged tokens', async () => {
    const f = await fixture();
    const room = await f.room();
    const { document } = await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'a.txt',
      content: f.bytes(10),
    });
    const ticket = await f.dr.api.documents.requestOriginal(as('alice'), {
      tenantId: TENANT,
      nodeId: document.id,
    });
    for (let use = 0; use < 5; use++)
      expect((await f.download(ticket.url)).response.status).toBe(200);
    expect((await f.download(ticket.url)).response.status).toBe(410);
    const fresh = await f.dr.api.documents.requestOriginal(as('alice'), {
      tenantId: TENANT,
      nodeId: document.id,
    });
    const forged = fresh.url.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    expect((await f.download(forged)).response.status).toBe(404);
    f.clock.current += 61_000;
    expect((await f.download(fresh.url)).response.status).toBe(404);
  });

  it('never falls back to the original for watermarked downloads', async () => {
    const f = await fixture();
    const room = await f.room();
    const { document } = await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'a.txt',
      content: f.bytes(10),
    });
    const ticket = await f.dr.api.documents.requestDownload(as('alice'), {
      tenantId: TENANT,
      nodeId: document.id,
    });
    const refused = await f.download(ticket.url);
    expect(refused.response.status).toBe(501);

    const stamp = definePlugin({
      id: 'stamp',
      hooks: {
        async transformDownload({ variant, stream, context }) {
          if (variant !== 'watermarked') return undefined;
          const original = new Uint8Array(await new Response(stream).arrayBuffer());
          const mark = new TextEncoder().encode(`|${context.principal.email}`);
          const out = new Uint8Array(original.byteLength + mark.byteLength);
          out.set(original);
          out.set(mark, original.byteLength);
          return { stream: new Response(out).body!, mimeType: 'text/plain', size: out.byteLength };
        },
      },
    });
    const g = await fixture({ plugins: [stamp] });
    const room2 = await g.room();
    const doc2 = await g.upload('alice', {
      parentId: room2.rootNodeId,
      filename: 'b.txt',
      content: new TextEncoder().encode('secret'),
    });
    const marked = await g.dr.api.documents.requestDownload(as('alice'), {
      tenantId: TENANT,
      nodeId: doc2.document.id,
    });
    const served = await g.download(marked.url);
    expect(new TextDecoder().decode(served.body)).toBe('secret|alice@acme.test');
  });

  it('serves uploads and downloads over HTTP', async () => {
    const f = await fixture();
    const room = await f.room();
    const content = f.bytes(3000);
    const session = await f.dr.api.uploads.create(as('alice'), {
      tenantId: TENANT,
      parentId: room.rootNodeId,
      filename: 'http.bin',
      size: 3000,
    });
    const put = await f.dr.handler(
      new Request(`http://app.test${session.contentUrl}`, {
        method: 'PUT',
        headers: { authorization: 'Bearer alice', 'x-better-files': '1' },
        body: content,
      }),
    );
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ data: { uploadId: session.uploadId, received: 3000 } });
    const done = await f.dr.handler(
      new Request('http://app.test/api/better-files/uploads/complete', {
        method: 'POST',
        headers: {
          authorization: 'Bearer alice',
          'x-better-files': '1',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ tenantId: TENANT, uploadId: session.uploadId }),
      }),
    );
    const { data } = (await done.json()) as { data: { document: { id: string } } };
    const ticket = await f.dr.api.documents.requestOriginal(as('alice'), {
      tenantId: TENANT,
      nodeId: data.document.id,
    });
    const got = await f.dr.handler(
      new Request(`http://app.test${ticket.url}`, { headers: { range: 'bytes=0-99' } }),
    );
    expect(got.status).toBe(206);
    expect(Buffer.from(await got.arrayBuffer()).equals(Buffer.from(content.subarray(0, 100)))).toBe(
      true,
    );
    // PUT without the CSRF header is refused.
    const csrf = await f.dr.handler(
      new Request(`http://app.test${session.contentUrl}`, {
        method: 'PUT',
        headers: { authorization: 'Bearer alice' },
        body: content,
      }),
    );
    expect(csrf.status).toBe(403);
  });

  it('cleans up expired tickets, abandoned uploads and old trash in maintain()', async () => {
    const f = await fixture();
    const room = await f.room();
    const { document } = await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'old.txt',
      content: f.bytes(10),
    });
    await f.dr.api.documents.requestOriginal(as('alice'), {
      tenantId: TENANT,
      nodeId: document.id,
    });
    await f.dr.api.uploads.create(as('alice'), {
      tenantId: TENANT,
      parentId: room.rootNodeId,
      filename: 'left.txt',
      size: 3,
    });
    await f.dr.api.documents.delete(as('alice'), { tenantId: TENANT, nodeId: document.id });
    expect(f.storage.objects.size).toBe(1);
    f.clock.current += 31 * 86_400_000;
    const result = await f.dr.maintain();
    expect(result).toEqual({
      tickets: 1,
      uploads: 1,
      purged: 1,
      closed: 0,
      expiredMembers: 0,
      jobs: 0,
    });
    expect(f.storage.objects.size).toBe(0);
    expect(await f.database.count('versions')).toBe(0);
  });
});
