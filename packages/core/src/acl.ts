import { Capability } from './capabilities.js';
import type { DatabaseAdapter } from './ports.js';
import type { DataRoomNode, NodeClosure } from './tables.js';

export type SubjectType = 'identity' | 'group' | 'link';
/** `identity:{id}`, `group:{iamGroupId}` or `link:{linkId}`. */
export type SubjectKey = `${SubjectType}:${string}`;

export const subjectKey = (type: SubjectType, id: string): SubjectKey => `${type}:${id}`;

/** One cell of the permission matrix: a subject's mask on a folder or document. */
export interface AccessEntry {
  nodeId: string;
  subject: SubjectKey;
  mask: number;
  /** A locked entry is final for its whole subtree: deeper entries for the same subject are ignored. */
  locked?: boolean;
  /** Epoch milliseconds; entries at or past this time are ignored. */
  expiresAt?: number;
}

export interface ResolveAccessInput {
  /** Node ids from the room's root folder down to the target node, inclusive. */
  path: readonly string[];
  /** Entries on any node of the path; entries elsewhere are ignored. */
  entries: readonly AccessEntry[];
  /** Every subject the principal acts as. */
  subjects: readonly SubjectKey[];
  now: number;
  /**
   * Listing requires LIST on every ancestor (default true): a hidden folder hides its subtree for that principal even
   * when a deeper entry grants access. Set false to reveal breadcrumbs through hidden folders.
   */
  requireAncestorList?: boolean;
}

type Cells = Map<string, { mask: number; locked: boolean }>;

/** One subject's live cells by node id. */
function subjectCells(
  entries: readonly AccessEntry[],
  subject: SubjectKey,
  now: number,
): Cells | undefined {
  let byNode: Cells | undefined;
  for (const entry of entries) {
    if (entry.subject !== subject) continue;
    if (entry.expiresAt !== undefined && entry.expiresAt <= now) continue;
    byNode ??= new Map();
    const current = byNode.get(entry.nodeId);
    // Duplicate cells for one subject on one node should not exist (the store enforces uniqueness); union if they do.
    byNode.set(entry.nodeId, {
      mask: (current?.mask ?? 0) | entry.mask,
      locked: (current?.locked ?? false) || entry.locked === true,
    });
  }
  return byNode;
}

/**
 * Unions one subject's mask at each depth of the path into `result`. Per subject, the nearest explicit entry wins,
 * unless an ancestor entry is locked: the shallowest locked entry is final for everything below it.
 */
function addSubjectMasks(cells: Cells, path: readonly string[], result: number[]): void {
  let inherited = 0;
  for (let depth = 0; depth < path.length; depth++) {
    const cell = cells.get(path[depth]!);
    if (cell) {
      inherited = cell.mask;
      if (cell.locked) {
        for (let rest = depth; rest < path.length; rest++) result[rest]! |= inherited;
        return;
      }
    }
    result[depth]! |= inherited;
  }
}

function finish(masks: readonly number[], requireAncestorList: boolean | undefined): number {
  if (masks.length === 0) return 0;
  if (requireAncestorList !== false)
    for (let depth = 0; depth < masks.length - 1; depth++)
      if ((masks[depth]! & Capability.LIST) === 0) return 0;
  return masks[masks.length - 1]!;
}

/** The mask held at every depth of the path, unioned across subjects, before the ancestor-LIST rule. */
export function resolvePathMasks(input: ResolveAccessInput): number[] {
  return createAccessIndex(input).pathMasks(input.path);
}

/**
 * The reference implementation of effective access. The access engine resolves many nodes at once through
 * {@link createAccessIndex}, which gives the same answer (property tests check this on generated trees).
 */
export function resolveAccess(input: ResolveAccessInput): number {
  if (input.path.length === 0) return 0;
  return finish(resolvePathMasks(input), input.requireAncestorList);
}

/** A principal's entries prepared once, for resolving many paths in the same room. */
export interface AccessIndex {
  /** Like {@link resolvePathMasks} for this path. */
  pathMasks(path: readonly string[]): number[];
  /** Like {@link resolveAccess} for this path. */
  resolve(path: readonly string[], options?: { requireAncestorList?: boolean }): number;
}

/**
 * Groups the entries by subject and node once, so resolving a path costs O(subjects × depth) instead of a scan of
 * every entry. Use it when listing a folder or checking many documents for one principal.
 */
export function createAccessIndex(
  input: Pick<ResolveAccessInput, 'entries' | 'subjects' | 'now'>,
): AccessIndex {
  const cells: Cells[] = [];
  for (const subject of new Set(input.subjects)) {
    const subjectEntries = subjectCells(input.entries, subject, input.now);
    if (subjectEntries) cells.push(subjectEntries);
  }
  const pathMasks = (path: readonly string[]): number[] => {
    const result = path.map(() => 0);
    for (const subject of cells) addSubjectMasks(subject, path, result);
    return result;
  };
  return {
    pathMasks,
    resolve: (path, options) => finish(pathMasks(path), options?.requireAncestorList),
  };
}

/**
 * Root-to-node paths (inclusive) for nodes of one tenant, from the closure table. Siblings share their parent's
 * chain, so only the distinct parents' chains are loaded: listing a folder of 500 items reads the folder's few
 * closure rows, not 500 chains. A node whose chain is missing gets no path, which resolves to no access.
 */
export async function loadNodePaths(
  db: DatabaseAdapter,
  tenantId: string,
  nodes: readonly Pick<DataRoomNode, 'id' | 'parentId'>[],
): Promise<Map<string, string[]>> {
  const chainIds = [...new Set(nodes.map((node) => node.parentId ?? node.id))];
  const closure = chainIds.length
    ? await db.findMany<NodeClosure>('nodeClosure', {
        where: { tenantId, descendantId: { in: chainIds } },
      })
    : [];
  const rowsOf = new Map<string, NodeClosure[]>();
  for (const row of closure) {
    const rows = rowsOf.get(row.descendantId);
    if (rows) rows.push(row);
    else rowsOf.set(row.descendantId, [row]);
  }
  const chains = new Map<string, string[]>();
  for (const [id, rows] of rowsOf)
    chains.set(
      id,
      rows.sort((a, b) => b.depth - a.depth).map((row) => row.ancestorId),
    );
  const paths = new Map<string, string[]>();
  for (const node of nodes) {
    const chain = chains.get(node.parentId ?? node.id);
    if (chain) paths.set(node.id, node.parentId ? [...chain, node.id] : chain);
  }
  return paths;
}

/** Bits removed by document flags, room settings and plugins after resolution. */
export interface AccessClamp {
  remove: number;
  reason: string;
}

export function applyClamps(mask: number, clamps: readonly AccessClamp[]): number {
  let result = mask;
  for (const clamp of clamps) result &= ~clamp.remove;
  return result;
}

/** A manager may grant at most what they hold themselves on that node. */
export const exceedsCeiling = (granted: number, granterMask: number): boolean =>
  (granted & ~granterMask) !== 0;
