import type { StandardJSONSchemaV1, StandardSchemaV1 } from './validation.js';

/**
 * A small validation library implementing Standard Schema, used by the core endpoints so Better Files needs no
 * validation dependency. Hosts and plugins may use it or any other Standard Schema library (zod, valibot, …).
 * Objects are strict: unknown keys are refused, so a typo never silently drops a security setting. Every schema
 * also describes itself as JSON Schema (Standard JSON Schema), which the OpenAPI document is built from.
 */

type Issue = StandardSchemaV1.Issue;
type Path = readonly PropertyKey[];
type JsonSchema = Record<string, unknown>;

export interface Schema<T> extends StandardSchemaV1<T, T> {
  readonly '~standard': StandardSchemaV1.Props<T, T> & {
    readonly jsonSchema: StandardJSONSchemaV1.Converter;
  };
  /** @internal */ readonly check: (value: unknown, path: Path, issues: Issue[]) => T;
  /** @internal */ readonly describe: () => JsonSchema;
  readonly optional?: boolean;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

function schema<T>(
  check: (value: unknown, path: Path, issues: Issue[]) => T,
  describe: () => JsonSchema,
  optional = false,
): Schema<T> {
  return {
    check,
    describe,
    optional,
    '~standard': {
      version: 1,
      vendor: 'better-files',
      validate(value) {
        const issues: Issue[] = [];
        const result = check(value, [], issues);
        return issues.length ? { issues } : { value: result };
      },
      jsonSchema: { input: () => describe(), output: () => describe() },
    },
  };
}

const fail = <T>(issues: Issue[], path: Path, message: string): T => {
  issues.push({ message, path: [...path] });
  return undefined as T;
};

export interface StringOptions {
  min?: number;
  max?: number;
  pattern?: RegExp;
  trim?: boolean;
}

// Control characters never belong in names, slugs, ids or free text sent to the protocol.
const controlCharacters = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export const v = {
  string(options: StringOptions = {}) {
    const { min = 0, max = 10_000, pattern, trim = false } = options;
    return schema<string>(
      (value, path, issues) => {
        if (typeof value !== 'string') return fail(issues, path, 'Expected a string');
        const text = trim ? value.trim() : value;
        if (text.length < min) return fail(issues, path, `Must be at least ${min} characters`);
        if (text.length > max) return fail(issues, path, `Must be at most ${max} characters`);
        if (controlCharacters.test(text)) return fail(issues, path, 'Contains control characters');
        if (pattern && !pattern.test(text)) return fail(issues, path, 'Has an invalid format');
        return text;
      },
      () => ({
        type: 'string',
        ...(min > 0 ? { minLength: min } : {}),
        maxLength: max,
        ...(pattern ? { pattern: pattern.source } : {}),
      }),
    );
  },
  /** An id as produced by `createId`, or any opaque identifier up to 128 characters. */
  id() {
    return v.string({ min: 1, max: 128, pattern: /^[A-Za-z0-9_.:-]+$/ });
  },
  number(options: { min?: number; max?: number; int?: boolean } = {}) {
    return schema<number>(
      (value, path, issues) => {
        if (typeof value !== 'number' || !Number.isFinite(value))
          return fail(issues, path, 'Expected a number');
        if (options.int && !Number.isInteger(value))
          return fail(issues, path, 'Expected an integer');
        if (options.min !== undefined && value < options.min)
          return fail(issues, path, `Must be at least ${options.min}`);
        if (options.max !== undefined && value > options.max)
          return fail(issues, path, `Must be at most ${options.max}`);
        return value;
      },
      () => ({
        type: options.int ? 'integer' : 'number',
        ...(options.min !== undefined ? { minimum: options.min } : {}),
        ...(options.max !== undefined ? { maximum: options.max } : {}),
      }),
    );
  },
  boolean() {
    return schema<boolean>(
      (value, path, issues) =>
        typeof value === 'boolean' ? value : fail(issues, path, 'Expected a boolean'),
      () => ({ type: 'boolean' }),
    );
  },
  literal<const L extends string | number | boolean>(literal: L) {
    return schema<L>(
      (value, path, issues) =>
        value === literal ? literal : fail(issues, path, `Expected ${JSON.stringify(literal)}`),
      () => ({ const: literal }),
    );
  },
  enum<const V extends readonly string[]>(values: V) {
    return schema<V[number]>(
      (value, path, issues) =>
        typeof value === 'string' && values.includes(value)
          ? (value as V[number])
          : fail(issues, path, `Expected one of ${values.join(', ')}`),
      () => ({ type: 'string', enum: [...values] }),
    );
  },
  array<T>(item: Schema<T>, options: { min?: number; max?: number } = {}) {
    const { min = 0, max = 1_000 } = options;
    return schema<T[]>(
      (value, path, issues) => {
        if (!Array.isArray(value)) return fail(issues, path, 'Expected an array');
        if (value.length < min) return fail(issues, path, `Must have at least ${min} items`);
        if (value.length > max) return fail(issues, path, `Must have at most ${max} items`);
        return value.map((entry, index) => item.check(entry, [...path, index], issues));
      },
      () => ({
        type: 'array',
        items: item.describe(),
        ...(min > 0 ? { minItems: min } : {}),
        maxItems: max,
      }),
    );
  },
  record<T>(item: Schema<T>, options: { maxKeys?: number; key?: RegExp } = {}) {
    const { maxKeys = 100, key = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/ } = options;
    return schema<Record<string, T>>(
      (value, path, issues) => {
        if (typeof value !== 'object' || value === null || Array.isArray(value))
          return fail(issues, path, 'Expected an object');
        const entries = Object.entries(value);
        if (entries.length > maxKeys)
          return fail(issues, path, `Must have at most ${maxKeys} keys`);
        const out: Record<string, T> = {};
        for (const [name, entry] of entries) {
          if (!key.test(name)) {
            fail(issues, [...path, name], 'Invalid key');
            continue;
          }
          out[name] = item.check(entry, [...path, name], issues);
        }
        return out;
      },
      () => ({
        type: 'object',
        propertyNames: { pattern: key.source },
        additionalProperties: item.describe(),
        maxProperties: maxKeys,
      }),
    );
  },
  object<const S extends Record<string, Schema<unknown>>>(shape: S) {
    type Required = { [K in keyof S as S[K]['optional'] extends true ? never : K]: Infer<S[K]> };
    type Optional = { [K in keyof S as S[K]['optional'] extends true ? K : never]?: Infer<S[K]> };
    type Out = { [K in keyof (Required & Optional)]: (Required & Optional)[K] };
    return schema<Out>(
      (value, path, issues) => {
        if (typeof value !== 'object' || value === null || Array.isArray(value))
          return fail(issues, path, 'Expected an object');
        const out: Record<string, unknown> = {};
        for (const name of Object.keys(value))
          if (!Object.hasOwn(shape, name)) fail(issues, [...path, name], 'Unknown field');
        for (const [name, field] of Object.entries(shape)) {
          const entry = (value as Record<string, unknown>)[name];
          if (entry === undefined) {
            if (!field.optional) fail(issues, [...path, name], 'Required');
            continue;
          }
          const checked = field.check(entry, [...path, name], issues);
          if (checked !== undefined) out[name] = checked;
        }
        return out as Out;
      },
      () => {
        const required = Object.entries(shape)
          .filter(([, field]) => !field.optional)
          .map(([name]) => name);
        return {
          type: 'object',
          properties: Object.fromEntries(
            Object.entries(shape).map(([name, field]) => [name, field.describe()]),
          ),
          ...(required.length ? { required } : {}),
          additionalProperties: false,
        };
      },
    );
  },
  optional<T>(inner: Schema<T>): Schema<T | undefined> & { readonly optional: true } {
    const wrapped = schema<T | undefined>(
      (value, path, issues) => (value === undefined ? undefined : inner.check(value, path, issues)),
      () => inner.describe(),
      true,
    );
    return wrapped as Schema<T | undefined> & { readonly optional: true };
  },
  nullable<T>(inner: Schema<T>) {
    return schema<T | null>(
      (value, path, issues) => (value === null ? null : inner.check(value, path, issues)),
      () => ({ anyOf: [inner.describe(), { type: 'null' }] }),
    );
  },
  /** Any JSON value, bounded in size, for plugin metadata. */
  json(options: { maxBytes?: number } = {}) {
    const { maxBytes = 16_384 } = options;
    return schema<unknown>(
      (value, path, issues) => {
        let text: string;
        try {
          text = JSON.stringify(value);
        } catch {
          return fail(issues, path, 'Expected JSON');
        }
        if (text === undefined) return fail(issues, path, 'Expected JSON');
        if (new TextEncoder().encode(text).byteLength > maxBytes)
          return fail(issues, path, `Must be at most ${maxBytes} bytes`);
        return JSON.parse(text) as unknown;
      },
      () => ({ description: `Any JSON value up to ${maxBytes} bytes` }),
    );
  },
};
