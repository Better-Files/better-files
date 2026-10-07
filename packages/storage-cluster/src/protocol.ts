/**
 * The storage cluster's wire contract, shared by the control plane and the node agent.
 *
 * - **Node identity.** A node joins once with a single-use join token and receives its node secret. The control
 *   plane never stores node secrets: it derives them from the cluster secret, the node id and a generation, so
 *   rotating a node is a generation bump.
 * - **Control (node → control plane, outbound only).** Join and heartbeats go to the Better Files protocol
 *   (`storage.join`, `storage.heartbeat`); heartbeats are signed with the node secret and carry command results;
 *   responses carry commands. Nodes never need to be reachable for control, only for data.
 * - **Data (control plane or browser → node).** Every data request carries a short-lived token the control plane
 *   signed with that node's secret, naming the node, the operation and the object. Nodes only ever hold
 *   ciphertext: Better Files encrypts before storage.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export type DataOperation =
  | 'put'
  | 'get'
  | 'delete'
  | 'verify'
  | 'part'
  | 'complete'
  | 'abort'
  | 'inventory'
  | 'stats';

export interface DataToken {
  /** Node id the token is for. */
  n: string;
  o: DataOperation;
  /** Object key. */
  k?: string;
  /** Multipart upload id. */
  u?: string;
  /** Part number. */
  p?: number;
  /** Largest body accepted, in bytes. */
  m?: number;
  /** Expiry, epoch milliseconds. */
  e: number;
}

export interface NodeStats {
  capacityBytes: number;
  usedBytes: number;
  freeBytes: number;
  objects: number;
}

export type NodeCommand = { id: string; type: 'delete'; key: string };
export interface CommandResult {
  id: string;
  ok: boolean;
  error?: string;
}

export interface HeartbeatBody {
  stats: NodeStats;
  results: CommandResult[];
  version: string;
}

/** Object keys the cluster accepts: Better Files storage keys, never path tricks. */
export const keyPattern = /^[A-Za-z0-9][A-Za-z0-9/_.=-]{0,1023}$/;
export const isValidKey = (key: string) => keyPattern.test(key) && !key.split('/').includes('..');

const b64 = (bytes: Buffer | Uint8Array) => Buffer.from(bytes).toString('base64url');

/** The node secret for `nodeId` at `generation`. */
export function deriveNodeSecret(
  clusterSecret: string,
  nodeId: string,
  generation: number,
): string {
  return b64(
    createHmac('sha256', clusterSecret)
      .update(`better-files-storage-node:${nodeId}:${generation}`)
      .digest(),
  );
}

export function signToken(secret: string, token: DataToken): string {
  const payload = b64(Buffer.from(JSON.stringify(token)));
  return `${payload}.${b64(createHmac('sha256', secret).update(payload).digest())}`;
}

/** The token's claims when the signature and expiry hold, else undefined. */
export function verifyToken(
  secret: string,
  value: string,
  now = Date.now(),
): DataToken | undefined {
  const [payload, signature, extra] = value.split('.');
  if (!payload || !signature || extra !== undefined) return undefined;
  const expected = createHmac('sha256', secret).update(payload).digest();
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  try {
    const token = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as DataToken;
    return typeof token.e === 'number' && token.e > now ? token : undefined;
  } catch {
    return undefined;
  }
}

/** Heartbeat signature over the exact body string, so both sides hash identical bytes. */
export function signHeartbeat(
  secret: string,
  nodeId: string,
  timestamp: number,
  body: string,
): string {
  return b64(
    createHmac('sha256', secret).update(`heartbeat\n${nodeId}\n${timestamp}\n${body}`).digest(),
  );
}

export function verifyHeartbeat(
  secret: string,
  nodeId: string,
  timestamp: number,
  body: string,
  signature: string,
): boolean {
  const expected = Buffer.from(signHeartbeat(secret, nodeId, timestamp, body), 'base64url');
  const given = Buffer.from(signature, 'base64url');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export const sha256Hex = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');

/** Where a node keeps an object: a hash of the key, so keys never become paths. */
export const objectName = (key: string) => sha256Hex(key);

/** Node HTTP routes, relative to the node's advertised URL. */
export const routes = {
  object: (key: string) => `/o/${encodeURIComponent(key)}`,
  verify: (key: string) => `/o/${encodeURIComponent(key)}/verify`,
  part: (uploadId: string, part: number) => `/u/${encodeURIComponent(uploadId)}/${part}`,
  complete: (uploadId: string) => `/u/${encodeURIComponent(uploadId)}/complete`,
  upload: (uploadId: string) => `/u/${encodeURIComponent(uploadId)}`,
  inventory: '/inventory',
  stats: '/stats',
  health: '/health',
};

export const AGENT_VERSION = '0.1.0';
