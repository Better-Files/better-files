import { BetterFilesError, type Credential } from '@better-files/core';
import {
  bindApi,
  requireCapabilities,
  type BoundApi,
  type CapabilityRequirement,
  type BetterFilesLike,
} from '@better-files/middleware';

export type { BoundApi } from '@better-files/middleware';

type RouteHandler = (request: Request) => Promise<Response>;
type HeaderSource = Headers | HeadersInit | Promise<Headers>;

/**
 * The part of `createIamNext(iam)` (from `better-iam/next`) Better Files uses: the current request's credential and
 * session. Structural, so any compatible release fits.
 */
export interface IamNextLike {
  credential(headers?: HeaderSource): Promise<{ headers?: HeadersInit; token?: string }>;
  getSession(headers?: HeaderSource): Promise<unknown>;
}

/** `dr.api` with the credential and the session's tenant applied: `api.rooms.index({ roomId })`. */
export type TenantApi<Api> = {
  [G in keyof Api]: {
    [M in keyof Api[G]]: Api[G][M] extends (
      credential: Credential,
      input: infer I,
    ) => Promise<infer O>
      ? I extends { tenantId: string }
        ? (input: Omit<I, 'tenantId'> & { tenantId?: string }) => Promise<O>
        : (input: I) => Promise<O>
      : never;
  };
};

export interface BetterFilesRequestContext<Api> {
  /** The tenant the session acts in (for an assumed role, the role's tenant). */
  tenantId: string;
  identityId: string;
  credential: Credential;
  /** Bound to the credential; inputs take `tenantId` explicitly. */
  api: BoundApi<Api>;
  /** Bound to the credential and the session's tenant; `tenantId` may be left out. */
  tenant: TenantApi<Api>;
}

export interface BetterFilesNextOptions {
  /**
   * The host's `createIamNext(iam)`. With it, `request()` and the `headers`-less forms read the current request
   * through Better IAM (Next's `headers()` and `cookies()`), and the tenant comes from the session.
   */
  iamNext?: IamNextLike;
}

/** `{ identity, session }` from Better IAM's `getSession`, or nothing usable. */
function sessionScope(session: unknown): { tenantId: string; identityId: string } | undefined {
  const value = session as
    | { identity?: { id?: unknown }; session?: { tenantId?: unknown } }
    | null
    | undefined;
  const tenantId = value?.session?.tenantId;
  const identityId = value?.identity?.id;
  return typeof tenantId === 'string' && typeof identityId === 'string'
    ? { tenantId, identityId }
    : undefined;
}

function withTenant<Api>(api: BoundApi<Api>, tenantId: string): TenantApi<Api> {
  return new Proxy({} as TenantApi<Api>, {
    get(_, group: string) {
      const target = (api as Record<string, Record<string, (input: unknown) => Promise<unknown>>>)[
        group
      ];
      if (!target) return undefined;
      return new Proxy(
        {},
        {
          get(__, method: string) {
            const call = target[method];
            return call
              ? (input: Record<string, unknown> = {}) => call({ tenantId, ...input })
              : undefined;
          },
        },
      );
    },
  });
}

/**
 * Next.js App Router integration, without importing Next itself:
 *
 * ```ts
 * // app/api/better-files/[...path]/route.ts
 * export const { GET, HEAD, POST, PUT, OPTIONS } = drNext.handlers();
 *
 * // a server component or server action, with `createBetterFilesNext(dr, { iamNext })`
 * const { tenant } = await drNext.request();
 * const index = await tenant.rooms.index({ roomId });
 *
 * // without Better IAM's Next helpers, pass the headers
 * const api = drNext.api(await headers());
 * ```
 */
export function createBetterFilesNext<D extends BetterFilesLike>(
  dr: D,
  options: BetterFilesNextOptions = {},
) {
  const handle: RouteHandler = (request) => dr.handler(request);
  const iamNext = options.iamNext;

  async function credentialOf(headers?: Headers | HeadersInit): Promise<Credential> {
    if (headers !== undefined) return { headers };
    if (!iamNext)
      throw new BetterFilesError(
        'INVALID_CONFIG',
        'Pass the request headers, or createBetterFilesNext(dr, { iamNext }) to read them through Better IAM',
      );
    const credential = await iamNext.credential();
    return {
      ...(credential.headers === undefined ? {} : { headers: credential.headers }),
      ...(credential.token === undefined ? {} : { token: credential.token }),
    };
  }

  /**
   * The signed-in person's Better Files context: their credential, the tenant their Better IAM session acts in, and the
   * API bound to both. Returns null when the request has no usable session, so pages can redirect to sign-in.
   */
  async function session(
    headers?: Headers | HeadersInit,
  ): Promise<BetterFilesRequestContext<D['api']> | null> {
    if (!iamNext)
      throw new BetterFilesError(
        'INVALID_CONFIG',
        'request() needs createBetterFilesNext(dr, { iamNext: createIamNext(iam) })',
      );
    const scope = sessionScope(await iamNext.getSession(headers));
    if (!scope) return null;
    const credential = await credentialOf(headers);
    const api = bindApi(dr, credential);
    return { ...scope, credential, api, tenant: withTenant(api, scope.tenantId) };
  }

  return {
    /** Route handlers for `app/api/better-files/[...path]/route.ts` (set `export const runtime = 'nodejs'`). */
    handlers(): Record<'GET' | 'HEAD' | 'POST' | 'PUT' | 'OPTIONS', RouteHandler> {
      return { GET: handle, HEAD: handle, POST: handle, PUT: handle, OPTIONS: handle };
    },
    /** `dr.api` bound to the request's cookies (pass `await headers()` from `next/headers`). */
    api(headers: Headers | HeadersInit): BoundApi<D['api']> {
      const credential: Credential = { headers };
      return bindApi(dr, credential);
    },
    session,
    /** As `session()`, but throws UNAUTHENTICATED instead of returning null. */
    async request(headers?: Headers | HeadersInit): Promise<BetterFilesRequestContext<D['api']>> {
      const context = await session(headers);
      if (!context) throw new BetterFilesError('UNAUTHENTICATED', 'Sign in to continue');
      return context;
    },
    /**
     * Guards a page or action on the permission matrix. Returns the held capabilities, or `null` when the node is
     * hidden or missing so the page can call Next's `notFound()`; throws FORBIDDEN when it is visible but not allowed.
     * With `iamNext`, the headers and `tenantId` may be left out (the tenant then comes from the session).
     */
    async capabilities(
      headers: Headers | HeadersInit | undefined,
      requirement: Omit<CapabilityRequirement, 'tenantId'> & { tenantId?: string },
    ): Promise<string[] | null> {
      let tenantId = requirement.tenantId;
      if (tenantId === undefined) {
        const scope = iamNext ? sessionScope(await iamNext.getSession(headers)) : undefined;
        if (!scope) {
          if (!iamNext)
            throw new BetterFilesError(
              'INVALID_CONFIG',
              'Pass tenantId, or createBetterFilesNext(dr, { iamNext }) to take it from the session',
            );
          throw new BetterFilesError('UNAUTHENTICATED', 'Sign in to continue');
        }
        tenantId = scope.tenantId;
      }
      try {
        return await requireCapabilities(dr, await credentialOf(headers), {
          ...requirement,
          tenantId,
        });
      } catch (error) {
        if (error instanceof BetterFilesError && error.code === 'NOT_FOUND') return null;
        throw error;
      }
    },
  };
}

export type BetterFilesNext<D extends BetterFilesLike> = ReturnType<
  typeof createBetterFilesNext<D>
>;
