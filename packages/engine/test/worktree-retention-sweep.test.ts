// Proves: The worktree sweep removes a worktree with its uncommitted work, or loses the commits a removed worktree's branch held.
// Red when: The sweep removes a worktree that holds uncommitted work (made by this product or not), or deletes a branch whose commits its base does not have.

import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IsolatedWorktree } from '../platform/src/platform/agents/worktree.ts';
import { WorktreeRegistry } from '../platform/src/platform/runtime/worktree/registry.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

test('a product worktree with uncommitted work is kept; a clean one with unmerged commits loses only its directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gv-worktree-sweep-'));
  roots.push(root);
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.email', 'owner@example.invalid');
  git(repo, 'config', 'user.name', 'Owner');
  writeFileSync(join(repo, '.gitignore'), '.goodvibes/\n');
  writeFileSync(join(repo, 'README.md'), 'project\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'start');

  // Made the product's way, under .goodvibes/.worktrees/agent-*, which writes the created-by record.
  const dirty = new IsolatedWorktree(repo, join(repo, '.goodvibes', '.worktrees', 'agent-dirty'), 'goodvibes/agent-dirty', 'main');
  await dirty.create();
  writeFileSync(join(dirty.path, 'notes.md'), 'work not yet committed\n');
  const done = new IsolatedWorktree(repo, join(repo, '.goodvibes', '.worktrees', 'agent-done'), 'goodvibes/agent-done', 'main');
  await done.create();
  writeFileSync(join(done.path, 'feature.ts'), 'export const feature = 1;\n');
  git(done.path, 'add', '-A');
  git(done.path, 'commit', '-q', '-m', 'feature');
  const doneCommit = git(done.path, 'rev-parse', 'HEAD');

  const yearLater = Date.now() + 365 * 24 * 60 * 60 * 1000;
  const report = await new WorktreeRegistry(repo).sweepRetention({
    now: () => yearLater,
    owner: () => ({ state: 'ended', endedAt: 0, baseBranch: 'main' }),
  });

  expect(readFileSync(join(dirty.path, 'notes.md'), 'utf8')).toBe('work not yet committed\n');
  expect(report.removed.map((entry) => entry.path)).not.toContain(dirty.path);
  expect(report.kept.find((entry) => entry.path === dirty.path)?.reason.why).toBe('uncommitted');
  // The control: the sweep acts on this repository; the commit the base lacks stays reachable.
  expect(existsSync(done.path)).toBe(false);
  expect(git(repo, 'rev-parse', 'goodvibes/agent-done')).toBe(doneCommit);
});
