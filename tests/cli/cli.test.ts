import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main, safeName } from '@better-files/cli';
import { syncPlugin } from '@better-files/plugin-sync';
import { as, fixture, TENANT } from '../fixtures.js';

const text = (value: string) => new TextEncoder().encode(value);
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup() {
  const f = await fixture({ plugins: [syncPlugin()] });
  const room = await f.room();
  const dir = await mkdtemp(join(tmpdir(), 'better-files-sync-'));
  dirs.push(dir);
  const lines: string[] = [];
  const run = (who: string, ...args: string[]) =>
    main(
      [
        'sync',
        ...args,
        '--dir',
        dir,
        '--url',
        'http://app.test/api/better-files',
        '--tenant',
        TENANT,
        '--room',
        room.id,
        '--token',
        who,
      ],
      {
        out: (line) => lines.push(line),
        err: (line) => lines.push(line),
        env: {},
        cwd: dir,
        fetch: (input, init) => f.dr.handler(new Request(input, init)),
      },
    );
  const tree = async (path = ''): Promise<string[]> => {
    const out: string[] = [];
    for (const item of await readdir(join(dir, path), { withFileTypes: true })) {
      if (item.name === '.better-files') continue;
      const child = path ? `${path}/${item.name}` : item.name;
      out.push(item.isDirectory() ? `${child}/` : child);
      if (item.isDirectory()) out.push(...(await tree(child)));
    }
    return out.sort();
  };
  const read = (path: string) => readFile(join(dir, ...path.split('/')), 'utf8');
  return { f, room, dir, run, lines, tree, read };
}

describe('better-files sync', () => {
  it('mirrors a room, follows renames, and keeps local edits as conflicted copies', async () => {
    const { f, room, dir, run, lines, tree, read } = await setup();
    const legal = await f.dr.api.folders.create(as('alice'), {
      tenantId: TENANT,
      parentId: room.rootNodeId,
      name: 'Legal',
    });
    const { document } = await f.upload('alice', {
      parentId: legal.id,
      filename: 'spa.txt',
      content: text('draft 1'),
    });
    await f.upload('alice', {
      parentId: room.rootNodeId,
      filename: 'Q3: plan?.md',
      content: text('# plan'),
    });

    expect(await run('alice', 'pull')).toBe(0);
    expect(await tree()).toEqual(['Legal/', 'Legal/spa.txt', 'Q3_ plan_.md']);
    expect(await read('Legal/spa.txt')).toBe('draft 1');
    expect(lines.at(-1)).toBe('2 changes');

    // Remote rename and new version.
    await f.dr.api.folders.rename(as('alice'), {
      tenantId: TENANT,
      nodeId: legal.id,
      name: 'Legal & Tax',
    });
    await f.upload('alice', {
      documentId: document.id,
      filename: 'spa.txt',
      content: text('draft 2'),
    });
    expect(await run('alice', 'pull')).toBe(0);
    expect(await tree()).toEqual(['Legal & Tax/', 'Legal & Tax/spa.txt', 'Q3_ plan_.md']);
    expect(await read('Legal & Tax/spa.txt')).toBe('draft 2');

    // Both sides edit: the remote version wins the name, the local edit is kept beside it and pushed.
    await writeFile(join(dir, 'Legal & Tax', 'spa.txt'), 'my local edit');
    await f.upload('alice', {
      documentId: document.id,
      filename: 'spa.txt',
      content: text('draft 3'),
    });
    lines.length = 0;
    expect(await run('alice', 'push')).toBe(0);
    const files = await tree();
    const conflict = files.find((path) => path.includes('conflicted copy'))!;
    expect(conflict).toMatch(
      /^Legal & Tax\/spa \(conflicted copy \d{4}-\d{2}-\d{2} \d{2}-\d{2}\)\.txt$/,
    );
    expect(await read('Legal & Tax/spa.txt')).toBe('draft 3');
    expect(await read(conflict)).toBe('my local edit');
    const index = await f.dr.api.rooms.index(as('alice'), { tenantId: TENANT, roomId: room.id });
    expect(index.map((n) => n.name)).toContain(conflict.split('/')[1]);
  });

  it('pushes new folders, files and edits, and deletes only with --delete', async () => {
    const { f, room, dir, run, tree } = await setup();
    expect(await run('alice', 'pull')).toBe(0);
    await import('node:fs/promises').then((fs) =>
      fs.mkdir(join(dir, 'Finance', 'Q3'), { recursive: true }),
    );
    await writeFile(join(dir, 'Finance', 'Q3', 'model.csv'), 'a,b\n1,2');
    await writeFile(join(dir, 'readme.md'), '# Room');
    expect(await run('alice', 'push')).toBe(0);
    let index = await f.dr.api.rooms.index(as('alice'), { tenantId: TENANT, roomId: room.id });
    expect(index.map((n) => [n.index, n.name])).toEqual([
      ['1', 'Finance'],
      ['1.1', 'Q3'],
      ['1.1.1', 'model.csv'],
      ['2', 'readme.md'],
    ]);

    await writeFile(join(dir, 'readme.md'), '# Room v2');
    expect(await run('alice', 'push')).toBe(0);
    const readme = index.find((n) => n.name === 'readme.md')!;
    const versions = await f.dr.api.versions.list(as('alice'), {
      tenantId: TENANT,
      nodeId: readme.id,
    });
    expect(versions).toHaveLength(2);

    await rm(join(dir, 'Finance'), { recursive: true });
    expect(await run('alice', 'push')).toBe(0);
    expect(
      (await f.dr.api.rooms.index(as('alice'), { tenantId: TENANT, roomId: room.id })).map(
        (n) => n.name,
      ),
    ).toHaveLength(4);
    expect(await run('alice', 'push', '--delete')).toBe(0);
    index = await f.dr.api.rooms.index(as('alice'), { tenantId: TENANT, roomId: room.id });
    expect(index.map((n) => n.name)).toEqual(['readme.md']);
    expect(await tree()).toEqual(['readme.md']);
  });

  it('skips view-only documents and removes files when access is withdrawn', async () => {
    const { f, room, run, tree, lines } = await setup();
    const team = await f.dr.api.groups.create(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      name: 'Buyers',
      preset: 'downloadOriginal',
    });
    await f.dr.api.members.invite(as('alice'), {
      tenantId: TENANT,
      roomId: room.id,
      email: 'bob@acme.test',
      groupIds: [team.id],
    });
    const hr = await f.dr.api.folders.create(as('alice'), {
      tenantId: TENANT,
      parentId: room.rootNodeId,
      name: 'HR',
    });
    await f.upload('alice', { parentId: hr.id, filename: 'open.txt', content: text('ok') });
    const { document: locked } = await f.upload('alice', {
      parentId: hr.id,
      filename: 'locked.txt',
      content: text('secret'),
    });
    await f.dr.api.permissions.setEntries(as('alice'), {
      tenantId: TENANT,
      nodeId: locked.id,
      entries: [{ subject: { type: 'group', id: team.id }, preset: 'view' }],
    });

    expect(await run('bob', 'pull')).toBe(0);
    const files = await tree();
    expect(files).toContain('HR/open.txt');
    expect(files).not.toContain('HR/locked.txt');
    expect(lines).toContain('  · locked.txt (view only)');

    await f.dr.api.permissions.setEntries(as('alice'), {
      tenantId: TENANT,
      nodeId: hr.id,
      entries: [{ subject: { type: 'group', id: team.id }, preset: 'hidden' }],
    });
    expect(await run('bob', 'pull')).toBe(0);
    expect(await tree()).toEqual([]);

    lines.length = 0;
    expect(await run('bob', 'status')).toBe(0);
    expect(lines).toEqual(['Remote: 0 pending change(s)']);
  });

  it('refuses a folder that mirrors another room, and explains missing options', async () => {
    const { f, dir, run, lines } = await setup();
    expect(await run('alice', 'pull')).toBe(0);
    const other = await f.dr.api.rooms.create(as('alice'), { tenantId: TENANT, name: 'Other' });
    lines.length = 0;
    const code = await main(
      [
        'sync',
        'pull',
        '--dir',
        dir,
        '--url',
        'http://app.test/api/better-files',
        '--tenant',
        TENANT,
        '--room',
        other.id,
        '--token',
        'alice',
      ],
      {
        out: (line) => lines.push(line),
        err: (line) => lines.push(line),
        env: {},
        cwd: dir,
        fetch: (input, init) => f.dr.handler(new Request(input, init)),
      },
    );
    expect(code).toBe(1);
    expect(lines[0]).toMatch(/already mirrors room/);
    expect(
      await main(['sync', 'pull'], {
        out() {},
        err: (line) => lines.push(line),
        env: {},
        cwd: dir,
      }),
    ).toBe(1);
    expect(safeName('a/b:c*')).toBe('a_b_c_');
    expect(safeName('CON.txt')).toBe('_CON.txt');
    expect((await stat(join(dir, '.better-files', 'state.json'))).isFile()).toBe(true);
  });
});

