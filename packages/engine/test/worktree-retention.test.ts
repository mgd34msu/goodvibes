import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeRegistry, listPersistedWorktreeMeta } from '../platform/src/platform/runtime/worktree/registry.js';
import { createContractOwnerResolver } from '../platform/src/platform/runtime/worktree/owners.js';
import type { WorktreeOwnerInfo } from '../platform/src/platform/runtime/worktree/retention.js';
import { IsolatedWorktree } from '../platform/src/platform/agents/worktree.js';
import { GitService } from '../platform/src/platform/git/service.js';
import { markProductWorktree } from '../platform/src/platform/git/product-worktree-marker.js';

const DAY = 24 * 60 * 60 * 1000;
const ENDED_AT = Date.UTC(2026, 0, 1);
const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t.t', ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${Buffer.from(result.stderr).toString('utf8')}`);
  return Buffer.from(result.stdout).toString('utf8').trim();
}

function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gv-retention-')));
  roots.push(root);
  git(root, 'init', '-b', 'main');
  writeFileSync(join(root, 'a.txt'), 'one\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base');
  return root;
}

/** A contract-shaped worktree on its own branch, as the contract runner places it. */
function addContractWorktree(root: string, short: string): { path: string; branch: string } {
  const path = join(root, '.goodvibes', '.worktrees', 'contract', short);
  const branch = `contract/${short}`;
  git(root, 'worktree', 'add', path, '-b', branch, 'main');
  // The product records that it made a worktree when it adds one; the sweep removes only those.
  markProductWorktree(path);
  return { path, branch };
}

function commitIn(path: string, file: string): void {
  writeFileSync(join(path, file), `${file}\n`);
  git(path, 'add', '.');
  git(path, 'commit', '-m', `add ${file}`);
}

