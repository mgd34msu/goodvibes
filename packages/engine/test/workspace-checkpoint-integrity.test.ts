/**
 * Checkpoint results must say what happened: a scoped restore reports the paths it could not apply,
 * an empty path list is refused, the working-tree diff lists files created since the last snapshot,
 * the side repo's own storage never lands in a checkpoint, and refs without an index record are
 * re-listed or reclaimed instead of leaking.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { WorkspaceCheckpointManager } from '../platform/src/platform/workspace/checkpoint/manager.js';
import { computeSessionChanges } from '../platform/src/platform/workspace/checkpoint/session-changes.js';
import type { SideGitRunner } from '../platform/src/platform/workspace/checkpoint/side-git.js';
import type { WorkspaceCheckpoint } from '../platform/src/platform/workspace/checkpoint/types.js';

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function sideGitOf(manager: WorkspaceCheckpointManager): SideGitRunner {
  return Reflect.get(manager, 'sideGit') as SideGitRunner;
}

describe('workspace checkpoint integrity', () => {
  test('a checkpoint taken from a subdirectory of a repo never contains the side repo storage', async () => {
    const repo = tempRoot('wcp-sub-');
    try {
      expect(spawnSync('git', ['init', '--quiet'], { cwd: repo }).status).toBe(0);
      const sub = join(repo, 'sub');
      mkdirSync(sub);
      writeFileSync(join(sub, 'a.txt'), 'a'.repeat(100));
      const manager = new WorkspaceCheckpointManager({ workspaceRoot: sub, checkpointDir: join(sub, '.goodvibes', 'surface', 'checkpoints'), autoRetention: false });
      await manager.create({ kind: 'manual', label: 'first' });
      writeFileSync(join(sub, 'b.txt'), 'b'.repeat(100));
      const second = await manager.create({ kind: 'manual', label: 'second' });
      const tracked = await sideGitOf(manager).listTrackedFiles(second!.commit);
      expect(tracked).toContain('sub/a.txt');
      expect(tracked.filter((path) => path.includes('.goodvibes'))).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('an empty paths list is refused and the workspace is left alone', async () => {
    const root = tempRoot('wcp-empty-paths-');
    try {
      const manager = new WorkspaceCheckpointManager({ workspaceRoot: root, autoRetention: false });
      writeFileSync(join(root, 'a.txt'), 'one');
      const cp = await manager.create({ kind: 'manual', label: 'one' });
      writeFileSync(join(root, 'a.txt'), 'two');
      writeFileSync(join(root, 'new.txt'), 'added later');
      await expect(manager.restore(cp!.id, { paths: [] })).rejects.toThrow('empty list');
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('two');
      expect(existsSync(join(root, 'new.txt'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a scoped restore names the paths it could not apply', async () => {
    const root = tempRoot('wcp-failed-paths-');
    try {
      const manager = new WorkspaceCheckpointManager({ workspaceRoot: root, autoRetention: false });
      writeFileSync(join(root, 'a.txt'), 'one');
      const cp = await manager.create({ kind: 'manual', label: 'one' });
      writeFileSync(join(root, 'a.txt'), 'two');
      const result = await manager.restore(cp!.id, { paths: ['a.txt', 'missing.txt'] });
      expect(result.restoredFiles).toEqual(['a.txt']);
      expect(result.failedPaths?.map((f) => f.path)).toEqual(['missing.txt']);
      expect(result.failedPaths?.[0]?.reason.length).toBeGreaterThan(0);
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('one');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the working-tree diff lists a file created since the last snapshot, and a restore removes exactly the listed ones', async () => {
    const root = tempRoot('wcp-live-diff-');
    try {
      const manager = new WorkspaceCheckpointManager({ workspaceRoot: root, autoRetention: false });
      writeFileSync(join(root, 'a.txt'), 'one');
      const cp = await manager.create({ kind: 'manual', label: 'one' });
      writeFileSync(join(root, 'new.ts'), 'created after the snapshot');
      const diff = await manager.diff(cp!.id);
      expect(diff.files).toContain('new.ts');
      const result = await manager.restore(cp!.id);
      expect(result.removedFiles).toEqual(diff.files.filter((f) => f === 'new.ts'));
      expect(existsSync(join(root, 'new.ts'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('refs the index lost are listed again after the index is quarantined', async () => {
    const root = tempRoot('wcp-readopt-');
    try {
      const first = new WorkspaceCheckpointManager({ workspaceRoot: root, autoRetention: false });
      writeFileSync(join(root, 'a.txt'), 'one');
      const a = await first.create({ kind: 'manual', label: 'alpha' });
      writeFileSync(join(root, 'a.txt'), 'two');
      const b = await first.create({ kind: 'manual', label: 'beta' });
      writeFileSync(join(root, '.goodvibes', 'checkpoints', 'index.json'), '{"checkpoints": [');

      const second = new WorkspaceCheckpointManager({ workspaceRoot: root, autoRetention: false });
      const listed = await second.list();
      expect(listed.map((c) => c.id).sort()).toEqual([a!.id, b!.id].sort());
      expect(listed.find((c) => c.id === a!.id)?.label).toBe('alpha');
      await second.restore(a!.id);
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('one');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a create that fails after moving the ref leaves no ref behind, and gc reclaims refs the index does not list', async () => {
    const root = tempRoot('wcp-orphan-ref-');
    try {
      const manager = new WorkspaceCheckpointManager({ workspaceRoot: root, autoRetention: false });
      writeFileSync(join(root, 'a.txt'), 'one');
      const first = await manager.create({ kind: 'manual', label: 'one' });
      const sideGit = sideGitOf(manager);

      writeFileSync(join(root, 'a.txt'), 'two');
      const realDiffNameOnly = sideGit.diffNameOnly.bind(sideGit);
      sideGit.diffNameOnly = async () => { throw new Error('disk full'); };
      await expect(manager.create({ kind: 'manual', label: 'two' })).rejects.toThrow('disk full');
      sideGit.diffNameOnly = realDiffNameOnly;
      expect((await sideGit.listCheckpointRefs()).map((r) => r.id)).toEqual([first!.id]);

      await sideGit.updateRef('refs/goodvibes/checkpoints/wcp_stray', first!.commit);
      await manager.gc();
      expect((await sideGit.listCheckpointRefs()).map((r) => r.id)).toEqual([first!.id]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('session changes base', () => {
  const record = (id: string, createdAt: number, parentId: string | null, sessionId?: string): WorkspaceCheckpoint => ({
    id, kind: 'turn', label: id, createdAt, parentId, retentionClass: 'standard', commit: `commit-${id}`, sizeBytes: 0, ...(sessionId ? { sessionId } : {}),
  });
  const fakeSideGit = (bases: string[]): SideGitRunner => {
    const run = async (from: string): Promise<string> => { bases.push(from); return ''; };
    return { diff: run, diffStat: run, diffNameOnly: async (from: string) => { bases.push(from); return []; } } as unknown as SideGitRunner;
  };

  test('a pruned parent is reported, not turned into a diff against the empty tree', async () => {
    const bases: string[] = [];
    const checkpoints = new Map([['b', record('b', 20, 'a-pruned', 's1')]]);
    const result = await computeSessionChanges(checkpoints, fakeSideGit(bases), 's1');
    expect(result.baseUnavailable).toBe(true);
    expect(result.from).toBe('b');
    expect(new Set(bases)).toEqual(new Set(['commit-b']));
  });

  test('a session whose first checkpoint has no parent is never diffed from the empty tree', async () => {
    const bases: string[] = [];
    const checkpoints = new Map([['a', record('a', 10, null, 's1')]]);
    const result = await computeSessionChanges(checkpoints, fakeSideGit(bases), 's1');
    expect(result.from).toBe('a');
    expect(result.baseUnavailable).toBe(true);
    expect(new Set(bases)).toEqual(new Set(['commit-a']));
  });

  test('a session whose checkpoints sit alone in the history is still flagged, because uncheckpointed edits by others are in the tree', async () => {
    const result = await computeSessionChanges(new Map([['p', record('p', 5, null)], ['a1', record('a1', 10, 'p', 's1')]]), fakeSideGit([]), 's1');
    expect(result.attributionApproximate).toBe(true);
    const none = await computeSessionChanges(new Map(), fakeSideGit([]), 's1');
    expect(none.attributionApproximate).toBeUndefined();
  });

  test('checkpoints of another session inside the span mark the attribution approximate', async () => {
    const checkpoints = new Map([
      ['p', record('p', 5, null)],
      ['a1', record('a1', 10, 'p', 's1')],
      ['b1', record('b1', 15, 'a1', 's2')],
      ['a2', record('a2', 20, 'b1', 's1')],
    ]);
    const result = await computeSessionChanges(checkpoints, fakeSideGit([]), 's1');
    expect(result.attributionApproximate).toBe(true);
  });
});
