import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IsolatedWorktree } from '../platform/src/platform/agents/worktree.js';

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t.t', ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${Buffer.from(result.stderr).toString('utf8')}`);
  return Buffer.from(result.stdout).toString('utf8').trim();
}

function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gv-integrate-')));
  roots.push(root);
  git(root, 'init', '-b', 'main');
  writeFileSync(join(root, 'a.txt'), 'one\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base');
  return root;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('IsolatedWorktree.integrate', () => {
  test('a base ref git cannot read is an error, not an empty branch', async () => {
    const root = repo();
    const path = join(root, '.goodvibes', '.worktrees', 'ws', 'item1');
    const item = new IsolatedWorktree(root, path, 'ws/item1', 'main');
    await item.create();
    writeFileSync(join(path, 'work.txt'), 'work\n');
    git(path, 'add', '.');
    git(path, 'commit', '-m', 'work');
    git(root, 'branch', '-m', 'main', 'trunk');
    await expect(item.integrate()).rejects.toThrow('cannot tell whether branch ws/item1 has commits');
    expect(git(root, 'rev-list', '--count', 'trunk..ws/item1')).toBe('1');
  });

  test('a branch with no commits beyond base is empty', async () => {
    const root = repo();
    const path = join(root, '.goodvibes', '.worktrees', 'ws', 'item2');
    const item = new IsolatedWorktree(root, path, 'ws/item2', 'main');
    await item.create();
    expect(await item.integrate()).toEqual({ status: 'empty' });
  });
});
