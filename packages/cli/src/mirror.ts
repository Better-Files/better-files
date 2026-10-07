import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, posix, sep } from 'node:path';
import type { createBetterFilesClient, BetterFilesClientError } from '@better-files/client';

type Client = ReturnType<typeof createBetterFilesClient<{ api: object }>>;

interface SyncEntry {
  id: string;
  parentId: string | null;
  kind: 'folder' | 'document';
  name: string;
  version?: { id: string; number: number; sha256: string | null; size: number };
}
type SyncChange = { type: 'upsert'; entry: SyncEntry } | { type: 'remove'; id: string };

interface Tracked {
  id: string;
  parentId: string | null;
  kind: 'folder' | 'document';
  name: string;
  /** Relative, `/`-separated. */
  path: string;
  versionId?: string;
  /** Hash of the local copy as last written or uploaded: a different hash on disk means a local edit. */
  localSha?: string;
  /** The caller may view the document but not download it. */
  viewOnly?: boolean;
}

interface State {
  version: 1;
  baseURL: string;
  tenantId: string;
  roomId: string;
  rootNodeId?: string;
  cursor?: string;
  entries: Record<string, Tracked>;
}

export interface MirrorOptions {
  client: Client;
  /** The local folder. Sync state lives in `<dir>/.better-files/`. */
  dir: string;
  tenantId: string;
  roomId: string;
  /** Recorded in the state so a folder is not mirrored against the wrong server by mistake. */
  baseURL: string;
  log?: (message: string) => void;
  /** Download body for a ticket URL. Default: `fetch(client.fileUrl(url))`. */
  fetch?: typeof fetch;
}

export interface MirrorReport {
  downloaded: string[];
  uploaded: string[];
  removed: string[];
  moved: string[];
  conflicts: string[];
  skipped: string[];
}

