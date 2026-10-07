import type {
  CapabilityDefinition,
  Clock,
  CoreModel,
  DatabaseAdapter,
  BetterFilesHooks,
  BetterFilesPlugin,
  IamIntegration,
  KeyProvider,
  Logger,
  StorageAdapter,
  TableCustomization,
} from '@better-files/core';
import type { EngineLimits } from './engine.js';
import type { JobsOptions } from './jobs.js';

export type SchemaOptions = { tablePrefix?: string } & { [M in CoreModel]?: TableCustomization };

export interface BetterFilesOptions {
  /** Identity and authorization: `betterIamIntegration(iam)` from `better-files/iam`. */
  iam: IamIntegration;
  database: DatabaseAdapter;
  storage: StorageAdapter;
  /** At least 32 characters: signs download tickets. Keep it secret and stable across restarts. */
  secret: string;
  /**
   * How stored files are encrypted. Pass a key provider (`localKeyProvider`, `betterIamKeys`, a cloud KMS), or
   * `false` to store files unencrypted (development only). Defaults to the identity integration's key provider.
   */
  encryption?: { keys: KeyProvider } | false;
  /** Where the HTTP protocol is mounted. Default `/api/better-files`. */
  basePath?: string;
  /** Table prefix, table renames and typed additional fields on core tables. */
  schema?: SchemaOptions;
  capabilities?: {
    /** Extra capabilities, from bit 16 upward. */
    extensions?: Record<string, CapabilityDefinition>;
    /** Named masks shown in permission UIs, in addition to the built-in presets. */
    presets?: Record<string, readonly string[]>;
  };
  plugins?: readonly BetterFilesPlugin[];
  /** Application hooks; same shape as plugin hooks, run after every plugin's. */
  hooks?: BetterFilesHooks;
  /** Origins allowed to send cookie-bearing requests. The request's own origin is always allowed. */
  trustedOrigins?: readonly string[];
  /** Use `X-Forwarded-For` as the client address (only behind a proxy you control). */
  trustProxy?: boolean;
  /** Largest JSON body the protocol accepts. Default 64 KiB, the same as Better IAM. */
  maxJsonBodyBytes?: number;
  limits?: Partial<EngineLimits>;
  /** Where durable background jobs run: in this process (default), when the host asks, or on the host's queue. */
  jobs?: JobsOptions;
  clock?: Clock;
  logger?: Logger;
}
