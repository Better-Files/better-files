import { invalidInput } from './errors.js';

/**
 * The Standard Schema interface (https://standardschema.dev), copied as the spec intends. Zod, Valibot, ArkType and
 * others implement it, so endpoint inputs accept any of them without Better Files depending on one.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1.Props<Input, Output>;
}

export declare namespace StandardSchemaV1 {
  interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>;
    readonly types?: Types<Input, Output> | undefined;
  }
  type Result<Output> = SuccessResult<Output> | FailureResult;
  interface SuccessResult<Output> {
    readonly value: Output;
    readonly issues?: undefined;
  }
  interface FailureResult {
    readonly issues: ReadonlyArray<Issue>;
  }
  interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }
  interface PathSegment {
    readonly key: PropertyKey;
  }
  interface Types<Input = unknown, Output = Input> {
    readonly input: Input;
    readonly output: Output;
  }
  type InferInput<Schema extends StandardSchemaV1> = NonNullable<
    Schema['~standard']['types']
  >['input'];
  type InferOutput<Schema extends StandardSchemaV1> = NonNullable<
    Schema['~standard']['types']
  >['output'];
}

/**
 * The Standard JSON Schema extension (https://standardschema.dev/json-schema): a schema that can describe itself as
 * JSON Schema. Better Files' `v` implements it, as do recent zod, valibot and arktype releases; the OpenAPI document is
 * built from it.
 */
export interface StandardJSONSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1.Props<Input, Output> & {
    readonly jsonSchema: StandardJSONSchemaV1.Converter;
  };
}

export declare namespace StandardJSONSchemaV1 {
  type Target = 'draft-2020-12' | 'draft-07' | 'openapi-3.0' | (string & {});
  interface Options {
    readonly target: Target;
    readonly libraryOptions?: Record<string, unknown> | undefined;
  }
  interface Converter {
    readonly input: (options: Options) => Record<string, unknown>;
    readonly output: (options: Options) => Record<string, unknown>;
  }
}

/** The JSON Schema of a Standard Schema's input, when its library can describe it. */
export function toJsonSchema(
  schema: StandardSchemaV1,
  target: StandardJSONSchemaV1.Target = 'draft-2020-12',
): Record<string, unknown> | undefined {
  const converter = (schema['~standard'] as Partial<StandardJSONSchemaV1['~standard']>).jsonSchema;
  if (!converter) return undefined;
  try {
    return converter.input({ target });
  } catch {
    return undefined;
  }
}

const issuePath = (issue: StandardSchemaV1.Issue) =>
  (issue.path ?? [])
    .map((segment) => String(typeof segment === 'object' ? segment.key : segment))
    .join('.');

/** Validates with any Standard Schema and throws INVALID_INPUT listing the issues. */
export async function validateInput<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
): Promise<StandardSchemaV1.InferOutput<S>> {
  const result = await schema['~standard'].validate(value);
  if (result.issues)
    throw invalidInput('Invalid input', {
      issues: result.issues.map((issue) => ({ path: issuePath(issue), message: issue.message })),
    });
  return result.value as StandardSchemaV1.InferOutput<S>;
}
