import {
  BetterFilesError,
  defineJob,
  definePlugin,
  type BetterFilesEvent,
  type DocumentVersion,
  type MaintenanceContext,
  type PluginContext,
} from '@better-files/core';

/** What Better Files meters, and the Better IAM meter key each goes to by default. */
export const defaultMeters = {
  /** Bytes stored by uploads and new versions (`sum`, unit `byte`). */
  uploadBytes: 'better-files.upload-bytes',
  /** Bytes served by single-file downloads, originals and watermarked copies (`sum`, unit `byte`). */
  downloadBytes: 'better-files.download-bytes',
  /** Files downloaded, folder ZIPs counted per file (`sum`, unit `file`). */
  downloads: 'better-files.downloads',
  /** Documents opened in the viewer (`sum`, unit `view`). */
  views: 'better-files.views',
  /** Rooms created (`sum`, unit `room`). */
  rooms: 'better-files.rooms',
  /** People and agents who viewed or downloaded anything in the period (`unique`, unit `participant`). */
  participants: 'better-files.participants',
} as const;
export type MeterName = keyof typeof defaultMeters;

/** Meter definitions for Better IAM's `billing.createMeter` (keys as configured). */
export function meteringMeters(
  meters: Partial<Record<MeterName, string | false>> = {},
): { key: string; name: string; unit: string; aggregation: 'sum' | 'unique' }[] {
  const definitions: Record<MeterName, { name: string; unit: string; unique?: true }> = {
    uploadBytes: { name: 'Data room storage uploaded', unit: 'byte' },
    downloadBytes: { name: 'Data room download egress', unit: 'byte' },
    downloads: { name: 'Data room files downloaded', unit: 'file' },
    views: { name: 'Data room document views', unit: 'view' },
    rooms: { name: 'Data rooms created', unit: 'room' },
    participants: { name: 'Active data room participants', unit: 'participant', unique: true },
  };
  return (Object.keys(definitions) as MeterName[]).flatMap((name) => {
    const key = meters[name] === undefined ? defaultMeters[name] : meters[name];
    if (key === false) return [];
    const { unique, ...rest } = definitions[name];
    return [{ key, ...rest, aggregation: unique ? ('unique' as const) : ('sum' as const) }];
  });
}

interface UsageEvent {
  tenantId: string;
  meter: string;
  quantity?: number;
  identityId?: string;
  tags?: Record<string, string>;
  occurredAt?: number;
  idempotencyKey?: string;
}

interface QuotaDecisionLike {
  allowed: boolean;
  plan: string | null;
  reason?: string;
  retryAfterMs?: number;
}

/** The parts of a `betterIam()` instance metering uses: its trusted, credential-free billing and quota runtimes. */
export interface BetterIamMeteringInstance {
  billing: {
    recordMany(events: UsageEvent[]): Promise<unknown>;
    check(input: { tenantId: string; identityId?: string; meter?: string }): Promise<{
      allowed: boolean;
      blockedBy?: { name?: string };
    }>;
  };
  quotas: {
    consumeFor(input: {
      tenantId: string;
      identityId: string;
      meter: string;
      cost?: number;
    }): Promise<QuotaDecisionLike>;
  };
}

export interface BetterIamMeteringOptions {
  /** Better IAM meter keys, or `false` to stop recording one. Defaults in `defaultMeters`. */
  meters?: Partial<Record<MeterName, string | false>>;
  /** Labels on every usage event, for spend reports (`roomId` is always added). At most 9. */
  tags?: (event: BetterFilesEvent) => Record<string, string> | undefined;
  /** Who used it. Default: the event's actor, unless it is the system. */
  identityOf?: (event: BetterFilesEvent) => string | undefined;
  /**
   * Refuse uploads, downloads and views from people whose usage is over an enforced Better IAM budget
   * (`billing.check`), with `QUOTA_EXCEEDED`. Default false.
   */
  enforceBudgets?: boolean;
  /**
   * Better IAM quota meters counted per person before each action (`quotas.consumeFor`); a refused one stops it with
   * `RATE_LIMITED` and `retryAfterMs`. Define plans for these meters in Better IAM (e.g. 500 downloads a day for
   * guests); people no plan covers are unlimited. Folder ZIPs count each file.
   */
  quotas?: { upload?: string; download?: string; view?: string };
  /**
   * When Better IAM cannot be reached for a check: `open` (default) lets the action through and logs, `closed`
   * refuses it.
   */
  onCheckError?: 'open' | 'closed';
  /**
   * `job` (default): each event's usage is recorded by a durable `metering.record` job, retried while Better IAM is
   * unreachable. `inline`: recorded as the event is delivered, and lost if Better IAM is down at that moment.
   */
  delivery?: 'job' | 'inline';
}

const metered = new Set([
  'room.created',
  'document.uploaded',
  'version.created',
  'document.downloaded',
  'document.viewed',
  'folder.downloaded',
]);

/**
 * Meters Better Files usage in Better IAM billing and enforces Better IAM budgets and quotas. Usage is recorded after
 * each change commits (from published events, idempotent per event), so refused or rolled-back actions are never
 * billed; storage and egress are recorded in bytes, tagged with the room for chargeback.
 *
 * ```ts
 * betterFiles({ …, plugins: [betterIamMetering(iam, { enforceBudgets: true, quotas: { download: 'better-files.downloads' } })] });
 * ```
 *
 * Create the meters once with `meteringMeters()` (`iam.api.billing.createMeter` per definition).
 */
