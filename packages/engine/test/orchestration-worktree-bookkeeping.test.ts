/**
 * Worktree bookkeeping against a real git repository: the kept-tree list and
 * the identity file follow the trees that really exist, and an integration
 * attempt that fails for infrastructure reasons is not reported as a merge
 * conflict with files.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IsolatedWorktree } from '../platform/src/platform/agents/worktree.js';
import { createWorktreeIsolationManager } from '../platform/src/platform/orchestration/worktree-isolation.js';
import { WORKTREE_IDENTITY_FILE } from '../platform/src/platform/orchestration/worktree-identities.js';
import type { OrchestrationEvent, WorkItem, Workstream } from '../platform/src/platform/orchestration/types.js';

function runGit(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(Buffer.from(result.stderr).toString('utf8'));
  return Buffer.from(result.stdout).toString('utf8');
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wt-bookkeeping-'));
  runGit(root, ['init']);
  runGit(root, ['config', 'user.name', 'test']);
  runGit(root, ['config', 'user.email', 'a@b.c']);
  runGit(root, ['-c', 'user.email=a@b.c', '-c', 'user.name=test', 'commit', '--allow-empty', '-m', 'seed']);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const workstream = { id: 'ws-1', title: 'ws', isolation: 'worktree', phases: [], items: [] } as unknown as Workstream;
function item(id: string): WorkItem {
  return { id, title: id, task: id, dependsOn: [], currentPhaseId: null, state: 'passed', allAgentIds: [], visits: new Map(), touchedPaths: [] } as unknown as WorkItem;
}

function setup(keptWorktreeCap?: number) {
  const events: OrchestrationEvent[] = [];
  const manager = createWorktreeIsolationManager({ projectRoot: root, emit: (e) => events.push(e), ...(keptWorktreeCap === undefined ? {} : { keptWorktreeCap }) });
  return { events, manager };
}

function identityRows(): unknown[] {
  const file = join(root, '.git', WORKTREE_IDENTITY_FILE);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { rows: unknown[] }).rows : [];
}

describe('kept worktree list', () => {
  test('a kept tree that is later merged and removed no longer counts toward the cap, so a real kept tree is not evicted', async () => {
    const { events, manager } = setup(2);
    const a = item('a'), b = item('b'), c = item('c');
    await manager.ensureWorktree(workstream, a);
    writeFileSync(join(a.worktreePath!, 'wip.txt'), 'a\n');
    await manager.cleanupTerminated(workstream, a); // kept: dirty

    await manager.ensureWorktree(workstream, b);
    const remove = IsolatedWorktree.prototype.remove;
    IsolatedWorktree.prototype.remove = async function () { throw new Error('locked'); };
    try { await manager.enqueueIntegration(workstream, b); } finally { IsolatedWorktree.prototype.remove = remove; }
    expect(b.worktreeKept).toBe(true); // merged but its directory could not be removed
    await manager.enqueueIntegration(workstream, b); // retry: the directory goes away
    expect(b.worktreeKept).toBe(false);

    await manager.ensureWorktree(workstream, c);
    writeFileSync(join(c.worktreePath!, 'wip.txt'), 'c\n');
    await manager.cleanupTerminated(workstream, c); // two real kept trees (a, c), cap 2
    await manager.join();

    expect(events.filter((e) => e.type === 'item-worktree-evicted')).toHaveLength(0);
    expect(existsSync(a.worktreePath!)).toBe(true);
    expect(a.worktreeKept).toBe(true);
  }, 60_000);

  test('an unresolved merge conflict is never evicted by the cap', async () => {
    const { events, manager } = setup(1);
    const a = item('a'), b = item('b');
    await manager.ensureWorktree(workstream, a);
    writeFileSync(join(a.worktreePath!, 'wip.txt'), 'a\n');
    a.mergeState = 'conflict';
    await manager.cleanupTerminated(workstream, a);
    await manager.ensureWorktree(workstream, b);
    writeFileSync(join(b.worktreePath!, 'wip.txt'), 'b\n');
    await manager.cleanupTerminated(workstream, b); // over the cap: b is the evictable one
    await manager.join();

    const evicted = events.filter((e): e is Extract<OrchestrationEvent, { type: 'item-worktree-evicted' }> => e.type === 'item-worktree-evicted');
    expect(evicted.map((e) => e.itemId)).toEqual(['b']);
    expect(existsSync(a.worktreePath!)).toBe(true);
  }, 60_000);
});

describe('integration that fails for infrastructure reasons', () => {
  test('is not recorded as a conflict with files, clears stale conflict files, and a retry integrates', async () => {
    const { manager } = setup();
    const a = item('a');
    await manager.ensureWorktree(workstream, a);
    a.conflictFiles = ['stale.txt'];
    const integrate = IsolatedWorktree.prototype.integrate;
    IsolatedWorktree.prototype.integrate = async function () { throw new Error('lock wait expired'); };
    try { await manager.enqueueIntegration(workstream, a); } finally { IsolatedWorktree.prototype.integrate = integrate; }

    expect(a.mergeState).toBe('conflict');
    expect(a.conflictFiles).toBeUndefined();
    expect(a.blockedReason).toStartWith('integration-error:');
    expect(a.blockedReason).toContain('lock wait expired');
    expect(a.blockedReason).not.toContain('merge-conflict');

    await manager.enqueueIntegration(workstream, a);
    expect(a.mergeState).toBe('merged');
  }, 60_000);
});

describe('identity file', () => {
  test('a removed worktree releases its row and a live one keeps it', async () => {
    const { manager } = setup();
    const a = item('a'), b = item('b');
    await manager.ensureWorktree(workstream, a);
    await manager.ensureWorktree(workstream, b);
    expect(identityRows()).toHaveLength(2);

    await manager.enqueueIntegration(workstream, a); // empty branch: merged and removed
    expect(a.worktreePath).toBeUndefined();
    const rows = identityRows() as Array<{ itemId: string }>;
    expect(rows.map((row) => row.itemId)).toEqual(['b']);
  }, 60_000);

  test('a removed clean tree is recreated with a fresh row at the next claim', async () => {
    const { manager } = setup();
    const a = item('a');
    await manager.ensureWorktree(workstream, a);
    await manager.cleanupTerminated(workstream, a);
    expect(a.worktreePath).toBeUndefined();
    expect(identityRows()).toHaveLength(0);

    await manager.ensureWorktree(workstream, a);
    expect(a.worktreePath).toBeDefined();
    expect((identityRows() as Array<{ itemId: string }>).map((row) => row.itemId)).toEqual(['a']);
  }, 60_000);
});