const STATE_DIR = '.better-files';
const unsafe = /[<>:"/\\|?*\u0000-\u001f]/g;
const reserved = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** A file-system-safe version of a room name (Windows rules, the strictest). */
export function safeName(name: string): string {
  let out = name.replace(unsafe, '_').replace(/[. ]+$/, '');
  if (!out || out === '.' || out === '..') out = '_';
  if (reserved.test(out)) out = `_${out}`;
  return out;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const emptyReport = (): MirrorReport => ({
  downloaded: [],
  uploaded: [],
  removed: [],
  moved: [],
  conflicts: [],
  skipped: [],
});

async function exists(path: string) {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function conflictName(path: string, now: Date) {
  const stamp = now.toISOString().slice(0, 16).replace('T', ' ').replace(':', '-');
  const ext = posix.extname(path);
  return `${path.slice(0, path.length - ext.length)} (conflicted copy ${stamp})${ext}`;
}

/**
 * Mirrors one room to a local folder with the sync plugin's changes feed. Pull applies remote changes (renames and
 * moves become local renames, withdrawn access removes files) and never overwrites a local edit: the local file is
 * kept as a "conflicted copy". Push uploads new and edited files, and deletes remote files only when asked.
 */
export function createMirror(options: MirrorOptions) {
  const { client, dir } = options;
  const log = options.log ?? (() => undefined);
  const stateFile = join(dir, STATE_DIR, 'state.json');
  const abs = (path: string) => join(dir, ...path.split('/'));
  let state: State;

  async function load(): Promise<State> {
    const saved = await readFile(stateFile, 'utf8').then(
      (text) => JSON.parse(text) as State,
      () => undefined,
    );
    if (
      saved &&
      (saved.roomId !== options.roomId ||
        saved.tenantId !== options.tenantId ||
        saved.baseURL !== options.baseURL)
    )
      throw new Error(`${dir} already mirrors room ${saved.roomId} on ${saved.baseURL}`);
    state = saved ?? {
      version: 1,
      baseURL: options.baseURL,
      tenantId: options.tenantId,
      roomId: options.roomId,
      entries: {},
    };
    return state;
  }

  async function save() {
    await mkdir(join(dir, STATE_DIR), { recursive: true });
    const temporary = `${stateFile}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2));
    await rename(temporary, stateFile);
  }

  const call = <O>(path: string, input: Record<string, unknown>) =>
    client.$request<O>(path, { tenantId: options.tenantId, ...input });

  function pathFor(entry: { id: string; parentId: string | null; name: string }): string {
    const parent = entry.parentId ? state.entries[entry.parentId] : undefined;
    let path = parent ? `${parent.path}/${safeName(entry.name)}` : safeName(entry.name);
    // Two names that sanitize (or case-fold) to the same path: disambiguate the newcomer with its id.
    const clash = Object.values(state.entries).some(
      (other) => other.id !== entry.id && other.path.toLowerCase() === path.toLowerCase(),
    );
    if (clash) {
      const ext = posix.extname(path);
      path = `${path.slice(0, path.length - ext.length)} [${entry.id.slice(-6)}]${ext}`;
    }
    return path;
  }

  async function download(
    entry: SyncEntry,
    report: MirrorReport,
  ): Promise<{ bytes: Uint8Array } | undefined> {
    const attempt = async (operation: string) => {
      try {
        return await call<{ url: string }>(operation, { nodeId: entry.id });
      } catch (error) {
        if ((error as BetterFilesClientError).status === 403) return undefined;
        throw error;
      }
    };
    const ticket =
      (await attempt('documents/requestOriginal')) ?? (await attempt('documents/requestDownload'));
    if (!ticket) {
      report.skipped.push(entry.name);
      return undefined;
    }
    const response = await (options.fetch ?? fetch)(client.fileUrl(ticket.url));
    if (!response.ok) throw new Error(`Download of ${entry.name} failed with ${response.status}`);
    return { bytes: new Uint8Array(await response.arrayBuffer()) };
  }

  async function upsert(entry: SyncEntry, report: MirrorReport, now: Date) {
    const previous = state.entries[entry.id];
    const path =
      previous && previous.parentId === entry.parentId && previous.name === entry.name
        ? previous.path
        : pathFor(entry);
    if (previous && previous.path !== path && (await exists(abs(previous.path)))) {
      await mkdir(dirname(abs(path)), { recursive: true });
      await rename(abs(previous.path), abs(path));
      report.moved.push(`${previous.path} -> ${path}`);
      if (previous.kind === 'folder')
        for (const child of Object.values(state.entries))
          if (child.path.startsWith(`${previous.path}/`))
            child.path = path + child.path.slice(previous.path.length);
    }
    const tracked: Tracked = {
      ...previous,
      id: entry.id,
      parentId: entry.parentId,
      kind: entry.kind,
      name: entry.name,
      path,
    };
    state.entries[entry.id] = tracked;
    if (entry.kind === 'folder') {
      await mkdir(abs(path), { recursive: true });
      return;
    }
    if (!entry.version) return;
    // Same version: nothing to fetch. A file missing locally is a local deletion waiting to be pushed, not a gap.
    if (previous?.versionId === entry.version.id) return;
    const present = await exists(abs(path));
    if (present && previous?.localSha) {
      const local = sha256(await readFile(abs(path)));
      if (local !== previous.localSha) {
        const copy = conflictName(path, now);
        await rename(abs(path), abs(copy));
        report.conflicts.push(copy);
        log(`conflict: kept your edit of ${path} as ${copy}`);
      }
    }
    const fetched = await download(entry, report);
    if (!fetched) {
      tracked.versionId = entry.version.id;
      tracked.viewOnly = true;
      delete tracked.localSha;
      log(`skipped ${path}: view only`);
      return;
    }
    await mkdir(dirname(abs(path)), { recursive: true });
    const temporary = `${abs(path)}.${process.pid}.part`;
    await writeFile(temporary, fetched.bytes);
    await rename(temporary, abs(path));
    tracked.versionId = entry.version.id;
    tracked.localSha = sha256(fetched.bytes);
    delete tracked.viewOnly;
    report.downloaded.push(path);
  }

  async function remove(ids: readonly string[], report: MirrorReport) {
    const tracked = ids.flatMap((id) => (state.entries[id] ? [state.entries[id]!] : []));
    // Files first, then folders deepest first, so folders are empty when their turn comes.
    tracked.sort((a, b) =>
      a.kind === b.kind
        ? b.path.split('/').length - a.path.split('/').length
        : a.kind === 'document'
          ? -1
          : 1,
    );
    for (const entry of tracked) {
      delete state.entries[entry.id];
      const target = abs(entry.path);
      if (!(await exists(target))) continue;
      if (entry.kind === 'document') {
        if (entry.localSha && sha256(await readFile(target)) !== entry.localSha) {
          log(`kept ${entry.path}: it has local edits and was removed or hidden remotely`);
          continue;
        }
        await rm(target);
      } else {
        try {
          await rmdir(target);
        } catch {
          log(`kept folder ${entry.path}: it holds local files`);
          continue;
        }
      }
      report.removed.push(entry.path);
    }
  }

  async function applySnapshot(report: MirrorReport, now: Date) {
    const snapshot = await call<{ cursor: string; entries: SyncEntry[] }>('sync/snapshot', {
      roomId: options.roomId,
    });
    const seen = new Set<string>();
    for (const entry of snapshot.entries) {
      seen.add(entry.id);
      await upsert(entry, report, now);
    }
    await remove(
      Object.keys(state.entries).filter((id) => !seen.has(id)),
      report,
    );
    state.cursor = snapshot.cursor;
  }

  async function pull(): Promise<MirrorReport> {
    await load();
    const report = emptyReport();
    const now = new Date();
    state.rootNodeId ??= (
      await call<{ rootNodeId: string }>('rooms/get', { roomId: options.roomId })
    ).rootNodeId;
    if (!state.cursor) await applySnapshot(report, now);
    else
      for (let more = true; more; ) {
        const page: { reset: boolean; cursor: string; changes: SyncChange[]; hasMore: boolean } =
          await call('sync/changes', {
            roomId: options.roomId,
            cursor: state.cursor,
          });
        if (page.reset) {
          await applySnapshot(report, now);
          break;
        }
        for (const change of page.changes)
          if (change.type === 'upsert') await upsert(change.entry, report, now);
        await remove(
          page.changes.flatMap((change) => (change.type === 'remove' ? [change.id] : [])),
          report,
        );
        state.cursor = page.cursor;
        more = page.hasMore;
        await save();
      }
    await save();
    return report;
  }

  async function walk(): Promise<{ folders: string[]; files: string[] }> {
    const folders: string[] = [];
    const files: string[] = [];
    const visit = async (path: string) => {
      for (const item of await readdir(join(dir, path), { withFileTypes: true })) {
        if (!path && item.name === STATE_DIR) continue;
        if (item.name.endsWith('.part') || item.name.endsWith('.tmp')) continue;
        const child = path ? `${path}${sep}${item.name}` : item.name;
        const posixPath = child.split(sep).join('/');
        if (item.isDirectory()) {
          folders.push(posixPath);
          await visit(child);
        } else if (item.isFile()) files.push(posixPath);
      }
    };
    await visit('');
    return { folders, files };
  }

  /** Local edits since the last sync: new, modified and deleted paths. */
  async function localChanges() {
    const { folders, files } = await walk();
    const byPath = new Map(Object.values(state.entries).map((entry) => [entry.path, entry]));
    const added: string[] = [];
    const modified: string[] = [];
    for (const path of [...folders, ...files]) {
      const entry = byPath.get(path);
      if (!entry) added.push(path);
      else if (
        entry.kind === 'document' &&
        entry.localSha &&
        sha256(await readFile(abs(path))) !== entry.localSha
      )
        modified.push(path);
    }
    const present = new Set([...folders, ...files]);
    const deleted = Object.values(state.entries)
      .filter((entry) => !entry.viewOnly && !present.has(entry.path))
      .map((entry) => entry.path);
    return { added, modified, deleted, folders: new Set(folders) };
  }

  async function push(pushOptions: { delete?: boolean } = {}): Promise<MirrorReport> {
    // Pull first: remote changes land (and conflicts are set aside) before anything is uploaded over them.
    const report = await pull();
    const changes = await localChanges();
    const byPath = new Map(Object.values(state.entries).map((entry) => [entry.path, entry]));
    const parentOf = (path: string) => {
      const parent = posix.dirname(path);
      return parent === '.'
        ? { id: state.rootNodeId!, tracked: null }
        : { id: byPath.get(parent)?.id, tracked: parent };
    };

    for (const path of changes.added.sort((a, b) => a.split('/').length - b.split('/').length)) {
      const parent = parentOf(path);
      if (!parent.id) continue;
      const name = posix.basename(path);
      if (changes.folders.has(path)) {
        const folder = await call<{ id: string; name: string }>('folders/create', {
          parentId: parent.id,
          name,
        });
        const entry: Tracked = {
          id: folder.id,
          parentId: parent.tracked ? parent.id : null,
          kind: 'folder',
          name: folder.name,
          path,
        };
        state.entries[folder.id] = entry;
        byPath.set(path, entry);
      } else {
        const bytes = new Uint8Array(await readFile(abs(path)));
        const result = await client.upload({
          parentId: parent.id,
          file: bytes,
          filename: name,
          tenantId: options.tenantId,
        });
        const entry: Tracked = {
          id: result.document.id,
          parentId: parent.tracked ? parent.id : null,
          kind: 'document',
          name: result.document.name,
          path,
          versionId: result.version.id,
          localSha: sha256(bytes),
        };
        state.entries[entry.id] = entry;
        byPath.set(path, entry);
      }
      report.uploaded.push(path);
    }

    for (const path of changes.modified) {
      const entry = byPath.get(path)!;
      const bytes = new Uint8Array(await readFile(abs(path)));
      const result = await client.upload({
        documentId: entry.id,
        file: bytes,
        filename: entry.name,
        tenantId: options.tenantId,
      });
      entry.versionId = result.version.id;
      entry.localSha = sha256(bytes);
      report.uploaded.push(path);
    }

    if (pushOptions.delete) {
      const gone = changes.deleted.sort((a, b) => a.split('/').length - b.split('/').length);
      const deletedFolders: string[] = [];
      for (const path of gone) {
        if (deletedFolders.some((folder) => path.startsWith(`${folder}/`))) continue;
        const entry = byPath.get(path)!;
        await call(entry.kind === 'folder' ? 'folders/delete' : 'documents/delete', {
          nodeId: entry.id,
        });
        if (entry.kind === 'folder') deletedFolders.push(path);
        report.removed.push(path);
      }
      for (const entry of Object.values(state.entries))
        if (
          gone.includes(entry.path) ||
          deletedFolders.some((folder) => entry.path.startsWith(`${folder}/`))
        )
          delete state.entries[entry.id];
    }
    await save();
    return report;
  }

  async function status() {
    await load();
    const local = state.cursor ? await localChanges() : { added: [], modified: [], deleted: [] };
    let remote: number | 'resync' = 0;
    if (state.cursor) {
      const page = await call<{ reset: boolean; changes: unknown[]; hasMore: boolean }>(
        'sync/changes',
        {
          roomId: options.roomId,
          cursor: state.cursor,
        },
      );
      remote = page.reset ? 'resync' : page.changes.length;
    }
    return {
      synced: !!state.cursor,
      local: { added: local.added, modified: local.modified, deleted: local.deleted },
      remote,
    };
  }

  return { pull, push, status };
}

export type Mirror = ReturnType<typeof createMirror>;