const ended = (): WorktreeOwnerInfo => ({ state: 'ended', endedAt: ENDED_AT, baseBranch: 'main' });
const branchExists = (root: string, branch: string): boolean =>
  Bun.spawnSync(['git', 'rev-parse', '--verify', '-q', `refs/heads/${branch}`], { cwd: root }).exitCode === 0;

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('worktree retention', () => {
  test('a clean worktree with nothing unique is removed with its branch when the contract ends', async () => {
    const root = repo();
    const { path, branch } = addContractWorktree(root, 'aaaa1111');
    const registry = new WorktreeRegistry(root);
    const report = await registry.releaseEnded([{ path, baseBranch: 'main' }], { now: () => ENDED_AT });
    expect(report.removed.map((entry) => entry.path)).toEqual([path]);
    expect(existsSync(path)).toBe(false);
    expect(branchExists(root, branch)).toBe(false);
    expect(listPersistedWorktreeMeta({ workingDirectory: root }).some((record) => record.path === path)).toBe(false);
  });

  test('a clean worktree with unmerged commits is kept, then pruned past retention with its branch and commits intact', async () => {
    const root = repo();
    const { path, branch } = addContractWorktree(root, 'bbbb2222');
    commitIn(path, 'work.txt');
    const tip = git(path, 'rev-parse', 'HEAD');
    const registry = new WorktreeRegistry(root);

    const atEnd = await registry.releaseEnded([{ path, baseBranch: 'main' }], { now: () => ENDED_AT });
    expect(atEnd.removed).toEqual([]);
    expect(existsSync(path)).toBe(true);

    const early = await registry.sweepRetention({ now: () => ENDED_AT + 13 * DAY, owner: ended });
    expect(early.removed).toEqual([]);
    expect(early.kept.find((entry) => entry.path === path)?.reason).toMatchObject({ why: 'unmerged', pruneInDays: 1 });
    expect(existsSync(path)).toBe(true);

    const late = await registry.sweepRetention({ now: () => ENDED_AT + 15 * DAY, owner: ended });
    expect(late.removed).toHaveLength(1);
    expect(late.removed[0]).toMatchObject({ pruned: true, branchDeleted: false });
    expect(late.removed[0]!.note).toContain('kept');
    expect(existsSync(path)).toBe(false);
    expect(branchExists(root, branch)).toBe(true);
    expect(git(root, 'rev-parse', branch)).toBe(tip);
  });

  test('the captured-input view of a dirty checkout is pruned past retention together with its synthetic branch', async () => {
    const root = repo();
    const path = join(root, '.goodvibes', '.worktrees', 'contract-input', 'dddd4444');
    const branch = 'contract-input/dddd4444';
    git(root, 'worktree', 'add', path, '-b', branch, 'main');
    markProductWorktree(path);
    commitIn(path, 'dirty-copy.txt');
    const registry = new WorktreeRegistry(root);

    const atEnd = await registry.releaseEnded([{ path, baseBranch: 'main' }], { now: () => ENDED_AT });
    expect(atEnd.removed).toEqual([]);
    expect(branchExists(root, branch)).toBe(true);

    const late = await registry.sweepRetention({ now: () => ENDED_AT + 15 * DAY, owner: ended });
    expect(late.removed.map((entry) => [entry.path, entry.branchDeleted])).toEqual([[path, true]]);
    expect(existsSync(path)).toBe(false);
    expect(branchExists(root, branch)).toBe(false);
  });

  test('uncommitted changes, tracked or untracked, are never removed at any age', async () => {
    const root = repo();
    const tracked = addContractWorktree(root, 'cccc3333');
    const untracked = addContractWorktree(root, 'dddd4444');
    writeFileSync(join(tracked.path, 'a.txt'), 'edited\n');
    writeFileSync(join(untracked.path, 'new.txt'), 'new\n');
    const registry = new WorktreeRegistry(root);
    const report = await registry.sweepRetention({ now: () => ENDED_AT + 400 * DAY, owner: ended });
    expect(report.removed).toEqual([]);
    expect(report.kept.map((entry) => entry.reason.why)).toEqual(['uncommitted', 'uncommitted']);
    expect(existsSync(tracked.path) && existsSync(untracked.path)).toBe(true);
  });

  test('a running owner keeps its worktree even when it is clean and merged', async () => {
    const root = repo();
    const { path } = addContractWorktree(root, 'eeee5555');
    const registry = new WorktreeRegistry(root);
    const report = await registry.sweepRetention({ now: () => ENDED_AT + 400 * DAY, owner: () => ({ state: 'running', baseBranch: 'main' }) });
    expect(report.removed).toEqual([]);
    expect(report.kept[0]?.reason.why).toBe('running');
    expect(existsSync(path)).toBe(true);
  });

  test('a worktree whose git state cannot be read is kept', async () => {
    const root = repo();
    const { path } = addContractWorktree(root, 'ffff6666');
    // Break the link to the repository's administrative directory.
    writeFileSync(join(path, '.git'), `gitdir: ${join(root, 'no-such-gitdir')}\n`);
    const registry = new WorktreeRegistry(root);
    const report = await registry.sweepRetention({ now: () => ENDED_AT + 400 * DAY, owner: ended });
    expect(report.removed).toEqual([]);
    expect(report.kept[0]?.reason.why).toBe('unreadable');
    expect(existsSync(path)).toBe(true);
  });

  test('a marked worktree whose git status fails is kept as unreadable, not removed', async () => {
    const root = repo();
    const { path } = addContractWorktree(root, 'fafa6666');
    // The marker stays reachable; only the worktree's index is corrupted, so `git status` fails.
    const adminDir = readFileSync(join(path, '.git'), 'utf8').trim().replace(/^gitdir:\s*/, '');
    writeFileSync(join(adminDir, 'index'), 'not an index');
    const registry = new WorktreeRegistry(root);
    const report = await registry.sweepRetention({ now: () => ENDED_AT + 400 * DAY, owner: ended });
    expect(report.removed).toEqual([]);
    expect(report.kept[0]?.reason).toMatchObject({ why: 'unreadable', detail: 'kept because git status failed' });
    expect(existsSync(path)).toBe(true);
  });

  test('commits that only a detached worktree holds are never pruned', async () => {
    const root = repo();
    const { path } = addContractWorktree(root, 'abab7777');
    git(path, 'checkout', '--detach');
    commitIn(path, 'only-here.txt');
    const registry = new WorktreeRegistry(root);
    const report = await registry.sweepRetention({ now: () => ENDED_AT + 400 * DAY, owner: ended });
    expect(report.removed).toEqual([]);
    expect(report.kept[0]?.reason.detail).toContain('detached');
    expect(existsSync(path)).toBe(true);
  });

  test('a directory under .goodvibes that the register does not hold as the product\'s is untouched', async () => {
    const root = repo();
    const stray = join(root, '.goodvibes', '.worktrees', 'contract', 'stray0000');
    mkdirSync(stray, { recursive: true });
    writeFileSync(join(stray, 'notes.txt'), 'mine\n');
    // A real worktree that merely sits under .goodvibes, in no shape the product creates.
    const handmade = join(root, '.goodvibes', '.worktrees', 'handmade');
    git(root, 'worktree', 'add', handmade, '-b', 'handmade', 'main');
    const registry = new WorktreeRegistry(root);
    const report = await registry.sweepRetention({ now: () => ENDED_AT + 400 * DAY, owner: ended });
    expect(report.removed).toEqual([]);
    expect(report.kept).toEqual([]);
    expect(existsSync(join(stray, 'notes.txt'))).toBe(true);
    expect(existsSync(handmade)).toBe(true);
  });

  test('ignored files keep a worktree at contract end and after the retention period', async () => {
    const root = repo();
    writeFileSync(join(root, '.gitignore'), '.env\n');
    git(root, 'add', '.'); git(root, 'commit', '-m', 'ignore env');
    const clean = addContractWorktree(root, 'a2a2a2a2');
    writeFileSync(join(clean.path, '.env'), 'SECRET=1\n');
    const unmerged = addContractWorktree(root, 'b2b2b2b2');
    commitIn(unmerged.path, 'work.txt');
    writeFileSync(join(unmerged.path, '.env'), 'SECRET=2\n');
    const registry = new WorktreeRegistry(root);
    const atEnd = await registry.releaseEnded([{ path: clean.path, baseBranch: 'main' }], { now: () => ENDED_AT });
    expect(atEnd.removed).toEqual([]);
    expect(atEnd.kept[0]?.reason.detail).toContain('1 ignored file(s)');
    const late = await registry.sweepRetention({ now: () => ENDED_AT + 400 * DAY, owner: ended });
    expect(late.removed).toEqual([]);
    expect(readFileSync(join(clean.path, '.env'), 'utf8')).toBe('SECRET=1\n');
    expect(readFileSync(join(unmerged.path, '.env'), 'utf8')).toBe('SECRET=2\n');
  });

  test('a worktree marked kept or paused, or attached to a session or task, is never swept', async () => {
    const root = repo();
    const kept = addContractWorktree(root, 'c2c2c2c2');
    const paused = addContractWorktree(root, 'd2d2d2d2');
    const attached = addContractWorktree(root, 'e2e2e2e2');
    const swept = addContractWorktree(root, 'a3a3a3a3');
    const registry = new WorktreeRegistry(root);
    await registry.list();
    registry.setState(kept.path, 'kept');
    registry.setState(paused.path, 'paused');
    registry.attach(attached.path, { sessionId: 'session-1' });
    const report = await registry.sweepRetention({ now: () => ENDED_AT + 400 * DAY, owner: ended });
    expect(report.removed.map((entry) => entry.path)).toEqual([swept.path]);
    for (const survivor of [kept, paused, attached]) expect(existsSync(survivor.path)).toBe(true);
    expect(report.kept.filter((entry) => entry.reason.why === 'protected')).toHaveLength(3);
  });

  test('a worktree from before the created-by record is removed with its uncommitted changes; its unmerged branch stays', async () => {
    const root = repo();
    const made = join(root, '.goodvibes', '.worktrees', 'contract', 'a4a4a4a4');
    await new GitService(root).worktreeAdd(made, 'contract/a4a4a4a4', 'main');
    const registry = new WorktreeRegistry(root);
    const older = join(root, '.goodvibes', '.worktrees', 'contract', 'b4b4b4b4');
    git(root, 'worktree', 'add', older, '-b', 'contract/b4b4b4b4', 'main');
    commitIn(older, 'kept-commit.txt');
    writeFileSync(join(older, 'unsaved.txt'), 'draft\n');
    const report = await registry.releaseEnded([{ path: made, baseBranch: 'main' }, { path: older, baseBranch: 'main' }], { now: () => ENDED_AT });
    expect(report.removed.map((entry) => entry.path).toSorted()).toEqual([made, older]);
    expect(existsSync(older)).toBe(false);
    expect(report.removed.find((entry) => entry.path === older)?.note).toContain('uncommitted change');
    expect(git(root, 'branch', '--list', 'contract/b4b4b4b4')).toContain('contract/b4b4b4b4');
  });

  test('the register is not held while a worktree is being removed', async () => {
    const root = repo();
    const { path } = addContractWorktree(root, 'c4c4c4c4');
    const other = addContractWorktree(root, 'd4d4d4d4');
    const registry = new WorktreeRegistry(root);
    await registry.list();
    const service = (registry as unknown as { git: { worktreeRemove: (target: string) => Promise<void> } }).git;
    const remove = service.worktreeRemove.bind(service);
    let writerWaitedMs = -1;
    service.worktreeRemove = async (target) => {
      const started = Date.now();
      registry.attach(other.path, { taskId: 'task-1' });
      writerWaitedMs = Date.now() - started;
      await remove(target);
    };
    const report = await registry.releaseEnded([{ path, baseBranch: 'main' }], { now: () => ENDED_AT });
    expect(report.removed).toHaveLength(1);
    expect(writerWaitedMs).toBeGreaterThanOrEqual(0);
    expect(writerWaitedMs).toBeLessThan(1_000);
  });

  test('discard names the ignored files it cannot preserve and keeps commits only a detached HEAD holds', async () => {
    const root = repo();
    writeFileSync(join(root, '.gitignore'), '.env\n');
    git(root, 'add', '.'); git(root, 'commit', '-m', 'ignore env');
    const { path } = addContractWorktree(root, 'e4e4e4e4');
    git(path, 'checkout', '--detach');
    commitIn(path, 'only-here.txt');
    const tip = git(path, 'rev-parse', 'HEAD');
    writeFileSync(join(path, '.env'), 'SECRET=1\n');
    const registry = new WorktreeRegistry(root);
    (registry as unknown as { defaultOwnerCache: (p: string) => WorktreeOwnerInfo }).defaultOwnerCache = ended;
    const receipt = await registry.discard(path);
    expect(receipt.ok).toBe(true);
    expect(receipt.detail).toContain('1 ignored file(s) or folder(s) were deleted');
    expect(receipt.detail).toContain('NOT preserved');
    expect(receipt.branch).toMatch(/^goodvibes\/discarded-/);
    expect(git(root, 'rev-parse', receipt.branch!)).toBe(tip);
    expect(existsSync(path)).toBe(false);
  });

  test('discarding a running worktree is refused and says what is at stake', async () => {
    const root = repo();
    const { path } = addContractWorktree(root, 'cdcd8888');
    commitIn(path, 'work.txt');
    writeFileSync(join(path, 'wip.txt'), 'wip\n');
    const registry = new WorktreeRegistry(root);
    const sweepOwner = (): WorktreeOwnerInfo => ({ state: 'running', baseBranch: 'main' });
    // The default resolver reads the contract store; give the registry the running verdict through its own seam.
    (registry as unknown as { defaultOwnerCache: (p: string) => WorktreeOwnerInfo }).defaultOwnerCache = sweepOwner;
    const receipt = await registry.discard(path);
    expect(receipt.ok).toBe(false);
    expect(receipt.detail).toContain('still running');
    expect(receipt.detail).toContain('uncommitted change');
    expect(existsSync(path)).toBe(true);
  });

  test('the kept listing says why each worktree is kept and when it is pruned', async () => {
    const root = repo();
    const { path } = addContractWorktree(root, 'efef9999');
    commitIn(path, 'work.txt');
    const registry = new WorktreeRegistry(root);
    const [info] = await registry.describeKept({ now: () => ENDED_AT + 4 * DAY, owner: ended });
    expect(info?.reason).toMatchObject({ why: 'unmerged', pruneInDays: 10 });
    expect(info?.summary).toContain('age 4d');
    expect(info?.sizeBytes).toBeGreaterThan(0);
  });

  test('the startup notice appears only above the size threshold', async () => {
    const root = repo();
    const { path } = addContractWorktree(root, 'a1a1a1a1');
    commitIn(path, 'work.txt');
    const registry = new WorktreeRegistry(root);
    expect(await registry.keptWorktreeNotice({ owner: ended })).toBeNull();
    const notice = await registry.keptWorktreeNotice({ owner: ended, thresholdBytes: 1 });
    expect(notice).toContain('1 kept worktree(s)');
    expect(notice).toContain('/worktree discard');
  });

  test('removing an item worktree never drops a branch whose commits are not merged', async () => {
    const root = repo();
    const path = join(root, '.goodvibes', '.worktrees', 'ws-owned', 'item1');
    const item = new IsolatedWorktree(root, path, 'ws-owned/item1', 'main');
    await item.create();
    commitIn(path, 'work.txt');
    expect(await item.uniqueCommitCount()).toBe(1);
    await item.remove();
    expect(existsSync(path)).toBe(false);
    expect(branchExists(root, 'ws-owned/item1')).toBe(true);
  });
});

describe('contract owner lookup', () => {
  test('a terminal contract is ended, a live one is running, an unreadable one is unknown', () => {
    const root = '/project';
    const contracts: Record<string, { status: 'passed' | 'running'; completedAt?: number; baseBranch?: string }> = {
      'ctr-aaaaaaaa': { status: 'passed', completedAt: 5, baseBranch: 'main' },
      'ctr-bbbbbbbb': { status: 'running', baseBranch: 'main' },
    };
    const resolve = createContractOwnerResolver(root, { load: (id) => contracts[id] ?? null });
    const at = (short: string) => join(root, '.goodvibes', '.worktrees', 'contract', short);
    expect(resolve(at('aaaaaaaa'))).toEqual({ state: 'ended', endedAt: 5, baseBranch: 'main' });
    expect(resolve(at('bbbbbbbb')).state).toBe('running');
    expect(resolve(at('cccccccc')).state).toBe('unknown');
    expect(resolve(join(root, '.goodvibes', '.worktrees', 'agent-x')).state).toBe('unknown');
  });
});
