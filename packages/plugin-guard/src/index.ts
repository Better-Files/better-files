import {
  BetterFilesError,
  definePlugin,
  type Credential,
  type PluginContext,
  type Principal,
  type Room,
} from '@better-files/core';

export interface DownloadAnomaly {
  tenantId: string;
  roomId: string;
  principalId: string;
  /** `user`, `service` or `agent`; identity-system responses apply to identities only. */
  principalKind: Principal['kind'];
  email?: string;
  ip?: string;
  /** The identity-system session the downloads came from, when known. */
  sessionId?: string;
  /** Downloads (and views, when counted) in the window, including the refused one. */
  count: number;
  windowMs: number;
  limit: number;
}

/** Risk levels as Better IAM's threat detection reports them (`principal.riskLevel`). */
export type RiskLevel = 'none' | 'low' | 'medium' | 'high';
const riskOrder: Record<RiskLevel, number> = { none: 0, low: 1, medium: 2, high: 3 };

export interface RiskGate {
  /** Refuse downloads and views from people at this risk level or above. Default `high`. */
  level?: Exclude<RiskLevel, 'none'>;
  /** The principal's current risk level, e.g. from Better IAM's `threats.getRisk` (see `betterIamThreats`). */
  lookup(input: { tenantId: string; principalId: string }): Promise<RiskLevel>;
}

export interface GuardOptions {
  /** Downloads one person may make in one room per window. Default 100. */
  maxDownloads?: number;
  /** Default 10 minutes. */
  windowMs?: number;
  /** Count viewer opens as well. Default false. */
  countViews?: boolean;
  /** Relations exempt from the limit (checked against the room roster). Default owners and admins. */
  exempt?: readonly string[];
  /**
   * Called once per window when someone crosses the limit: raise their risk in Better IAM (`betterIamThreats`),
   * suspend the member, page security. Errors are logged, never shown to the caller.
   */
  onAnomaly?: (anomaly: DownloadAnomaly, context: PluginContext) => Promise<void> | void;
  /**
   * Refuse every download and view from people the identity system considers risky, in every room and whatever
   * their role. A failed lookup is logged and fails open, so an identity-system outage does not close every room.
   */
  risk?: RiskGate;
}

/**
 * Download rate limits with anomaly reporting: people who bulk-download a room are stopped at the limit and a
 * `security.download-anomaly` event is emitted. Counts come from the room's activity log, so they hold across
 * servers and restarts. With `risk`, people the identity system flags are refused outright.
 */
