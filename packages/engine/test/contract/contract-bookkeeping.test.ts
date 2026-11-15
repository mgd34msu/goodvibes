/**
 * Direct tests of the small host-side pieces around a contract: the work-plan sync, the publication merge,
 * and the file inventory a review contract is checked against.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkPlanTaskExistsError } from '../../platform/src/platform/knowledge/project-planning/service.js';
import { completePlanItemsForUnit, contractTaskId, createContractPlanSync, unitTaskId } from '../../platform/src/platform/contract/plan-sync.js';
import { mergePublicationTree } from '../../platform/src/platform/contract/publication-merge.js';
import { ContractPublicationConflictError } from '../../platform/src/platform/contract/publication-conflict.js';
import { captureReviewInventory, directoryFileCounts } from '../../platform/src/platform/contract/review-inventory.js';
import type { ContractEvent } from '../../platform/src/events/contract.js';
import { makeRepo } from './runner-support.js';
import { git } from './steps-support.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function tempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe('completePlanItemsForUnit', () => {
  test('completes only active items worked by the unit\'s agents that are not already finished', () => {
    const updated: string[] = [];
    const plan = { id: 'plan-1', items: [
      { id: 'a', agentId: 'agent-1', status: 'running' },
      { id: 'b', agentId: 'agent-1', status: 'complete' },
      { id: 'c', agentId: 'agent-1', status: 'failed' },
      { id: 'd', agentId: 'agent-2', status: 'running' },
      { id: 'e', status: 'pending' },
    ] };
    const manager = { getActive: () => plan, updateItem: (_plan: string, item: string) => { updated.push(item); } };
    completePlanItemsForUnit(['agent-1'], manager as never);
    expect(updated).toEqual(['a']);
  });

  test('an update that throws does not stop the remaining items', () => {
    const updated: string[] = [];
    const plan = { id: 'plan-1', items: [{ id: 'a', agentId: 'agent-1', status: 'running' }, { id: 'b', agentId: 'agent-1', status: 'running' }] };
    const manager = { getActive: () => plan, updateItem: (_plan: string, item: string) => { if (item === 'a') throw new Error('plan closed'); updated.push(item); } };
    completePlanItemsForUnit(['agent-1'], manager as never);
    expect(updated).toEqual(['b']);
  });

  test('without an active plan nothing happens', () => {
    expect(() => completePlanItemsForUnit(['agent-1'], { getActive: () => undefined, updateItem: () => { throw new Error('unreachable'); } } as never)).not.toThrow();
  });
});

describe('createContractPlanSync', () => {
  function created(contractId: string): ContractEvent {
    return { type: 'CONTRACT_CREATED', contractId, sessionId: 's1', origin: 'cli', ask: 'Add a parser', ownerAgentId: 'owner-1' } as ContractEvent;
  }
  function statusChanged(contractId: string, to: string): ContractEvent {
    return { type: 'CONTRACT_STATUS_CHANGED', contractId, from: 'queued', to } as unknown as ContractEvent;
  }

  test('a task that already exists is updated instead, once; later events update without trying to create again', async () => {
    const calls: string[] = [];
    const service = {
      createWorkPlanTask: async (input: { task: { taskId?: string } }) => { calls.push(`create ${input.task.taskId}`); throw new WorkPlanTaskExistsError(input.task.taskId ?? ''); },
      updateWorkPlanTask: async (input: { taskId: string; patch: { status?: string } }) => { calls.push(`update ${input.taskId} ${input.patch.status}`); },
    };
    const sync = createContractPlanSync({ workPlanService: service as never, getContract: () => null });
    const id = 'ctr-0000aaaa';
    sync.onEvent(created(id));
    sync.onEvent(statusChanged(id, 'running'));
    await sync.flush();
    expect(calls).toEqual([`create ${contractTaskId(id)}`, `update ${contractTaskId(id)} pending`, `update ${contractTaskId(id)} in_progress`]);
  });

  test('a failing write is logged and the next write for the same task still runs, after it', async () => {
    const order: string[] = [];
    let first = true;
    const service = {
      createWorkPlanTask: async () => { order.push('create'); if (first) { first = false; throw new Error('disk full'); } },
      updateWorkPlanTask: async (input: { patch: { status?: string } }) => { order.push(`update ${input.patch.status}`); },
    };
    const sync = createContractPlanSync({ workPlanService: service as never, getContract: () => null });
    sync.onEvent(created('ctr-0000bbbb'));
    sync.onEvent(statusChanged('ctr-0000bbbb', 'passed'));
    await sync.flush();
    // The failed create did not mark the task known, so the next write for it creates again rather than updating a task that was never made.
    expect(order).toEqual(['create', 'create']);
  });

  test('unit tasks hang under their contract', () => {
    expect(unitTaskId('ctr-1', 'u1')).toBe(`${contractTaskId('ctr-1')}-u1`);
  });
});

describe('mergePublicationTree', () => {
  function branchWith(root: string, branch: string, from: string, file: string, content: string): string {
    git(root, 'checkout', '-q', '-b', branch, from);
    writeFileSync(join(root, file), content);
    git(root, 'add', '.'); git(root, 'commit', '-q', '-m', branch);
    return git(root, 'rev-parse', 'HEAD').trim();
  }

  test('changes to different files merge into one tree', async () => {
    const root = makeRepo(); roots.push(root);
    const base = git(root, 'rev-parse', 'HEAD').trim();
    const owner = branchWith(root, 'owner', base, 'owner.txt', 'owner\n');
    const result = branchWith(root, 'result', base, 'result.txt', 'result\n');
    const tree = await mergePublicationTree(root, base, owner, result, ['result.txt'], new AbortController().signal);
    expect(tree).toMatch(/^[a-f0-9]{40}$/);
    expect(git(root, 'ls-tree', '--name-only', tree).split('\n')).toEqual(expect.arrayContaining(['owner.txt', 'result.txt', 'README.md']));
  });

  test('both sides changing the same lines is a publication conflict naming the paths, and the owner files are untouched', async () => {
    const root = makeRepo(); roots.push(root);
    const base = git(root, 'rev-parse', 'HEAD').trim();
    const owner = branchWith(root, 'owner', base, 'README.md', '# owner\n');
    const result = branchWith(root, 'result', base, 'README.md', '# result\n');
    const error = await mergePublicationTree(root, base, owner, result, ['README.md'], new AbortController().signal).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ContractPublicationConflictError);
    expect((error as ContractPublicationConflictError).paths).toEqual(['README.md']);
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  test('an aborted merge throws the abort instead of a tree', async () => {
    const root = makeRepo(); roots.push(root);
    const head = git(root, 'rev-parse', 'HEAD').trim();
    const stopped = new AbortController(); stopped.abort(new Error('stopped'));
    await expect(mergePublicationTree(root, head, head, head, [], stopped.signal)).rejects.toThrow('stopped');
  });
});

describe('captureReviewInventory', () => {
  test('in a repository it lists tracked and untracked files, not ignored or deleted ones, sorted', async () => {
    const root = makeRepo(); roots.push(root);
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/b.ts'), 'b'); writeFileSync(join(root, 'a.ts'), 'a');
    writeFileSync(join(root, 'tracked-then-deleted.txt'), 'x');
    git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'more');
    rmSync(join(root, 'tracked-then-deleted.txt'));
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules/dep.js'), 'dep');
    writeFileSync(join(root, 'untracked.md'), 'u');
    const inventory = await captureReviewInventory(root);
    expect(inventory.source).toBe('git');
    expect(inventory.paths).toEqual(['.gitignore', 'README.md', 'a.ts', 'src/b.ts', 'untracked.md']);
    expect(inventory.errors).toEqual([]);
  });

  test('outside a repository it walks the directory, skipping runtime folders, and says so', async () => {
    const root = tempDir('inventory-');
    mkdirSync(join(root, 'src')); mkdirSync(join(root, 'node_modules')); mkdirSync(join(root, '.git'));
    writeFileSync(join(root, 'src/main.ts'), 'm'); writeFileSync(join(root, 'top.md'), 't');
    writeFileSync(join(root, 'node_modules/dep.js'), 'd'); writeFileSync(join(root, '.git/config'), 'c');
    const inventory = await captureReviewInventory(root);
    expect(inventory.source).toBe('filesystem');
    expect(inventory.paths).toEqual(['src/main.ts', 'top.md']);
  });
});

describe('directoryFileCounts', () => {
  test('a short list keeps its directories, with "." for the root', () => {
    expect(directoryFileCounts(['a.ts', 'src/b.ts', 'src/c.ts', 'docs/d.md'])).toEqual([
      { directory: '.', files: 1 }, { directory: 'docs', files: 1 }, { directory: 'src', files: 2 },
    ]);
  });

  test('many directories are folded to the deepest depth that fits, and the rest are summed', () => {
    const paths = Array.from({ length: 100 }, (_, index) => `pkg-${String(index).padStart(3, '0')}/file.ts`);
    const rows = directoryFileCounts(paths);
    expect(rows).toHaveLength(40);
    expect(rows.at(-1)).toMatchObject({ directory: expect.stringContaining('other directories') });
    expect(rows.reduce((sum, row) => sum + row.files, 0)).toBe(100);
  });
});
