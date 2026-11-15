/**
 * The one rule for "does this worktree hold work that exists nowhere else",
 * used before any worktree is removed. Uncommitted changes (tracked,
 * untracked or ignored) and commits the base branch lacks are the only copy
 * of that work, so they make the tree unique; a tree whose commits the base
 * already has, and with nothing uncommitted, is not.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uniqueWork } from '../platform/src/platform/agents/worktree.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(Buffer.from(result.stderr).toString('utf8'));
  return Buffer.from(result.stdout).toString('utf8');
}

function repoWithTree(name: string): { root: string; tree: string; branch: string } {
  const root = mkdtempSync(join(tmpdir(), 'unique-work-')); roots.push(root);
  git(root, 'init', '-q');
  writeFileSync(join(root, '.gitignore'), 'out/\n');
  writeFileSync(join(root, 'target.ts'), 'original\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'baseline');
  const tree = join(root, '.trees', name), branch = `work/${name}`;
  git(root, 'worktree', 'add', '-q', '-b', branch, tree);
  return { root, tree, branch };
}

describe('uniqueWork', () => {
  test('a tree and branch that hold nothing the base does not have are not unique', async () => {
    const { root, tree, branch } = repoWithTree('clean');
    expect(await uniqueWork(root, tree, branch, 'HEAD')).toBeNull();
  });

  test('uncommitted tracked, untracked or ignored files make the tree unique', async () => {
    for (const [name, path] of [['tracked', 'target.ts'], ['untracked', 'new.ts'], ['ignored', 'out/report.json']] as const) {
      const { root, tree, branch } = repoWithTree(name);
      mkdirSync(join(tree, 'out'), { recursive: true });
      writeFileSync(join(tree, path), 'unsaved work\n');
      expect(await uniqueWork(root, tree, branch, 'HEAD')).not.toBeNull();
    }
  });

  test('commits the base branch does not have make the branch unique, and stop doing so once merged', async () => {
    const { root, tree, branch } = repoWithTree('committed');
    writeFileSync(join(tree, 'feature.ts'), 'done\n'); git(tree, 'add', '.'); git(tree, 'commit', '-qm', 'work');
    expect(await uniqueWork(root, tree, branch, 'HEAD')).not.toBeNull();
    git(root, 'merge', '-q', branch);
    expect(await uniqueWork(root, tree, branch, 'HEAD')).toBeNull();
  });
});
