import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  coreTables,
  coreActions,
  defineTable,
  field,
  operationMatrix,
  resolveSchema,
  type InferFields,
  type Room,
} from '@better-files/core';

describe('schema model', () => {
  it('prefixes tables, snake-cases columns and adds base fields', () => {
    const schema = resolveSchema([{ source: 'core', tables: coreTables }]);
    expect(schema.tables.aclEntries!.tableName).toBe('better_files_acl_entries');
    expect(schema.tables.aclEntries!.fields.subjectId!.columnName).toBe('subject_id');
    expect(Object.keys(schema.tables.rooms!.fields).slice(0, 3)).toEqual([
      'id',
      'tenantId',
      'createdAt',
    ]);
  });

  it('adds typed fields from plugins and options, and renames tables', () => {
    const schema = resolveSchema(
      [
        { source: 'core', tables: coreTables },
        {
          source: 'qa',
          tables: {
            questions: defineTable({ fields: { roomId: field.string(), text: field.string() } }),
          },
          extend: {
            rooms: { additionalFields: { qaEnabled: field.boolean({ required: false }) } },
          },
        },
      ],
      {
        tablePrefix: 'dr_',
        tables: {
          rooms: {
            tableName: 'deal_rooms',
            additionalFields: { dealCode: field.string({ indexed: true }) },
          },
        },
      },
    );
    expect(schema.tables.rooms!.tableName).toBe('deal_rooms');
    expect(schema.tables.questions!.tableName).toBe('dr_questions');
    expect(schema.tables.questions!.source).toBe('qa');
    expect(schema.tables.rooms!.fields.dealCode).toMatchObject({ required: true, indexed: true });
    expect(schema.tables.rooms!.fields.qaEnabled).toMatchObject({ required: false });
  });

  it('refuses collisions and unknown targets', () => {
    const core = { source: 'core', tables: coreTables };
    expect(() =>
      resolveSchema([core, { source: 'x', tables: { rooms: defineTable({ fields: {} }) } }]),
    ).toThrow(/already declared by core/);
    expect(() =>
      resolveSchema([core], { tables: { rooms: { additionalFields: { name: field.string() } } } }),
    ).toThrow(/declared more than once/);
    expect(() =>
      resolveSchema([
        core,
        { source: 'x', extend: { nope: { additionalFields: { a: field.string() } } } },
      ]),
    ).toThrow(/unknown table nope/);
    expect(() =>
      resolveSchema([
        {
          source: 'x',
          tables: { t: defineTable({ fields: {}, indexes: [{ fields: ['missing'] }] }) },
        },
      ]),
    ).toThrow(/unknown field missing/);
  });

  it('infers required and optional fields', () => {
    const fields = {
      a: field.string(),
      b: field.number({ required: false }),
      c: field.enum(['x', 'y'] as const),
      d: field.json<{ n: number }>({ required: false }),
    };
    expectTypeOf<InferFields<typeof fields>>().toEqualTypeOf<{
      a: string;
      c: 'x' | 'y';
      b?: number;
      d?: { n: number };
    }>();
    expectTypeOf<Room['status']>().toEqualTypeOf<
      'provisioning' | 'draft' | 'live' | 'closed' | 'archived'
    >();
    expectTypeOf<Room['kmsKeyId']>().toEqualTypeOf<string | undefined>();
  });
});

describe('operation matrix', () => {
  it('maps every node operation to capabilities and every action into the better-files namespace', () => {
    for (const [name, spec] of Object.entries(operationMatrix)) {
      expect(spec.action, name).toMatch(/^better-files:/);
      if (spec.target === 'node') expect(spec.capabilities?.length, name).toBeTruthy();
    }
    expect(coreActions).toContain('better-files:documents:download-original');
    expect(coreActions).toContain('better-files:admin');
    expect(new Set(coreActions).size).toBe(coreActions.length);
  });
});