export function guardPlugin(options: GuardOptions = {}) {
  const limit = options.maxDownloads ?? 100;
  const windowMs = options.windowMs ?? 10 * 60_000;
  const exempt = new Set(options.exempt ?? ['owner', 'admin']);
  const actions = ['document.downloaded', ...(options.countViews ? ['document.viewed'] : [])];
  const reported = new Map<string, number>();
  const riskLevel = options.risk?.level ?? 'high';

  async function isExempt(context: PluginContext, room: Room) {
    const member = await context.db.findOne<{ relation?: string }>('members', {
      tenantId: context.tenantId,
      roomId: room.id,
      identityId: context.principal.id,
    });
    return member?.relation !== undefined && exempt.has(member.relation);
  }

  const admitted = new WeakMap<PluginContext, Map<string, number>>();
  const recent = (context: PluginContext, room: Room) => ({
    tenantId: context.tenantId,
    roomId: room.id,
    actorId: context.principal.id,
    createdAt: { gt: context.now - windowMs },
  });

  /** Single downloads (and views) in the window, plus every file of the folder ZIPs taken in it. */
  async function countInWindow(context: PluginContext, room: Room) {
    const single = await context.db.count('activity', {
      ...recent(context, room),
      action: { in: actions },
    });
    const bundles = await context.db.findMany<{
      metadata?: { files?: unknown; variant?: unknown };
    }>('activity', { where: { ...recent(context, room), action: 'folder.downloaded' } });
    let files = 0;
    for (const bundle of bundles) {
      if (bundle.metadata?.variant === 'view' && !options.countViews) continue;
      const n = Number(bundle.metadata?.files);
      if (Number.isFinite(n) && n > 0) files += n;
    }
    return single + files;
  }

  /** Report once per window across servers too: an anomaly already in the room's log counts as reported. */
  async function reportedInWindow(context: PluginContext, room: Room) {
    return (
      (await context.db.count('activity', {
        ...recent(context, room),
        action: 'security.download-anomaly',
      })) > 0
    );
  }

  async function checkRisk(context: PluginContext) {
    if (!options.risk) return;
    let level: RiskLevel;
    try {
      level = await options.risk.lookup({
        tenantId: context.tenantId,
        principalId: context.principal.id,
      });
    } catch (error) {
      context.logger.warn('Risk lookup failed; allowing the download', {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (riskOrder[level] < riskOrder[riskLevel]) return;
    throw new BetterFilesError(
      'FORBIDDEN',
      'Downloads are suspended while this account is under security review',
      { details: { reason: 'risk', riskLevel: level } },
    );
  }

  return definePlugin({
    id: 'guard',
    hooks: {
      async beforeDownload({ context, room, variant }) {
        await checkRisk(context);
        if (variant === 'view' && !options.countViews) return;
        if (await isExempt(context, room)) return;
        // One request can admit several files (folder ZIPs call this hook per file), so count them as they pass.
        let tally = admitted.get(context);
        if (!tally) admitted.set(context, (tally = new Map()));
        const inRequest = tally.get(room.id) ?? 0;
        const count = (await countInWindow(context, room)) + inRequest + 1;
        if (count <= limit) {
          tally.set(room.id, inRequest + 1);
          return;
        }
        const key = `${context.tenantId}:${room.id}:${context.principal.id}`;
        if ((reported.get(key) ?? 0) < context.now && !(await reportedInWindow(context, room))) {
          for (const [stale, until] of reported) if (until < context.now) reported.delete(stale);
          reported.set(key, context.now + windowMs);
          const anomaly: DownloadAnomaly = {
            tenantId: context.tenantId,
            roomId: room.id,
            principalId: context.principal.id,
            principalKind: context.principal.kind,
            ...(context.principal.email ? { email: context.principal.email } : {}),
            ...(context.request?.ip ? { ip: context.request.ip } : {}),
            ...(context.principal.sessionId ? { sessionId: context.principal.sessionId } : {}),
            count,
            windowMs,
            limit,
          };
          // The download is refused below, which discards queued effects: report directly instead.
          await context.activity({
            roomId: room.id,
            action: 'security.download-anomaly',
            metadata: { count, limit, windowMs },
          });
          context.emit('security.download-anomaly', { ...anomaly }, { immediate: true });
          try {
            await options.onAnomaly?.(anomaly, context);
          } catch (error) {
            context.logger.error('Download anomaly handler failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        throw new BetterFilesError(
          'RATE_LIMITED',
          'Too many downloads from this room; try again later',
          {
            details: { limit, windowMs },
          },
        );
      },
    },
  });
}

/** Better IAM's response actions (`threats.respond`). */
export type ThreatResponseAction =
  | { kind: 'revoke-sessions'; keepApiKeys?: boolean }
  | { kind: 'forget-devices' }
  | { kind: 'contain' }
  | { kind: 'block-network'; durationMs?: number }
  | { kind: 'notify' };

type IamCredential = { headers?: Headers | HeadersInit; token?: string };
/** Method-style, so the real Better IAM API (with its richer types) fits structurally. */
type Call<I, O> = {
  bivarianceHack(credential: IamCredential, input: I): Promise<O>;
}['bivarianceHack'];

/** The part of a `betterIam()` instance `betterIamThreats` uses (Better IAM 0.2 or later). */
export interface BetterIamThreatsInstance {
  api: {
    threats: {
      setRisk: Call<
        {
          tenantId: string;
          identityId: string;
          level: RiskLevel;
          reason: string;
          expiresInMs?: number;
        },
        unknown
      >;
      respond: Call<
        {
          tenantId: string;
          identityId?: string;
          network?: string;
          actions: ThreatResponseAction[];
          reason: string;
        },
        unknown
      >;
      getRisk: Call<{ tenantId: string; identityId: string }, { level: RiskLevel }>;
    };
  };
}

export interface BetterIamThreatsOptions {
  /**
   * The credential for Better IAM's threat API, per tenant: a service account API key whose role grants
   * `iam:threats:read` and `iam:threats:respond` on `iam/*` (see `threatsPolicy()`).
   */
  credential: (tenantId: string) => Credential | Promise<Credential>;
  /**
   * The risk floor set on someone who crosses the limit, which Better IAM policies read as `principal.riskLevel`
   * and which `risk` below enforces in every room. Default `high`; `false` leaves the risk unchanged.
   */
  raiseRisk?: Exclude<RiskLevel, 'none'> | false;
  /** How long the raised floor holds: one hour to 90 days. Default 24 hours. */
  riskExpiresInMs?: number;
  /**
   * Actions `threats.respond` runs on the identity, in order: e.g. `[{ kind: 'revoke-sessions' }, { kind: 'notify' }]`
   * ends their sessions and emails the tenant's security contacts. `block-network` blocks the request's address.
   * Default none.
   */
  actions?: ThreatResponseAction[];
  /** Refuse downloads from people at this level or above (`false` disables the gate). Default `high`. */
  blockAt?: Exclude<RiskLevel, 'none'> | false;
  /** How long a risk lookup is reused, per tenant and person. Default 30 seconds. */
  cacheMs?: number;
}

const toIam = (credential: Credential): IamCredential => ({
  ...(credential.headers === undefined ? {} : { headers: credential.headers }),
  ...(credential.token === undefined ? {} : { token: credential.token }),
});

/**
 * Connects the guard to Better IAM's threat detection and response: someone who bulk-downloads gets a raised risk
 * level (and optional responses such as ending their sessions), and people Better IAM considers risky, for this or
 * any other reason (password spraying, session hijack, a "this wasn't me" report), cannot download from any room.
 *
 * ```ts
 * guardPlugin({
 *   maxDownloads: 50,
 *   ...betterIamThreats(iam, { credential: (tenantId) => ({ token: securityKeys[tenantId] }), actions: [{ kind: 'notify' }] }),
 * });
 * ```
 */
export function betterIamThreats(
  iam: BetterIamThreatsInstance,
  options: BetterIamThreatsOptions,
): Pick<GuardOptions, 'onAnomaly' | 'risk'> {
  const raise = options.raiseRisk ?? 'high';
  const cacheMs = options.cacheMs ?? 30_000;
  const cache = new Map<string, { level: RiskLevel; until: number }>();
  const threats = () => iam.api.threats;
  const credential = async (tenantId: string) => toIam(await options.credential(tenantId));

  async function onAnomaly(anomaly: DownloadAnomaly) {
    // Only identities have a risk score; link visitors and other synthetic principals are left to the event.
    if (anomaly.principalKind !== 'user' && anomaly.principalKind !== 'agent') return;
    const reason = `Better Files: ${anomaly.count} downloads from room ${anomaly.roomId} within ${Math.round(anomaly.windowMs / 60_000)} min (limit ${anomaly.limit})`;
    const as = await credential(anomaly.tenantId);
    if (raise) {
      await threats().setRisk(as, {
        tenantId: anomaly.tenantId,
        identityId: anomaly.principalId,
        level: raise,
        reason,
        expiresInMs: options.riskExpiresInMs ?? 24 * 3_600_000,
      });
      cache.set(`${anomaly.tenantId}:${anomaly.principalId}`, {
        level: raise,
        until: Date.now() + cacheMs,
      });
    }
    const identityActions = (options.actions ?? []).filter((a) => a.kind !== 'block-network');
    if (identityActions.length > 0)
      await threats().respond(as, {
        tenantId: anomaly.tenantId,
        identityId: anomaly.principalId,
        actions: identityActions,
        reason,
      });
    const block = (options.actions ?? []).find((a) => a.kind === 'block-network');
    if (block && anomaly.ip)
      await threats().respond(as, {
        tenantId: anomaly.tenantId,
        network: anomaly.ip,
        actions: [block],
        reason,
      });
  }

  const blockAt = options.blockAt ?? 'high';
  return {
    onAnomaly,
    ...(blockAt === false
      ? {}
      : {
          risk: {
            level: blockAt,
            async lookup({ tenantId, principalId }) {
              const key = `${tenantId}:${principalId}`;
              const cached = cache.get(key);
              if (cached && cached.until > Date.now()) return cached.level;
              const { level } = await threats().getRisk(await credential(tenantId), {
                tenantId,
                identityId: principalId,
              });
              cache.set(key, { level, until: Date.now() + cacheMs });
              if (cache.size > 10_000) cache.delete(cache.keys().next().value!);
              return level;
            },
          } satisfies RiskGate,
        }),
  };
}

/** The Better IAM policy for the service account behind `betterIamThreats({ credential })`. */
export function threatsPolicy() {
  return {
    version: 1 as const,
    statements: [
      {
        sid: 'BetterFilesThreats',
        effect: 'allow' as const,
        actions: ['iam:threats:read', 'iam:threats:respond'],
        resources: ['iam/*'],
      },
    ],
  };
}
