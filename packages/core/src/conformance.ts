import { BetterFilesError } from './errors.js';
import type { DatabaseAdapter, StorageAdapter } from './ports.js';
import { defineTable, field, resolveSchema, type ResolvedSchema } from './schema.js';

/** A small schema every database adapter must handle; separate from the core tables so failures are easy to read. */
export const conformanceSchema: ResolvedSchema = resolveSchema(
  [
    {
      source: 'conformance',
      tables: {
        widgets: defineTable({
          fields: {
            name: field.string(),
            size: field.number(),
            active: field.boolean(),
            color: field.enum(['red', 'blue'] as const, { required: false }),
            meta: field.json<{ tags: string[] }>({ required: false }),
            code: field.string({ unique: true }),
          },
          indexes: [{ fields: ['tenantId', 'name'], unique: true }],
        }),
      },
    },
  ],
  { tablePrefix: 'conf_' },
);

interface Widget {
  id: string;
  tenantId: string;
  createdAt: number;
  name: string;
  size: number;
  active: boolean;
  color?: 'red' | 'blue';
  meta?: { tags: string[] };
  code: string;
}

export interface ConformanceCase {
  name: string;
  run(adapter: DatabaseAdapter): Promise<void>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Conformance: ${message}`);
}

const widget = (n: number, overrides: Partial<Widget> = {}): Widget => ({
  id: `w${n}`,
  tenantId: 't1',
  createdAt: 1_000 + n,
  name: `widget-${n}`,
  size: n,
  active: n % 2 === 0,
  code: `code-${n}`,
  ...overrides,
});

async function seed(adapter: DatabaseAdapter, count: number) {
  await adapter.transaction(async (tx) => {
    for (let n = 1; n <= count; n++) await tx.insert('widgets', widget(n));
  });
}

async function expectConflict(action: () => Promise<unknown>, message: string) {
  try {
    await action();
  } catch (error) {
    assert(
      error instanceof BetterFilesError && error.code === 'CONFLICT',
      `${message}: expected CONFLICT`,
    );
    return;
  }
  throw new Error(`Conformance: ${message}: expected a CONFLICT error`);
}

/**
 * Behavior every `DatabaseAdapter` must share. Each case expects a fresh adapter on which `migrate(conformanceSchema)`
 * has run; `runDatabaseConformance` in tests wires that up for any test framework.
 */
export function databaseConformanceCases(): ConformanceCase[] {
  return [
    {
      name: 'inserts and reads back every field type',
      async run(db) {
        const record = widget(1, { color: 'red', meta: { tags: ['a', 'b'] } });
        await db.transaction((tx) => tx.insert('widgets', record));
        const found = await db.findOne<Widget>('widgets', { id: 'w1' });
        assert(found, 'record not found');
        assert(
          found.name === 'widget-1' && found.size === 1 && found.active === false,
          'scalars differ',
        );
        assert(found.color === 'red', 'enum differs');
        assert(JSON.stringify(found.meta) === '{"tags":["a","b"]}', 'json differs');
        assert(found.createdAt === 1001, 'timestamp differs');
      },
    },
    {
      name: 'returns null for a missing record and omits absent optional fields',
      async run(db) {
        await seed(db, 1);
        assert((await db.findOne('widgets', { id: 'missing' })) === null, 'expected null');
        const found = await db.findOne<Widget>('widgets', { id: 'w1' });
        assert(
          found && found.color === undefined,
          'absent optional field should read as undefined',
        );
      },
    },
    {
      name: 'filters with operators',
      async run(db) {
        await seed(db, 6);
        const ids = async (where: Parameters<DatabaseAdapter['findMany']>[1]) =>
          (await db.findMany<Widget>('widgets', { ...where, orderBy: [{ field: 'size' }] }))
            .map((w) => w.id)
            .join(',');
        assert((await ids({ where: { size: { gt: 4 } } })) === 'w5,w6', 'gt');
        assert((await ids({ where: { size: { lte: 2 } } })) === 'w1,w2', 'lte');
        assert((await ids({ where: { id: { in: ['w2', 'w4', 'x'] } } })) === 'w2,w4', 'in');
        assert((await ids({ where: { active: true, size: { ne: 2 } } })) === 'w4,w6', 'and + ne');
        assert(
          (await ids({ where: { color: { isNull: true }, size: { lt: 3 } } })) === 'w1,w2',
          'isNull',
        );
        assert(
          (await ids({ where: { id: { notIn: ['w1', 'w2', 'w3', 'w4'] } } })) === 'w5,w6',
          'notIn',
        );
        assert(
          (await ids({ where: { name: { contains: 'GET-5' } } })) === 'w5',
          'contains is case-insensitive',
        );
        await db.transaction((tx) => tx.update('widgets', { id: 'w6' }, { name: '50%_off\\sale' }));
        assert(
          (await ids({ where: { name: { contains: '%_off\\' } } })) === 'w6',
          'contains escapes wildcards',
        );
        assert(
          (await ids({ where: { name: { contains: '_' } } })) === 'w6',
          'underscore is literal',
        );
      },
    },
    {
      name: 'orders, limits and offsets',
      async run(db) {
        await seed(db, 5);
        const page = await db.findMany<Widget>('widgets', {
          orderBy: [{ field: 'size', direction: 'desc' }],
          limit: 2,
          offset: 1,
        });
        assert(page.map((w) => w.id).join(',') === 'w4,w3', 'page order');
        assert((await db.count('widgets', { active: true })) === 2, 'count');
      },
    },
    {
      name: 'enforces unique fields and unique indexes',
      async run(db) {
        await seed(db, 1);
        await expectConflict(
          () => db.transaction((tx) => tx.insert('widgets', widget(2, { code: 'code-1' }))),
          'unique field',
        );
        await expectConflict(
          () => db.transaction((tx) => tx.insert('widgets', widget(3, { name: 'widget-1' }))),
          'unique index',
        );
        await db.transaction((tx) =>
          tx.insert('widgets', widget(4, { tenantId: 't2', name: 'widget-1' })),
        );
        await expectConflict(
          () =>
            db.transaction((tx) =>
              tx.insert('widgets', widget(1, { code: 'other', name: 'other' })),
            ),
          'primary key',
        );
      },
    },
    {
      name: 'updates and deletes by condition and reports counts',
      async run(db) {
        await seed(db, 4);
        const changed = await db.transaction((tx) =>
          tx.update('widgets', { active: true }, { size: 100 }),
        );
        assert(changed === 2, 'update count');
        assert((await db.count('widgets', { size: 100 })) === 2, 'updated rows');
        const removed = await db.transaction((tx) => tx.delete('widgets', { size: { lt: 100 } }));
        assert(removed === 2, 'delete count');
        assert((await db.count('widgets')) === 2, 'remaining rows');
      },
    },
    {
      name: 'rolls back a failed transaction completely',
      async run(db) {
        await seed(db, 1);
        try {
          await db.transaction(async (tx) => {
            await tx.insert('widgets', widget(2));
            await tx.update('widgets', { id: 'w1' }, { size: 50 });
            throw new Error('abort');
          });
        } catch {}
        assert((await db.count('widgets')) === 1, 'insert was not rolled back');
        assert(
          (await db.findOne<Widget>('widgets', { id: 'w1' }))?.size === 1,
          'update was not rolled back',
        );
      },
    },
    {
      name: 'nested transactions join the outer one',
      async run(db) {
        try {
          await db.transaction(async (tx) => {
            await tx.transaction((inner) => inner.insert('widgets', widget(1)));
            throw new Error('abort');
          });
        } catch {}
        assert((await db.count('widgets')) === 0, 'inner write survived an outer rollback');
      },
    },
    {
      name: 'refuses to change id or tenantId',
      async run(db) {
        await seed(db, 1);
        for (const patch of [{ id: 'w9' }, { tenantId: 't9' }]) {
          let refused = false;
          try {
            await db.transaction((tx) => tx.update('widgets', { id: 'w1' }, patch));
          } catch (error) {
            refused = error instanceof BetterFilesError;
          }
          assert(refused, `changing ${Object.keys(patch)[0]} should throw a BetterFilesError`);
        }
      },
    },
    {
      name: 'migrate is idempotent',
      async run(db) {
        await db.migrate(conformanceSchema);
        await seed(db, 1);
        await db.migrate(conformanceSchema);
        assert((await db.count('widgets')) === 1, 'second migrate lost data');
      },
    },
    {
      name: 'increments a counter atomically and reports the new value',
      async run(db) {
        await seed(db, 2);
        const first = await db.transaction((tx) => tx.increment('widgets', { id: 'w1' }, 'size'));
        const second = await db.transaction((tx) =>
          tx.increment('widgets', { id: 'w1' }, 'size', 5),
        );
        assert(first === 2 && second === 7, `expected 2 then 7, got ${first} then ${second}`);
        const missing = await db.transaction((tx) =>
          tx.increment('widgets', { id: 'nope' }, 'size'),
        );
        assert(missing === null, 'missing row should give null');
        const results = await Promise.all(
          Array.from({ length: 10 }, () =>
            db.transaction((tx) => tx.increment('widgets', { id: 'w2' }, 'size')),
          ),
        );
        assert(new Set(results).size === 10, 'concurrent increments returned duplicate values');
        assert((await db.findOne<Widget>('widgets', { id: 'w2' }))?.size === 12, 'final value');
      },
    },
  ];
}
// ─── Storage ─────────────────────────────────────────────────────────────────────────────────────

export interface StorageConformanceCase {
  name: string;
  run(storage: StorageAdapter): Promise<void>;
}

const bytesOf = (text: string) => new TextEncoder().encode(text);
async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(out);
}
const streamOf = (value: string) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytesOf(value.slice(0, 3)));
      controller.enqueue(bytesOf(value.slice(3)));
      controller.close();
    },
  });

/** Behavior every `StorageAdapter` must share; each case gets an empty store. */
export function storageConformanceCases(): StorageConformanceCase[] {
  return [
    {
      name: 'puts bytes and streams, and reads them back whole and by range',
      async run(storage) {
        const stored = await storage.put('t1/a/one.bin', bytesOf('hello world'));
        assert(stored.size === 11, 'put size');
        await storage.put('t1/a/two.bin', streamOf('streamed body'), { contentLength: 13 });
        assert((await text(await storage.get('t1/a/one.bin'))) === 'hello world', 'full read');
        assert((await text(await storage.get('t1/a/two.bin'))) === 'streamed body', 'stream put');
        assert(
          (await text(await storage.get('t1/a/one.bin', { start: 6, end: 10 }))) === 'world',
          'range',
        );
        assert(
          (await text(await storage.get('t1/a/one.bin', { start: 6 }))) === 'world',
          'open range',
        );
      },
    },
    {
      name: 'heads, overwrites and deletes',
      async run(storage) {
        assert((await storage.head('t1/missing')) === null, 'missing head');
        await storage.put('t1/x', bytesOf('first'));
        await storage.put('t1/x', bytesOf('second!'));
        assert((await storage.head('t1/x'))?.size === 7, 'overwrite size');
        await storage.delete('t1/x');
        assert((await storage.head('t1/x')) === null, 'deleted');
        await storage.delete('t1/x');
        let missing = false;
        try {
          await storage.get('t1/x');
        } catch (error) {
          missing = error instanceof BetterFilesError && error.code === 'NOT_FOUND';
        }
        assert(missing, 'reading a deleted object should be NOT_FOUND');
      },
    },
    {
      name: 'copies objects',
      async run(storage) {
        if (!storage.copy) return;
        await storage.put('t1/src', bytesOf('copy me'));
        await storage.copy('t1/src', 't1/dst');
        assert((await text(await storage.get('t1/dst'))) === 'copy me', 'copy');
      },
    },
    {
      name: 'assembles multipart uploads in part order',
      async run(storage) {
        if (!storage.multipart) return;
        const { uploadId } = await storage.multipart.create('t1/big');
        const two = await storage.multipart.uploadPart('t1/big', uploadId, 2, bytesOf(' world'));
        const one = await storage.multipart.uploadPart('t1/big', uploadId, 1, bytesOf('hello'));
        const done = await storage.multipart.complete('t1/big', uploadId, [
          { part: 2, etag: two.etag },
          { part: 1, etag: one.etag },
        ]);
        assert(done.size === 11, `multipart size ${done.size}`);
        assert((await text(await storage.get('t1/big'))) === 'hello world', 'multipart content');
        const aborted = await storage.multipart.create('t1/gone');
        await storage.multipart.uploadPart('t1/gone', aborted.uploadId, 1, bytesOf('x'));
        await storage.multipart.abort('t1/gone', aborted.uploadId);
        assert((await storage.head('t1/gone')) === null, 'aborted upload left an object');
      },
    },
  ];
}
