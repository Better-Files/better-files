import {
  BetterFilesError,
  type CapabilityRegistry,
  type Clock,
  type DatabaseAdapter,
  type BetterFilesHooks,
  type BetterFilesPlugin,
  type DirectoryCall,
  type IamDirectory,
  type IamIntegration,
  type KeyProvider,
  type Logger,
  type PluginContext,
  type ResolvedSchema,
  type SecurityAuditEvent,
  type StorageAdapter,
} from '@better-files/core';
import { tokenSigner } from '@better-files/crypto';
import type { AccessEngine } from './access.js';
import type { EventBus } from './events.js';
import type { Files } from './files.js';
import type { JobsInternal } from './jobs.js';
import type { BetterFilesOptions } from './options.js';

export interface EngineLimits {
  /** Largest file accepted, in bytes. Default 5 GiB. */
  maxFileSize: number;
  /** Most files in one folder download. Default 5000. */
  maxBundleFiles: number;
  /** Plaintext bytes per upload part; a multiple of the 64 KiB encryption segment. Default 8 MiB. */
  partSize: number;
  /** How long an upload session stays open. Default 24 hours. */
  uploadTtlMs: number;
  /** How long a download or viewer ticket is valid. Default 60 seconds. */
  ticketTtlMs: number;
  /** How many requests one ticket may serve (range requests, resumed downloads). Default 5. */
  ticketUses: number;
}

export interface Engine {
  options: BetterFilesOptions;
  schema: ResolvedSchema;
  db: DatabaseAdapter;
  storage: StorageAdapter;
  iam: IamIntegration;
  keys: KeyProvider | undefined;
  capabilities: CapabilityRegistry;
  access: AccessEngine;
  clock: Clock;
  logger: Logger;
  hooks: readonly BetterFilesHooks[];
  plugins: readonly BetterFilesPlugin[];
  events: EventBus;
  files: Files;
  jobs: JobsInternal;
  tickets: ReturnType<typeof tokenSigner>;
  basePath: string;
  limits: EngineLimits;
  /** Every core and plugin endpoint, by group and method (for `context.call`). */
  operations: Record<string, Record<string, import('./pipeline.js').AnyEndpoint>>;
}

/** The context core endpoints receive: the plugin context plus the engine. */
export interface CoreContext extends PluginContext {
  engine: Engine;
  /** The same context on another adapter: handlers with manual transactions pass their `tx` here. */
  rebind(db: DatabaseAdapter): CoreContext;
}

/** The identity-system directory, bound to the caller; UNSUPPORTED when the integration has none. */
export function directory(context: CoreContext): {
  [K in keyof IamDirectory]-?: (
    input: Parameters<NonNullable<IamDirectory[K]>>[1],
  ) => ReturnType<NonNullable<IamDirectory[K]>>;
} {
  const target = context.engine.iam.directory;
  if (!target)
    throw new BetterFilesError(
      'UNSUPPORTED',
      'This operation needs an identity integration with a directory (betterIamIntegration(iam, { directory }))',
    );
  const call: DirectoryCall = {
    tenantId: context.tenantId,
    credential: context.credential,
    actorId: context.principal.id,
  };
  return new Proxy({} as never, {
    get: (_, name: string) => (input: unknown) =>
      (target[name as keyof IamDirectory] as (call: DirectoryCall, input: unknown) => unknown).call(
        target,
        call,
        input,
      ),
  });
}

/** Records a security-relevant event in the identity system's audit log once the operation commits. */
export function auditSecurity(
  context: CoreContext,
  event: Omit<SecurityAuditEvent, 'tenantId' | 'actorId' | 'outcome'> & {
    outcome?: 'allow' | 'deny';
  },
) {
  const sink = context.engine.iam.audit;
  if (!sink) return;
  context.afterCommit(() =>
    sink.record({
      tenantId: context.tenantId,
      actorId: context.principal.id,
      outcome: event.outcome ?? 'allow',
      action: event.action,
      resource: event.resource,
      ...(event.metadata ? { metadata: event.metadata } : {}),
    }),
  );
}

/** Refuses to destroy content a hook retains (legal holds, retention rules). */
export async function assertNotRetained(
  engine: Pick<Engine, 'hooks'>,
  db: DatabaseAdapter,
  input: { tenantId: string; roomId: string; nodeIds?: readonly string[] },
) {
  for (const hooks of engine.hooks) {
    const reason = await hooks.retains?.({ db, ...input });
    if (reason) throw new BetterFilesError('LEGAL_HOLD', reason);
  }
}

export const defaultLimits: EngineLimits = {
  maxFileSize: 5 * 1024 ** 3,
  maxBundleFiles: 5000,
  partSize: 8 * 1024 * 1024,
  uploadTtlMs: 24 * 60 * 60 * 1000,
  ticketTtlMs: 60 * 1000,
  ticketUses: 5,
};
