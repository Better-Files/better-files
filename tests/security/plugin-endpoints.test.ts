/**
 * Security matrix fuzzing over every first-party plugin endpoint. Inputs are generated from each endpoint's JSON
 * Schema, with id-like fields pointing at the scenario's room, folders, documents, group and member. For each
 * authenticated endpoint, every actor the published model denies (core plus the plugin's `accessModel`, and the
 * matrix for node targets) must be refused with FORBIDDEN or NOT_FOUND, or get the endpoint's `denied()` fallback,
 * and the refusal must change nothing. A t2 credential addressing t1 must always be refused.
 *
 * Endpoints whose generated input does not validate are reported; the suite requires most of them to be exercised.
 */
import { describe, expect, it } from 'vitest';
import { toJsonSchema, type BetterFilesPlugin, type EndpointDefinition } from '@better-files/core';
import { analyticsPlugin } from '@better-files/plugin-analytics';
import { annotationsPlugin } from '@better-files/plugin-annotations';
import { auditPlugin } from '@better-files/plugin-audit';
import { esignPlugin } from '@better-files/plugin-esign';
import { guardPlugin } from '@better-files/plugin-guard';
import { inboundPlugin } from '@better-files/plugin-inbound';
import { linksPlugin } from '@better-files/plugin-links';
import { ndaPlugin } from '@better-files/plugin-nda';
import { notificationsPlugin } from '@better-files/plugin-notifications';
import { processingPlugin } from '@better-files/plugin-processing';
import { qaPlugin } from '@better-files/plugin-qa';
import { quotasPlugin } from '@better-files/plugin-quotas';
import { redactionPlugin } from '@better-files/plugin-redaction';
import { retentionPlugin } from '@better-files/plugin-retention';
import { searchPlugin } from '@better-files/plugin-search';
import { syncPlugin } from '@better-files/plugin-sync';
import { tasksPlugin } from '@better-files/plugin-tasks';
import { templatesPlugin } from '@better-files/plugin-templates';
import { watermarkPlugin } from '@better-files/plugin-watermark';
import { webhooksPlugin } from '@better-files/plugin-webhooks';
import { viewerPlugin } from '@better-files/viewer/server';
import {
  actors,
  as,
  DENIED,
  DENIED_CROSSING,
  expectedAllowed,
  invoke,
  malloryInT1,
  scenario,
  snapshot,
  T1,
  type Ids,
} from './harness.js';

/** Each plugin with the minimal configuration it needs, and the plugins it depends on. */
const suites: { id: string; plugins: () => BetterFilesPlugin[] }[] = [
  { id: 'analytics', plugins: () => [analyticsPlugin()] },
  { id: 'annotations', plugins: () => [annotationsPlugin()] },
  { id: 'audit', plugins: () => [auditPlugin()] },
  { id: 'esign', plugins: () => [esignPlugin({ deliver: async () => undefined })] },
  { id: 'guard', plugins: () => [guardPlugin()] },
  {
    id: 'inbound',
    plugins: () => [inboundPlugin({ domain: 'drop.acme.test', deliverySecret: 'x'.repeat(40) })],
  },
  { id: 'links', plugins: () => [linksPlugin()] },
  { id: 'nda', plugins: () => [ndaPlugin()] },
  {
    id: 'notifications',
    plugins: () => [
      notificationsPlugin({
        mailer: { send: async () => undefined },
        roomUrl: ({ roomId }) => `https://app.test/rooms/${roomId}`,
      }),
    ],
  },
  { id: 'processing', plugins: () => [processingPlugin()] },
  { id: 'qa', plugins: () => [qaPlugin()] },
  { id: 'quotas', plugins: () => [quotasPlugin()] },
  { id: 'redaction', plugins: () => [redactionPlugin()] },
  { id: 'retention', plugins: () => [retentionPlugin()] },
  { id: 'search', plugins: () => [searchPlugin()] },
  { id: 'sync', plugins: () => [syncPlugin()] },
  { id: 'tasks', plugins: () => [tasksPlugin()] },
  { id: 'templates', plugins: () => [templatesPlugin()] },
  { id: 'viewer', plugins: () => [viewerPlugin()] },
  { id: 'watermark', plugins: () => [watermarkPlugin()] },
  { id: 'webhooks', plugins: () => [webhooksPlugin()] },
];

type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  minItems?: number;
  enum?: unknown[];
  const?: unknown;
  anyOf?: Schema[];
  oneOf?: Schema[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
};

/** Values for fields that name scenario records. */
function hints(ids: Ids): Record<string, unknown> {
  return {
    roomId: ids.roomId,
    nodeId: ids.documentId,
    documentId: ids.documentId,
    folderId: ids.folderId,
    parentId: ids.folderId,
    destinationId: ids.legalId,
    targetId: ids.documentId,
    versionId: ids.firstVersionId,
    groupId: ids.groupId,
    memberId: ids.memberId,
    identityId: 'vic',
    identityIds: ['vic'],
    nodeIds: [ids.documentId],
    documentIds: [ids.documentId],
    groupIds: [ids.groupId],
    email: 'nina@acme.test',
    // An address literal (TEST-NET-3), so nothing resolves DNS.
    url: 'https://203.0.113.10/better-files',
  };
}

