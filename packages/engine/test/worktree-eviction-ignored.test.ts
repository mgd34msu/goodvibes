// Proves: Evicting a kept worktree never writes an ignored file (a credential file an agent wrote) into a commit on a branch that survives and can be pushed, and keeps that file for the owner only.
// Red when: Eviction commits .env.local to the preserved branch, or drops it instead of keeping it in an owner-only directory.
/**
 * Evicting a kept worktree keeps its work, but a file the owner's ignore rules
 * keep out of history (a credential file an agent wrote, a local database)
 * must never be written into a commit on a branch that survives and can be
 * pushed. It is kept outside the repository's history instead, readable only
 * by the owner. Real git, real worktree, nothing stood in.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IsolatedWorktree } from '../platform/src/platform/agents/worktree.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

describe('worktree eviction', () => {
  test('keeps ignored files out of the preserved commit and keeps them for the owner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-evict-ignored-'));
    roots.push(root);
    const repo = join(root, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git(repo, 'config', 'user.email', 'owner@example.invalid');
    git(repo, 'config', 'user.name', 'Owner');
    writeFileSync(join(repo, '.gitignore'), '.env.local\n.goodvibes/\n');
    writeFileSync(join(repo, 'README.md'), 'project\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'start');

    const worktree = new IsolatedWorktree(repo, join(root, 'item'), 'goodvibes/item-1', 'main');
    await worktree.create();
    writeFileSync(join(worktree.path, 'notes.md'), 'work in progress\n');
    writeFileSync(join(worktree.path, '.env.local'), 'API_TOKEN=not-for-history\n');

    const evicted = await worktree.evict();

    expect(evicted.preservedCommit).not.toBeNull();
    const committed = git(repo, 'ls-tree', '-r', '--name-only', 'goodvibes/item-1').split('\n');
    expect(committed).toContain('notes.md');
    expect(committed).not.toContain('.env.local');
    expect(git(repo, 'log', '--all', '--format=%H', '--', '.env.local').trim()).toBe('');

    expect(evicted.keptIgnoredDir).not.toBeNull();
    const kept = evicted.keptIgnoredDir!;
    expect(readFileSync(join(kept, '.env.local'), 'utf8')).toBe('API_TOKEN=not-for-history\n');
    expect(statSync(kept).mode & 0o077).toBe(0);
  });
});
