/**
 * The cancel/error path of an agent's worktree removes only a tree that holds
 * nothing unique. Uncommitted changes and commits the base branch lacks are
 * the only copy of that work, so they are kept (never forced away), with the branch.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentWorktree } from '../platform/src/platform/agents/worktree.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(Buffer.from(result.stderr).toString('utf8'));
  return Buffer.from(result.stdout).toString('utf8');
}

async function repoWithAgent(agentId: string): Promise<{ root: string; tree: string; worktrees: AgentWorktree }> {
  const root = mkdtempSync(join(tmpdir(), 'agent-worktree-cleanup-')); roots.push(root);
  git(root, 'init', '-q'); writeFileSync(join(root, 'target.ts'), 'original\n'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'baseline');
  const worktrees = new AgentWorktree(root);
  return { root, tree: await worktrees.create(agentId), worktrees };
}

const branches = (root: string): string[] => git(root, 'branch', '--list', 'agent/*').split('\n').map((line) => line.replace(/^[*+]?\s*/, '').trim()).filter(Boolean);

describe('AgentWorktree.cleanup', () => {
  test('removes a worktree and branch that hold nothing the base does not have', async () => {
    const { root, tree, worktrees } = await repoWithAgent('clean');
    await worktrees.cleanup('clean');
    expect(existsSync(tree)).toBe(false);
    expect(branches(root)).toEqual([]);
  });

  test('keeps a worktree with uncommitted changes, tracked or untracked, and its branch', async () => {
    for (const change of ['tracked', 'untracked'] as const) {
      const { root, tree, worktrees } = await repoWithAgent(`dirty-${change}`);
      writeFileSync(join(tree, change === 'tracked' ? 'target.ts' : 'new.ts'), 'unsaved work\n');
      await worktrees.cleanup(`dirty-${change}`);
      expect(existsSync(join(tree, change === 'tracked' ? 'target.ts' : 'new.ts'))).toBe(true);
      expect(branches(root)).toEqual([`agent/dirty-${change}`]);
    }
  });

  test('keeps committed work the base branch does not have, in the tree and on the branch', async () => {
    const { root, tree, worktrees } = await repoWithAgent('committed');
    writeFileSync(join(tree, 'feature.ts'), 'done\n'); git(tree, 'add', '.'); git(tree, 'commit', '-qm', 'agent work');
    await worktrees.cleanup('committed');
    expect(existsSync(join(tree, 'feature.ts'))).toBe(true);
    expect(branches(root)).toEqual(['agent/committed']);
  });

  test('removes a worktree whose commits the base branch already has', async () => {
    const { root, tree, worktrees } = await repoWithAgent('merged');
    writeFileSync(join(tree, 'feature.ts'), 'done\n'); git(tree, 'add', '.'); git(tree, 'commit', '-qm', 'agent work');
    git(root, 'merge', '-q', 'agent/merged');
    await worktrees.cleanup('merged');
    expect(existsSync(tree)).toBe(false);
    expect(branches(root)).toEqual([]);
  });

  test('a merge with nothing to merge still keeps uncommitted work in the tree', async () => {
    const { root, tree, worktrees } = await repoWithAgent('no-commits');
    writeFileSync(join(tree, 'draft.ts'), 'never committed\n');
    expect(await worktrees.merge('no-commits')).toBe(false);
    expect(existsSync(join(tree, 'draft.ts'))).toBe(true);
    expect(branches(root)).toEqual(['agent/no-commits']);
  });
});
