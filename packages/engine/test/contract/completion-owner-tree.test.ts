/**
 * What the contract does to the owner's tree around publication, on real
 * repositories: a conflicting merge is undone (but never the owner's own
 * merge), and a branch that already reached HEAD is recognised.
 */
import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { abortFailedMerge, branchAlreadyPublished, ownerMergeInProgress } from '../../platform/src/platform/contract/completion.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function git(root: string, ...args: string[]): { status: number | null; out: string } {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf-8' });
  return { status: result.status, out: (result.stdout ?? '').trim() };
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'completion-owner-tree-'));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  writeFileSync(join(root, 'a.txt'), 'base\n');
  writeFileSync(join(root, 'other.txt'), 'base\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  return root;
}

/** A branch and main that both rewrite a.txt, so merging the branch conflicts. */
function conflicting(root: string): void {
  git(root, 'checkout', '-qb', 'work');
  writeFileSync(join(root, 'a.txt'), 'branch\n');
  git(root, 'commit', '-qam', 'branch change');
  git(root, 'checkout', '-q', 'main');
  writeFileSync(join(root, 'a.txt'), 'owner\n');
  git(root, 'commit', '-qam', 'owner change');
}

test('a conflicting merge is undone: no MERGE_HEAD, no markers, HEAD unchanged', () => {
  const root = repo();
  conflicting(root);
  const head = git(root, 'rev-parse', 'HEAD').out;
  expect(ownerMergeInProgress(root)).toBe(false);
  expect(git(root, 'merge', '--no-ff', '-m', 'contract', 'work').status).not.toBe(0);
  expect(ownerMergeInProgress(root)).toBe(true);
  expect(abortFailedMerge(root, false)).toContain('undone');
  expect(git(root, 'status', '--porcelain=v1').out).toBe('');
  expect(git(root, 'rev-parse', 'HEAD').out).toBe(head);
  expect(existsSync(join(root, '.git', 'MERGE_HEAD'))).toBe(false);
});

test('a conflicting squash merge is undone too', () => {
  const root = repo();
  conflicting(root);
  expect(git(root, 'merge', '--squash', 'work').status).not.toBe(0);
  expect(abortFailedMerge(root, false)).toContain('undone');
  expect(git(root, 'status', '--porcelain=v1').out).toBe('');
});

test('a merge the owner had already started is left untouched', () => {
  const root = repo();
  conflicting(root);
  git(root, 'merge', '--no-ff', 'work');
  expect(ownerMergeInProgress(root)).toBe(true);
  expect(abortFailedMerge(root, true)).toContain('left untouched');
  expect(existsSync(join(root, '.git', 'MERGE_HEAD'))).toBe(true);
});

test('a branch whose work is already in HEAD is published; one that is not, or that never changed, is not', () => {
  const root = repo();
  const base = git(root, 'rev-parse', 'HEAD').out;
  git(root, 'branch', 'unchanged');
  git(root, 'checkout', '-qb', 'merged');
  writeFileSync(join(root, 'other.txt'), 'merged work\n');
  git(root, 'commit', '-qam', 'work');
  git(root, 'checkout', '-q', 'main');
  git(root, 'checkout', '-qb', 'pending');
  writeFileSync(join(root, 'other.txt'), 'pending work\n');
  git(root, 'commit', '-qam', 'pending work');
  git(root, 'checkout', '-q', 'main');
  expect(branchAlreadyPublished(root, 'merged', base)).toBe(false);
  git(root, 'merge', '--no-ff', '-q', '-m', 'publish', 'merged');
  expect(branchAlreadyPublished(root, 'merged', base)).toBe(true);
  expect(branchAlreadyPublished(root, 'pending', base)).toBe(false);
  expect(branchAlreadyPublished(root, 'unchanged', base)).toBe(false);
});