describe('better-files instance commands', () => {
  it('migrates, maintains, verifies and diagnoses an instance', async () => {
    const f = await fixture();
    const room = await f.room();
    const out: string[] = [];
    const io = {
      out: (line: string) => out.push(line),
      err: (line: string) => out.push(line),
      env: {},
      cwd: '.',
      load: async () => f.dr,
    };
    expect(await main(['migrate'], io)).toBe(0);
    expect(await main(['maintain'], io)).toBe(0);
    expect(out.at(-1)).toMatch(/"tickets":\d+/);
    expect(await main(['verify', '--tenant', TENANT, '--room', room.id], io)).toBe(0);
    expect(JSON.parse(out.slice(-1)[0]!.replace(/^[^{]*/, '') || '{}')).toBeDefined();
    out.length = 0;
    expect(await main(['doctor', '--tenant', TENANT], io)).toBe(0);
    expect(out).toEqual([
      '✓ secret',
      '✓ plugins: none',
      expect.stringMatching(/^✓ database: /),
      expect.stringMatching(/^✓ storage: .* \(write, read, delete\)$/),
      expect.stringMatching(/^✓ encryption: .*\(data key round trip\)$/),
      'All checks passed',
    ]);
    out.length = 0;
    expect(await main(['openapi'], io)).toBe(0);
    expect(JSON.parse(out.join('\n'))).toMatchObject({ openapi: '3.1.0' });
    out.length = 0;
    expect(await main(['generate', '--format', 'prisma'], io)).toBe(0);
    expect(out.join('\n')).toContain('model BetterFilesRooms {');
    expect(await main(['generate', '--format', 'yaml'], io)).toBe(1);
    expect(await main(['verify'], io)).toBe(1);
    expect(await main(['nope'], io)).toBe(1);
    expect(await main(['--help'], io)).toBe(0);
  });
});
