import type { IncomingHttpHeaders } from 'node:http';
import { BetterFilesError, type Credential } from '@better-files/core';

/** The parts of a `betterFiles()` instance the framework helpers use. */
export interface BetterFilesLike {
  api: object;
  handler(request: Request, info?: { ip?: string }): Promise<Response>;
  nodeHandler(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ): Promise<void>;
  capabilitiesFor(
    credential: Credential,
    input: { tenantId: string; roomId: string; nodeIds: readonly string[] },
  ): Promise<Record<string, string[]>>;
  /** `basePath` is read from here (default `/api/better-files`). */
  options: object;
}

/** `dr.api` with the credential already applied: `api.rooms.list({ tenantId })`. */
export type BoundApi<Api> = {
  [G in keyof Api]: {
    [M in keyof Api[G]]: Api[G][M] extends (
      credential: Credential,
      input: infer I,
    ) => Promise<infer O>
      ? (input: I) => Promise<O>
      : never;
  };
};

export function bindApi<D extends BetterFilesLike>(
  dr: D,
  credential: Credential,
): BoundApi<D['api']> {
  return new Proxy({} as BoundApi<D['api']>, {
    get(_, group: string) {
      const target = (
        dr.api as Record<string, Record<string, (c: Credential, i: unknown) => Promise<unknown>>>
      )[group];
      if (!target) return undefined;
      return new Proxy(
        {},
        {
          get(__, method: string) {
            const call = target[method];
            return call ? (input: unknown) => call(credential, input) : undefined;
          },
        },
      );
    },
  });
}

/** Node request headers as fetch `Headers`, the credential shape Better IAM reads cookies and bearer tokens from. */
export function toHeaders(
  headers: IncomingHttpHeaders | Headers | Record<string, string | string[] | undefined>,
): Headers {
  if (headers instanceof Headers) return headers;
  const out = new Headers();
  for (const [key, value] of Object.entries(headers))
    if (Array.isArray(value)) for (const entry of value) out.append(key, entry);
    else if (value !== undefined) out.set(key, String(value));
  return out;
}

export interface CapabilityRequirement {
  tenantId: string;
  roomId: string;
  nodeId: string;
  /** Every one of these must be held (`VIEW`, `DOWNLOAD_ORIGINAL`, …). */
  capabilities: readonly string[];
}

/**
 * Checks the permission matrix for a host route (layer A). The protected Better Files operations still check both
 * layers themselves; use this to gate the host's own pages and handlers around a node.
 */
export async function requireCapabilities(
  dr: BetterFilesLike,
  credential: Credential,
  requirement: CapabilityRequirement,
) {
  const held = await dr.capabilitiesFor(credential, {
    tenantId: requirement.tenantId,
    roomId: requirement.roomId,
    nodeIds: [requirement.nodeId],
  });
  const names = held[requirement.nodeId];
  if (!names || !names.includes('LIST')) throw new BetterFilesError('NOT_FOUND', 'Node not found');
  for (const capability of requirement.capabilities)
    if (!names.includes(capability)) throw new BetterFilesError('FORBIDDEN', 'Access denied');
  return names;
}

/** The status and JSON body for any error, in the protocol's envelope. */
export function errorResponse(error: unknown): {
  status: number;
  body: { error: { code: string; message: string } };
} {
  if (error instanceof BetterFilesError)
    return { status: error.status, body: { error: { code: error.code, message: error.message } } };
  const shaped = error as { status?: unknown; code?: unknown; message?: unknown };
  if (typeof shaped?.status === 'number' && typeof shaped.code === 'string' && shaped.status < 500)
    return {
      status: shaped.status,
      body: { error: { code: shaped.code, message: String(shaped.message ?? shaped.code) } },
    };
  return { status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'Internal error' } } };
}

export const basePathOf = (dr: BetterFilesLike) =>
  ((dr.options as { basePath?: string }).basePath ?? '/api/better-files').replace(/\/+$/, '');