/** A minimal value that satisfies `schema`, preferring scenario ids for fields named after them. */
function generate(schema: Schema, name: string, ids: Ids): unknown {
  const hinted = hints(ids)[name];
  if (hinted !== undefined) return hinted;
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum[0];
  const choices = schema.anyOf ?? schema.oneOf;
  if (choices) {
    const usable = choices.find((choice) => choice.type !== 'null') ?? choices[0]!;
    return generate(usable, name, ids);
  }
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const key of schema.required ?? [])
        out[key] = generate(schema.properties?.[key] ?? {}, key, ids);
      return out;
    }
    case 'array':
      return Array.from({ length: schema.minItems ?? 0 }, () =>
        generate(schema.items ?? {}, name.replace(/s$/, ''), ids),
      );
    case 'integer':
    case 'number': {
      const low = schema.minimum ?? (schema.exclusiveMinimum ?? 0) + 1;
      return Math.min(Math.max(low, 1), schema.maximum ?? Number.MAX_SAFE_INTEGER);
    }
    case 'boolean':
      return false;
    case 'string': {
      if (schema.format === 'email' || /email/i.test(name)) return 'nina@acme.test';
      if (schema.format === 'uri' || /url$/i.test(name)) return 'https://203.0.113.10/x';
      if (/Id$/.test(name)) return 'missing_000000000000';
      const length = Math.max(schema.minLength ?? 1, 1);
      return 'a'.repeat(Math.min(length, schema.maxLength ?? length));
    }
    default:
      return {};
  }
}

const endpointsOf = (plugin: BetterFilesPlugin) =>
  Object.entries(plugin.endpoints ?? {}) as [string, EndpointDefinition][];

describe('security: plugin endpoints × actors', () => {
  const exercised: string[] = [];
  const unvalidated: string[] = [];

  it.each(suites)('$id refuses everyone the model denies', async ({ id, plugins }) => {
    const installed = plugins();
    const problems: string[] = [];
    for (const plugin of installed)
      for (const [name, definition] of endpointsOf(plugin)) {
        const spec = definition.operation;
        if (spec.target === 'public') continue;
        const operation = `${plugin.id}.${name}`;
        const context = await scenario(installed);
        const schema = (toJsonSchema(definition.input) ?? {}) as Schema;
        const input = generate(schema, '', context.ids) as Record<string, unknown>;
        const required = (() => {
          try {
            return context.dr.capabilities.mask(spec.capabilities ?? []);
          } catch {
            return ~0;
          }
        })();
        const denied = actors.filter(
          (actor) =>
            !expectedAllowed(spec, actor, {
              model: context.model,
              mask: (preset) => (preset ? context.dr.capabilities.preset(preset) : 0),
              required,
            }),
        );
        const before = await snapshot(context);
        const fallback = definition.denied ? JSON.stringify(definition.denied()) : undefined;
        let validated = false;
        for (const actor of [...denied, malloryInT1]) {
          const outcome = await invoke(context.dr, operation, actor, input);
          const who = `${operation} as ${actor.token}@${actor.tenantId}`;
          if (outcome.ok) {
            validated = true;
            if (JSON.stringify(outcome.value) !== fallback)
              problems.push(`${who}: allowed, the model denies`);
          } else if (outcome.code === 'INVALID_INPUT') {
            // Validation runs before authorization and reveals nothing; the endpoint is just not exercised.
          } else {
            validated = true;
            const acceptable = actor === malloryInT1 ? DENIED_CROSSING : DENIED;
            if (!acceptable.has(outcome.code))
              problems.push(`${who}: refused with ${outcome.code} (${outcome.message})`);
          }
          if ((await snapshot(context)) !== before) {
            problems.push(`${who}: a refused call changed state`);
            break;
          }
        }
        (validated ? exercised : unvalidated).push(operation);
      }
    expect(problems, id).toEqual([]);
  });

  it.each(suites)('$id changes nothing in a closed room', async ({ plugins }) => {
    const installed = plugins();
    const changed: string[] = [];
    for (const plugin of installed)
      for (const [name, definition] of endpointsOf(plugin)) {
        const spec = definition.operation;
        if (spec.target !== 'room' && spec.target !== 'node') continue;
        if (spec.allowClosed) continue;
        const context = await scenario(installed);
        await context.dr.api.rooms.close(as('alice'), { tenantId: T1, roomId: context.ids.roomId });
        const input = generate(
          (toJsonSchema(definition.input) ?? {}) as Schema,
          '',
          context.ids,
        ) as Record<string, unknown>;
        const before = await snapshot(context, { content: true });
        const outcome = await invoke(context.dr, `${plugin.id}.${name}`, actors[0]!, input);
        if ((await snapshot(context, { content: true })) !== before)
          changed.push(`${plugin.id}.${name} (${outcome.ok ? 'ok' : outcome.code})`);
      }
    expect(changed).toEqual([]);
  });

  it('exercises most plugin endpoints', () => {
    const ratio = exercised.length / Math.max(1, exercised.length + unvalidated.length);
    expect({ ratio: ratio >= 0.75, unvalidated }).toMatchObject({ ratio: true });
  });
});
