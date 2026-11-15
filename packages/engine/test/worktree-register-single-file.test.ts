import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WorktreeRegistry,
  getPersistedWorktreeMeta,
  listPersistedWorktreeMeta,
} from '../platform/src/platform/runtime/worktree/registry.js';

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-worktree-register-'));
  roots.push(dir);
  return dir;
}
function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, stdout: 'ignore', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
}
function repo(): string {
  const dir = root();
  git(dir, 'init');
  git(dir, 'commit', '--allow-empty', '-m', 'seed', '--no-verify');
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('worktree register', () => {
  test('a state change made by a surface is what every reader sees', () => {
    const cwd = repo();
    const path = join(cwd, '.goodvibes', '.worktrees', 'agent-a1');
    git(cwd, 'worktree', 'add', '-b', 'agent-a1', path);
    const surface = new WorktreeRegistry(cwd, { surfaceRoot: 'tui' });
    surface.attach(path, { sessionId: 's1' });
    surface.setState(path, 'kept');
    expect(getPersistedWorktreeMeta(path, { workingDirectory: cwd })?.state).toBe('kept');
    expect(listPersistedWorktreeMeta({ workingDirectory: cwd }).map((record) => record.sessionId)).toEqual(['s1']);
  });

  test('a surface-scoped register from an earlier version is merged, keeping its tombstones', () => {
    const cwd = root();
    const keptPath = join(cwd, 'wt-kept');
    const scopedDir = join(cwd, '.goodvibes', 'tui');
    mkdirSync(scopedDir, { recursive: true });
    writeFileSync(join(scopedDir, 'worktrees.json'), JSON.stringify({
      version: 1,
      records: { [keptPath]: { path: keptPath, kind: 'manual', state: 'kept', updatedAt: Date.now() } },
    }));
    const merged = listPersistedWorktreeMeta({ workingDirectory: cwd, surfaceRoot: 'tui' });
    expect(merged.map((record) => [record.path, record.state])).toEqual([[keptPath, 'kept']]);
    expect(getPersistedWorktreeMeta(keptPath, { workingDirectory: cwd })?.state).toBe('kept');
    expect(existsSync(join(scopedDir, 'worktrees.json'))).toBe(false);
  });

  test('changing the state of an unregistered path is refused and creates nothing', () => {
    const cwd = root();
    const registry = new WorktreeRegistry(cwd);
    expect(() => registry.setState(join(cwd, 'typo'), 'kept')).toThrow(/No worktree is registered/);
    expect(listPersistedWorktreeMeta({ workingDirectory: cwd })).toEqual([]);
  });

  test('attaching a path no worktree has is refused and creates no record', () => {
    const cwd = repo();
    const registry = new WorktreeRegistry(cwd);
    expect(() => registry.attach(join(cwd, 'typo'), { sessionId: 's1' })).toThrow(/No worktree exists/);
    expect(listPersistedWorktreeMeta({ workingDirectory: cwd })).toEqual([]);
  });

  test('a register that cannot be read is not overwritten by a state change', () => {
    const cwd = repo();
    const path = join(cwd, '.goodvibes', '.worktrees', 'agent-b1');
    git(cwd, 'worktree', 'add', '-b', 'agent-b1', path);
    const registry = new WorktreeRegistry(cwd);
    registry.attach(path, { sessionId: 's1' });
    // A directory where the register file should be makes every read fail with
    // EISDIR rather than ENOENT, whoever runs the test.
    const file = join(cwd, '.goodvibes', 'worktrees.json');
    rmSync(file);
    mkdirSync(file);
    expect(() => registry.setState(path, 'kept')).toThrow(/could not be read/);
    expect(statSync(file).isDirectory()).toBe(true);
  });

  test('discard refuses the main checkout and leaves its uncommitted files alone', async () => {
    const cwd = repo();
    writeFileSync(join(cwd, 'wip.txt'), 'unsaved\n');
    const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd }).stdout.toString();
    const receipt = await new WorktreeRegistry(cwd).discard(cwd);
    expect(receipt.ok).toBe(false);
    expect(receipt.detail).toContain('main checkout');
    expect(Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd }).stdout.toString()).toBe(head);
    expect(Bun.spawnSync(['git', 'status', '--porcelain'], { cwd }).stdout.toString()).toContain('?? wip.txt');
  });

  test('discard refuses a directory git does not list as a worktree', async () => {
    const cwd = repo();
    const other = repo();
    writeFileSync(join(other, 'wip.txt'), 'unsaved\n');
    const receipt = await new WorktreeRegistry(cwd).discard(other);
    expect(receipt.ok).toBe(false);
    expect(receipt.detail).toContain('not a worktree of this project');
    expect(Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: other }).stdout.toString()).toContain('?? wip.txt');
  });
});
