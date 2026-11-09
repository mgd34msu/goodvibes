import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GitService, readGitWorktreeCreation } from '../platform/src/platform/git/service.js';
import { IsolatedWorktree, readIsolatedWorktreeCreation } from '../platform/src/platform/agents/worktree.js';
import type { HookDispatcher } from '../platform/src/platform/hooks/dispatcher.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function git(root: string, ...args: string[]) {
  const child = Bun.spawnSync(['git', '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', ...args], { cwd: root });
  if (child.exitCode !== 0) throw new Error(new TextDecoder().decode(child.stderr));
}
function fixture() {
  const root = makeProjectTempDir('git-created-receipt'); roots.push(root);
  git(root, 'init', '-q', '-b', 'main'); writeFileSync(join(root, 'seed'), 'original');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'seed');
  return { root, path: join(root, 'isolated'), branch: 'fixture-owned' };
}

// UNRUN: actual native command/receipt regressions, never model fixtures.
for (const checkout of [true, false]) test(`only actual native creation issues an instance receipt (checkout ${checkout})`, async () => {
  const f = fixture(), instance = new IsolatedWorktree(f.root, f.path, f.branch, 'main');
  expect(readIsolatedWorktreeCreation(instance)).toBeUndefined();
  await instance.create(undefined, checkout);
  const receipt = readIsolatedWorktreeCreation(instance)!;
  expect(receipt.facts).toMatchObject({ path: f.path, branch: f.branch });
  expect(Object.isFrozen(receipt.facts)).toBe(true);
  writeFileSync(join(f.path, 'initializer-output'), 'allowed child change');
  expect(() => receipt.assertCurrent()).not.toThrow();
  expect(readIsolatedWorktreeCreation({ ...instance } as IsolatedWorktree)).toBeUndefined();
  expect(JSON.stringify(instance)).not.toContain('gitFile');
});

test('a fake successful borrowed public create cannot mint an original creation receipt', async () => {
  const f = fixture(); mkdirSync(f.path); writeFileSync(join(f.path, 'foreign'), 'preserve');
  const spy = spyOn(GitService.prototype, 'worktreeAdd').mockImplementation(async () => {});
  try {
    const instance = new IsolatedWorktree(f.root, f.path, f.branch, 'main');
    await instance.create();
    expect(readIsolatedWorktreeCreation(instance)).toBeUndefined();
    expect(readFileSync(join(f.path, 'foreign'), 'utf8')).toBe('preserve');
  } finally { spy.mockRestore(); }
});

test('an actual failed Git creation has no receipt and preserves the pre-existing user resource', async () => {
  const f = fixture(); git(f.root, 'branch', f.branch); mkdirSync(f.path); writeFileSync(join(f.path, 'foreign'), 'preserve');
  const instance = new IsolatedWorktree(f.root, f.path, f.branch, 'main');
  await expect(instance.create()).rejects.toThrow();
  expect(readIsolatedWorktreeCreation(instance)).toBeUndefined();
  expect(existsSync(join(f.path, 'foreign'))).toBe(true);
});

test('real creation is observed before a post hook rejects, without pretending the public command succeeded', async () => {
  const f = fixture(); let calls = 0;
  const hooks = { async fire() { calls += 1; if (calls === 2) throw new Error('fixture post hook rejected'); return { decision: 'allow' }; } } as unknown as HookDispatcher;
  const service = new GitService(f.root, hooks);
  await expect(service.worktreeAdd(f.path, f.branch)).rejects.toThrow('fixture post hook rejected');
  const receipt = readGitWorktreeCreation(service, f.path, f.branch);
  expect(receipt?.facts.branch).toBe(f.branch);
  expect(() => receipt!.assertCurrent()).not.toThrow();
});

test('instance retains a genuine native receipt even when an outer public wrapper rejects after creation', async () => {
  const f = fixture(), original = GitService.prototype.worktreeAdd;
  const spy = spyOn(GitService.prototype, 'worktreeAdd').mockImplementation(async function (this: GitService, ...args) {
    await original.apply(this, args); throw new Error('fixture outer rejection');
  });
  try {
    const instance = new IsolatedWorktree(f.root, f.path, f.branch, 'main');
    await expect(instance.create()).rejects.toThrow('fixture outer rejection');
    expect(readIsolatedWorktreeCreation(instance)?.facts.branch).toBe(f.branch);
  } finally { spy.mockRestore(); }
});

test('retired original worktree parents refuse while the foreign replacement remains untouched', async () => {
  const f = fixture(), instance = new IsolatedWorktree(f.root, f.path, f.branch, 'main');
  await instance.create(); const receipt = readIsolatedWorktreeCreation(instance)!;
  renameSync(f.path, `${f.path}-retired`); mkdirSync(f.path); writeFileSync(join(f.path, 'foreign'), 'preserve');
  expect(() => receipt.assertCurrent()).toThrow();
  expect(() => readIsolatedWorktreeCreation(instance)).toThrow();
  expect(readFileSync(join(f.path, 'foreign'), 'utf8')).toBe('preserve');
});
