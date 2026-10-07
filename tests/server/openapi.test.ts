import { describe, expect, it } from 'vitest';
import { toJsonSchema, v } from '@better-files/core';
import { qaPlugin } from '@better-files/plugin-qa';
import { esignPlugin } from '@better-files/plugin-esign';
import { fixture } from '../fixtures.js';

type Operation = {
  operationId: string;
  security?: unknown[];
  description: string;
  requestBody: { content: { 'application/json': { schema: Record<string, unknown> } } };
  'x-better-files': { action: string; target: string; capabilities: string[] };
};

describe('OpenAPI', () => {
  it('describes v schemas as JSON Schema', () => {
    const schema = v.object({
      name: v.string({ min: 1, max: 20, trim: true }),
      count: v.optional(v.number({ int: true, min: 0 })),
      kind: v.enum(['a', 'b'] as const),
      tags: v.array(v.id(), { max: 5 }),
      note: v.nullable(v.string()),
    });
    expect(toJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 20 },
        count: { type: 'integer', minimum: 0 },
        kind: { type: 'string', enum: ['a', 'b'] },
        tags: {
          type: 'array',
          items: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_.:-]+$' },
          maxItems: 5,
        },
        note: { anyOf: [{ type: 'string', maxLength: 10_000 }, { type: 'null' }] },
      },
      required: ['name', 'kind', 'tags', 'note'],
      additionalProperties: false,
    });
    // Libraries without the extension are simply not described.
    expect(
      toJsonSchema({ '~standard': { version: 1, vendor: 'x', validate: (value) => ({ value }) } }),
    ).toBeUndefined();
  });

  it('documents every core and plugin operation with its access rules', async () => {
    const f = await fixture({
      plugins: [qaPlugin(), esignPlugin({ deliver: async () => undefined })],
    });
    const doc = f.dr.openapi({ title: 'Deals API', servers: ['https://app.example.com'] });
    expect(doc).toMatchObject({
      openapi: '3.1.0',
      info: { title: 'Deals API' },
      servers: [{ url: 'https://app.example.com' }],
    });

    const operations = Object.values(doc.paths).flatMap((item) =>
      Object.values(item as Record<string, Operation>),
    );
    const ids = operations.map((operation) => operation.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [
      'rooms.create',
      'documents.requestOriginal',
      'folders.restore',
      'qa.ask',
      'esign.sign',
      'uploads.part',
      'files.serve',
    ])
      expect(ids).toContain(id);

    const original = operations.find(
      (operation) => operation.operationId === 'documents.requestOriginal',
    )!;
    expect(original['x-better-files']).toMatchObject({
      target: 'node',
      capabilities: ['DOWNLOAD_ORIGINAL'],
    });
    expect(original.description).toContain('`DOWNLOAD_ORIGINAL`');
    expect(original.requestBody.content['application/json'].schema).toMatchObject({
      required: ['tenantId', 'nodeId'],
      properties: { tenantId: { type: 'string' }, nodeId: { type: 'string' } },
      additionalProperties: false,
    });

    // Public operations need no session.
    expect(
      operations.find((operation) => operation.operationId === 'esign.sign')!.security,
    ).toEqual([]);
    expect(doc.paths['/api/better-files/rooms/create']).toBeDefined();
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
  });
});