export function betterIamMetering(
  iam: BetterIamMeteringInstance,
  options: BetterIamMeteringOptions = {},
) {
  const meter = (name: MeterName): string | undefined => {
    const configured = options.meters?.[name];
    return configured === false ? undefined : (configured ?? defaultMeters[name]);
  };
  const identityOf =
    options.identityOf ??
    ((event: BetterFilesEvent) => (event.actorId === 'system' ? undefined : event.actorId));

  async function versionSize(context: MaintenanceContext, event: BetterFilesEvent) {
    const versionId = event.data.versionId;
    if (typeof versionId !== 'string') return 0;
    const version = await context.db.findOne<DocumentVersion>('versions', {
      id: versionId,
      tenantId: event.tenantId,
    });
    return version?.size ?? 0;
  }

  /** The usage one event stands for, as `[meter name, quantity]` pairs. */
  async function usageOf(
    event: BetterFilesEvent,
    context: MaintenanceContext,
  ): Promise<[MeterName, number][]> {
    switch (event.type) {
      case 'room.created':
        return [['rooms', 1]];
      case 'document.uploaded':
      case 'version.created':
        return [['uploadBytes', await versionSize(context, event)]];
      case 'document.downloaded':
        return [
          ['downloads', 1],
          ['downloadBytes', await versionSize(context, event)],
          ['participants', 1],
        ];
      case 'document.viewed':
        return [
          ['views', 1],
          ['participants', 1],
        ];
      case 'folder.downloaded': {
        const files = Number(event.data.files);
        return Number.isFinite(files) && files > 0
          ? [
              ['downloads', files],
              ['participants', 1],
            ]
          : [];
      }
      default:
        return [];
    }
  }

  async function record(event: BetterFilesEvent, context: MaintenanceContext) {
    const usage = (await usageOf(event, context)).flatMap(([name, quantity]) => {
      const key = meter(name);
      return key && quantity > 0 ? [{ name, key, quantity }] : [];
    });
    if (usage.length === 0) return;
    const identityId = identityOf(event);
    const tags = {
      ...options.tags?.(event),
      ...(event.roomId ? { roomId: event.roomId } : {}),
    };
    const events = (withIdentity: boolean): UsageEvent[] =>
      usage
        // `unique` meters count people, so they need one.
        .filter((item) => withIdentity || item.name !== 'participants')
        .map((item) => ({
          tenantId: event.tenantId,
          meter: item.key,
          quantity: item.quantity,
          ...(withIdentity && identityId ? { identityId } : {}),
          ...(Object.keys(tags).length ? { tags } : {}),
          occurredAt: Math.min(event.occurredAt, Date.now()),
          // Retries of the same event (and of this fallback) record nothing twice.
          idempotencyKey: `better-files:${event.id}:${item.name}${withIdentity ? '' : ':anonymous'}`,
        }));
    try {
      await iam.billing.recordMany(events(identityId !== undefined));
    } catch (error) {
      // An actor Better IAM does not know (a share-link visitor): bill the tenant without attributing a person.
      const code = (error as { code?: unknown })?.code;
      if (identityId === undefined || (code !== 'NOT_FOUND' && code !== 'INVALID_INPUT'))
        throw error;
      const anonymous = events(false);
      if (anonymous.length) await iam.billing.recordMany(anonymous);
    }
  }

  async function guarded<T>(
    context: PluginContext,
    check: () => Promise<T>,
  ): Promise<T | undefined> {
    try {
      return await check();
    } catch (error) {
      if (options.onCheckError === 'closed')
        throw new BetterFilesError(
          'RATE_LIMITED',
          'Usage limits cannot be checked right now; try again later',
          {
            details: { reason: 'unavailable' },
            cause: error,
          },
        );
      context.logger.warn('Better IAM usage check failed; allowing the action', {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  async function enforce(context: PluginContext, roomId: string, quotaMeter: string | undefined) {
    const identityId = context.principal.id;
    if (options.enforceBudgets) {
      const spend = await guarded(context, () =>
        iam.billing.check({ tenantId: context.tenantId, identityId }),
      );
      if (spend && !spend.allowed) {
        context.emit(
          'quota.exceeded',
          { roomId, scope: 'budget', budget: spend.blockedBy?.name ?? null },
          { immediate: true },
        );
        throw new BetterFilesError('QUOTA_EXCEEDED', 'Your organization’s usage budget is spent', {
          details: {
            scope: 'budget',
            ...(spend.blockedBy?.name ? { budget: spend.blockedBy.name } : {}),
          },
        });
      }
    }
    if (quotaMeter) {
      const decision = await guarded(context, () =>
        iam.quotas.consumeFor({ tenantId: context.tenantId, identityId, meter: quotaMeter }),
      );
      if (decision && !decision.allowed)
        throw new BetterFilesError('RATE_LIMITED', 'Usage limit reached; try again later', {
          details: {
            scope: 'quota',
            meter: quotaMeter,
            ...(decision.plan ? { plan: decision.plan } : {}),
            ...(decision.reason ? { reason: decision.reason } : {}),
            ...(decision.retryAfterMs !== undefined ? { retryAfterMs: decision.retryAfterMs } : {}),
          },
        });
    }
  }

  return definePlugin({
    id: 'metering',
    hooks: {
      async beforeUpload({ context, room }) {
        await enforce(context, room.id, options.quotas?.upload);
      },
      async beforeDownload({ context, room, variant }) {
        await enforce(
          context,
          room.id,
          variant === 'view' ? options.quotas?.view : options.quotas?.download,
        );
      },
    },
    jobs: {
      // Retried with backoff while Better IAM is unreachable; idempotency keys make repeats harmless.
      record: defineJob<{ event: BetterFilesEvent }>({
        maxAttempts: 10,
        handler: (payload, context) => record(payload.event, context),
      }),
    },
    async onEvent(event, context) {
      if (!metered.has(event.type)) return;
      if (options.delivery === 'inline') return record(event, context);
      await context.enqueue(event.tenantId, 'metering.record', { event }, { key: event.id });
    },
  });
}
