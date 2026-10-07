import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { conformanceSchema, databaseConformanceCases } from '@better-files/core/conformance';
import { generateSchema, intervalStart } from '@better-files/adapter-sql';
import { partitionsPlugin, pgliteAdapter } from '@better-files/adapter-pglite';
import { as, fixture, TENANT } from '../fixtures.js';

const MONTH = { activity: { interval: 'month', premake: 2 } } as const;

async function kindOf(client: PGlite, table: string) {
  const { rows } = await client.query<{ kind: string }>(
    'SELECT relkind AS kind FROM pg_class WHERE oid = to_regclass($1)',
    [table],
  );
  return rows[0]?.kind;
}

async function rowsIn(client: PGlite, table: string) {
  const { rows } = await client.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM "${table}"`,
  );
  return rows[0]!.count;
}

describe('PostgreSQL partitioning', () => {
  it('interval starts are UTC calendar boundaries', () => {
    const at = Date.UTC(2026, 9, 3, 15, 30); // Saturday 2026-10-03
    expect(intervalStart('day', at)).toBe(Date.UTC(2026, 9, 3));
    expect(intervalStart('week', at)).toBe(Date.UTC(2026, 8, 28)); // Monday
    expect(intervalStart('month', at, 3)).toBe(Date.UTC(2027, 0, 1));
    expect(intervalStart('year', at, -1)).toBe(Date.UTC(2025, 0, 1));
  });

  it('partitions the activity log, moves stray rows out of the default partition and keeps the chain valid', async () => {
    const client = await PGlite.create();
    const database = pgliteAdapter({ client, partitions: MONTH });
    const f = await fixture({ database, plugins: [partitionsPlugin(database)] });
    expect(await kindOf(client, 'better_files_activity')).toBe('p');

    // The fixture's clock is September 2026; activity written at that time may predate the ranges migrate made.
    const room = await f.room();
    const team = await f.dr.api.groups.create(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      name: 'Buyers',
      preset: 'view',
    });
    expect(team.id).toBeTruthy();

    await f.dr.maintain();
    let [status] = await database.partitions!.status();
    expect(status).toMatchObject({ model: 'activity', partitioned: true, defaultRows: 0 });
    const names = status!.partitions.map((p) => p.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'better_files_activity_default',
        'better_files_activity_p202609',
        'better_files_activity_p202610',
        'better_files_activity_p202611',
      ]),
    );
    expect(await rowsIn(client, 'better_files_activity_p202609')).toBeGreaterThan(0);

    // Half a year later, with no maintenance in between: new rows land in the default partition until it runs.
    f.clock.current = Date.UTC(2027, 2, 15);
    await f.dr.api.rooms.update(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      name: 'Project Falcon II',
    });
    [status] = await database.partitions!.status();
    const strays = status!.defaultRows;
    const result = await database.partitions!.maintain(f.clock.current);
    expect(result.moved).toBe(strays);
    expect(result.created).toEqual(
      expect.arrayContaining(['better_files_activity_p202703', 'better_files_activity_p202705']),
    );
    expect(await rowsIn(client, 'better_files_activity_default')).toBe(0);
    expect(
      await f.dr.api.activity.verify(as('alice'), { tenantId: TENANT, roomId: room.id }),
    ).toMatchObject({ valid: true });

    // Idempotent.
    expect(await database.partitions!.maintain(f.clock.current)).toEqual({
      created: [],
      moved: 0,
      detached: [],
      dropped: [],
    });
    await client.close();
  });

  it('detaches or drops partitions beyond retain', async () => {
    const client = await PGlite.create();
    const database = pgliteAdapter({
      client,
      partitions: { activity: { interval: 'month', premake: 1, retain: 2 } },
    });
    const f = await fixture({ database });
    await f.room();
    await database.partitions!.maintain(f.clock.current); // September 2026: its rows get p202609
    const december = await database.partitions!.maintain(Date.UTC(2026, 11, 5));
    const january = await database.partitions!.maintain(Date.UTC(2027, 0, 10));
    const detached = [...december.detached, ...january.detached];
    // Kept: December 2026 and January 2027 (and February, made ahead).
    expect(detached).toContain('better_files_activity_p202609');
    expect(january.created).toContain('better_files_activity_p202702');
    expect(detached).not.toContain('better_files_activity_p202612');
    // A detached partition is an ordinary table, ready to archive.
    expect(await kindOf(client, 'better_files_activity_p202609')).toBe('r');
    expect(await rowsIn(client, 'better_files_activity_p202609')).toBeGreaterThan(0);
    const [status] = await database.partitions!.status();
    expect(status!.partitions.map((p) => p.name)).not.toContain('better_files_activity_p202609');

    const dropping = pgliteAdapter({
      client,
      partitions: { activity: { interval: 'month', retain: 1, expire: 'drop' } },
    });
    await fixture({ database: dropping });
    const dropped = await dropping.partitions!.maintain(Date.UTC(2027, 5, 1));
    expect(dropped.dropped).toContain('better_files_activity_p202612');
    expect(await kindOf(client, 'better_files_activity_p202612')).toBeUndefined();
    await client.close();
  });

  it('converts an existing activity table with rows', async () => {
    const client = await PGlite.create();
    const plain = await fixture({ database: pgliteAdapter({ client }) });
    const room = await plain.room();
    const before = await rowsIn(client, 'better_files_activity');
    expect(before).toBeGreaterThan(0);

    const database = pgliteAdapter({ client, partitions: MONTH });
    const f = await fixture({ database });
    // Migrate leaves a table with rows alone.
    let [status] = await database.partitions!.status();
    expect(status).toMatchObject({ partitioned: false, partitions: [] });

    expect(await database.partitions!.convert('activity', f.clock.current)).toBe(true);
    expect(await database.partitions!.convert('activity', f.clock.current)).toBe(false);
    [status] = await database.partitions!.status();
    expect(status).toMatchObject({ partitioned: true, defaultRows: 0 });
    expect(await rowsIn(client, 'better_files_activity')).toBe(before);
    // The first instance holds the room's grants in its identity fake; it reads and writes the converted table.
    expect(
      await plain.dr.api.activity.verify(as('alice'), { tenantId: TENANT, roomId: room.id }),
    ).toMatchObject({ valid: true, records: before });
    await plain.dr.api.rooms.update(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      name: 'Renamed',
    });
    expect(await rowsIn(client, 'better_files_activity')).toBe(before + 1);
    await client.close();
  });

  it('refuses unsafe or impossible configurations', async () => {
    const client = await PGlite.create();
    const outbox = pgliteAdapter({ client, partitions: { outbox: { interval: 'month' } } });
    await expect(fixture({ database: outbox })).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      message: expect.stringContaining('relaxUnique'),
    });
    const unknown = pgliteAdapter({ client, partitions: { nope: { interval: 'month' } } });
    await expect(fixture({ database: unknown })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(() =>
      generateSchema(conformanceSchema, {
        format: 'sql',
        dialect: 'sqlite',
        partitions: { widgets: { interval: 'month', relaxUnique: true } },
      }),
    ).toThrow(/postgres/);
    await client.close();
  });

  it('generates partitioned DDL', () => {
    const sql = generateSchema(conformanceSchema, {
      format: 'sql',
      dialect: 'postgres',
      partitions: { widgets: { interval: 'month', relaxUnique: true } },
    });
    expect(sql).toContain('PARTITION BY RANGE ("created_at")');
    expect(sql).toContain('PRIMARY KEY ("id", "created_at")');
    expect(sql).toContain('"conf_widgets_default" PARTITION OF "conf_widgets" DEFAULT');
    expect(sql).toMatch(
      /UNIQUE INDEX IF NOT EXISTS "[^"]+" ON "conf_widgets" \("code", "created_at"\)/,
    );
  });

  // Every adapter behavior holds on a partitioned table, except that uniqueness now includes the partition column.
  describe('conformance on a partitioned table', () => {
    for (const testCase of databaseConformanceCases())
      it.skipIf(testCase.name === 'enforces unique fields and unique indexes')(
        testCase.name,
        async () => {
          const db = pgliteAdapter({
            partitions: { widgets: { interval: 'day', premake: 1, relaxUnique: true } },
          });
          try {
            await db.migrate(conformanceSchema);
            await testCase.run(db);
          } finally {
            await db.close?.();
          }
        },
      );
  });
});
