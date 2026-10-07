import type {
  CoreModel,
  CoreRecord,
  Credential,
  EndpointDefinition,
  Fields,
  InferFields,
  PluginContext,
  StandardSchemaV1,
} from '@better-files/core';
import type { CoreEndpoints } from './endpoints/index.js';
import type { BetterFilesOptions } from './options.js';

type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (
  value: infer I,
) => void
  ? I
  : never;
type Prettify<T> = { [K in keyof T]: T[K] } & {};
/** `{}` for an empty union instead of `unknown`. */
type Merge<U> = [U] extends [never] ? {} : UnionToIntersection<U>;

export type PluginsOf<O> = O extends { plugins: infer P extends readonly unknown[] }
  ? P[number]
  : never;

type OptionFields<O, M extends string> = O extends {
  schema: { [K in M]: { additionalFields: infer F extends Fields } };
}
  ? InferFields<F>
  : {};

type PluginFields<P, M extends string> = P extends {
  extendSchema: { [K in M]: { additionalFields: infer F extends Fields } };
}
  ? InferFields<F>
  : never;

/** A core record plus the additional fields the options and plugins declare for it. */
export type InferRecord<O, M extends CoreModel> = Prettify<
  CoreRecord<M> & OptionFields<O, M> & Merge<PluginFields<PluginsOf<O>, M>>
>;

/**
 * The server-side call for one endpoint: `(credential, { tenantId, ...input }, request?) => Promise<output>`. Pass
 * `request` when calling on behalf of an HTTP client (a server action, a controller), so its address reaches the
 * activity log and address-based rules.
 */
export type EndpointCall<E> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  E extends EndpointDefinition<infer I, infer Out, any>
    ? (
        credential: Credential,
        input: StandardSchemaV1.InferInput<I> & { tenantId: string },
        request?: { ip?: string; userAgent?: string },
      ) => Promise<Awaited<Out>>
    : never;

type GroupApi<G> = { [M in keyof G]: EndpointCall<G[M]> };

type PluginApi<P> = P extends {
  id: infer Id extends string;
  endpoints: infer E extends Record<string, unknown>;
}
  ? { [K in Id]: GroupApi<E> }
  : never;

export type CoreApi = { [G in keyof CoreEndpoints]: GroupApi<CoreEndpoints[G]> };

/** `dr.api`: the core groups plus one group per plugin with endpoints. */
export type InferApi<O> = CoreApi & Merge<PluginApi<PluginsOf<O>>>;

export interface InferTypes<O extends BetterFilesOptions> {
  Room: InferRecord<O, 'rooms'>;
  Node: InferRecord<O, 'nodes'>;
  Document: InferRecord<O, 'documents'>;
  Version: InferRecord<O, 'versions'>;
  Member: InferRecord<O, 'members'>;
  PermissionGroup: InferRecord<O, 'permissionGroups'>;
  AclEntry: InferRecord<O, 'aclEntries'>;
}

export type { PluginContext };
