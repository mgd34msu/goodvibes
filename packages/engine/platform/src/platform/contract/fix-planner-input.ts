import { createContractInputAuthority, assertContractInputAdmission, revokeContractInputAuthority, type ContractInputAuthority } from './input-authority.js';
/** A corrective planner reads produced contract work, frozen independently of the live owner tree. */
import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { IsolatedWorktree } from '../agents/worktree.js';
import { writeFileAtomic } from '../utils/atomic-json-store.js';
import { logger } from '../utils/logger.js';
import { assertContractExecutionView, assertContractInputObjects, captureContractInput, materializeContractInput, prepareContractInputParent } from './input-snapshot.js';
import type { ContractRun } from './run-context.js';

export interface FixPlannerInput {
  readonly authority?: ContractInputAuthority | undefined;
  readonly workingDirectory: string;
  readonly resultRevision?: string;
  /**
   * Discard the plan if the contract's result moved while it was planned: one
   * `git rev-parse HEAD` of the result branch, before planning and before a
   * plan is accepted. The planner's own reads are checked by its view's
   * authority (batched, each file verified once).
   */
  assertCurrent(): Promise<void>;
  /** Removes the planner's checkout and branch; safe to call more than once. */
  dispose(): Promise<void>;
}

/**
 * Each fix round writes a receipt of the result view its planner read. Only the
 * newest one of a contract is kept, so repeated rounds do not accumulate
 * receipts that each embed a full input snapshot.
 */
export function pruneOlderPlannerReceipts(receiptPath: string, contractId: string): void {
  const directory = dirname(receiptPath);
  let names: string[];
  try { names = readdirSync(directory); } catch { return; }
  for (const name of names) {
    const path = join(directory, name);
    if (path === receiptPath || !name.startsWith(`${contractId}-`) || !name.endsWith('.json')) continue;
    try { rmSync(path, { force: true }); } catch { /* A receipt that cannot be removed now is removed by the next round. */ }
  }
}

function head(cwd: string): string | null {
  const result = spawnSync('git', ['-C', cwd, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf-8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * The planner's view is a throwaway checkout of one captured commit: its
 * directory and branch are removed outright (`--force`, `-D`), since nothing
 * is ever written there that is not also on the contract's own branch.
 */
function removePlannerView(gitDir: string, workingDirectory: string, branch: string): void {
  const worktree = spawnSync('git', ['-C', gitDir, 'worktree', 'remove', '--force', workingDirectory], { encoding: 'utf-8' });
  if (worktree.status !== 0) rmSync(workingDirectory, { recursive: true, force: true });
  spawnSync('git', ['-C', gitDir, 'worktree', 'prune'], { encoding: 'utf-8' });
  const deleted = spawnSync('git', ['-C', gitDir, 'branch', '-D', branch], { encoding: 'utf-8' });
  if (deleted.status !== 0 && !/not found/.test(deleted.stderr ?? '')) {
    logger.warn('contract fix planner: its view branch was not removed', { branch, error: (deleted.stderr ?? '').trim() });
  }
}

/** Shared/session execution retains its explicit live-tree semantics. */
export async function prepareFixPlannerInput(run: ContractRun): Promise<FixPlannerInput> {
  const { contract } = run;
  const signal = run.abort.signal;
  signal.throwIfAborted();
  const source = contract.worktreePath ?? contract.projectRoot;
  if (contract.isolation !== 'worktree') return { workingDirectory: source, assertCurrent: async () => { signal.throwIfAborted(); }, dispose: async () => {} };
  const original = contract.inputSnapshot;
  if (original === undefined || contract.branch === undefined) throw new Error('fix planning has no recorded contract input; manual recovery is required');
  assertContractInputAdmission(contract);
  assertContractInputObjects(original, contract.projectRoot);
  assertContractExecutionView(original, source, contract.branch);
  const resultHead = head(source);
  if (resultHead === null) throw new Error(`fix planning could not read the head of the contract's result branch ${contract.branch}`);
  const current = await captureContractInput(source, { signal });
  // Named after the contract as well as the view, so a leftover after a crash is attributed to its contract by the retention sweep.
  const name = `${contract.id}-${current.id}`;
  const workingDirectory = join(original.sourceRoot, '.goodvibes', '.worktrees', 'contract-planner', name);
  const branch = `contract-planner/${name}`;
  const receiptPath = join(original.sourceRoot, '.goodvibes', 'contracts', 'planner-input', `${name}.json`);
  await prepareContractInputParent(original, workingDirectory);
  await prepareContractInputParent(original, receiptPath);
  signal.throwIfAborted();
  // Keep the original admission receipt unchanged: apply-back is always checked against that owner generation.
  writeFileAtomic(receiptPath, JSON.stringify({ version: 1, purpose: 'fix', contractId: contract.id, originalInputId: original.id, workingDirectory, snapshot: current }));
  pruneOlderPlannerReceipts(receiptPath, contract.id);
  let authority: ContractInputAuthority | undefined;
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    if (authority !== undefined) {
      try { revokeContractInputAuthority(authority); } catch { /* Already revoked with the contract's signal. */ }
    }
    removePlannerView(source, workingDirectory, branch);
  };
  try {
    await new IsolatedWorktree(source, workingDirectory, branch, contract.branch).create(current.inputCommit, false);
    await materializeContractInput(current, workingDirectory, signal);
    run.decide('created', contract.id, `fix planner admitted result view ${current.id} at ${current.inputCommit}; original input ${original.id}`);
    const assertCurrent = async (): Promise<void> => {
      signal.throwIfAborted();
      assertContractInputAdmission(contract);
      if (head(source) !== resultHead) throw new Error(`contract result changed during fix planning: branch ${contract.branch} moved from ${resultHead}`);
    };
    // The view is one captured commit: the default view assertion is batchable and verifies each file once.
    authority = await createContractInputAuthority(contract, workingDirectory, { signal, snapshot: current });
    return { workingDirectory, resultRevision: current.inputCommit, assertCurrent, authority, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
