/**
 * How a contract runs on the orchestration engine (docs/design/contract-runner.md
 * sections 6.1, 7.3 and 7.4): one engine per contract, one workstream per
 * group (the group id is the workstream id), one work item per unit (the unit
 * id is the item id).
 *
 * A group's workstream has one engineer phase. Its capacity is
 * `contract.maxParallelUnits` in worktree mode and 1 in shared mode, and every
 * group is elastic (`releasePolicy: 'reviewed-and-merged'`), so units across
 * all contracts are bounded by the fleet ceiling and a dependent unit starts
 * only after its dependency passed and merged.
 *
 * Shared mode also takes one lock per working tree for the time a group works
 * (and a session-mode contract for its whole run), so one contract at a time
 * changes a shared working tree, across every process on the machine: a unit's
 * diff against its baseline is exactly its own, and its gates never see
 * another unit's half-finished edits. The lock is a kernel-released lock file
 * (utils/process-lock.ts) under `.goodvibes/contracts/`; its holder writes who
 * it is beside it, so a waiting contract can say what it waits for. A group
 * that waits for its owner's answer gives the tree up and takes it again when
 * the answer comes.
 */
import { readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { acquireProcessLock, holdProcessLock, ProcessLockBusyError, type HeldProcessLock } from '../utils/process-lock.js';
import { writeDocument } from '../utils/atomic-json-store.js';
import type { CreateWorkstreamInput } from '../orchestration/engine.js';
import type { BudgetCeiling, PhaseSpec, WorkItemSpec, WorkItemUsage } from '../orchestration/types.js';
import { briefWithPreviousChecks, buildUnitBrief } from './brief.js';
import type { ContractConfig } from './config.js';
import { unitToolContract } from './plan-schema.js';
import { UNIT_SELF_CHECK_TOOL } from './self-check.js';
import type { ContractRun } from './run-context.js';
import type { Contract, ContractGroup, ContractUnit, UnitRole } from './types.js';

/** The agent archetype for a unit's role. A design unit runs as a general agent held read-only by its tool contract. */
export function unitTemplate(role: UnitRole): 'engineer' | 'integrator' | 'researcher' | 'general' {
  if (role === 'implement') return 'engineer';
  if (role === 'integration') return 'integrator';
  if (role === 'research') return 'researcher';
  return 'general';
}

/** Units that may run at once in one group: 1 in shared mode, `contract.maxParallelUnits` in worktree mode. */
export function phaseCapacity(contract: Pick<Contract, 'isolation'>, config: Pick<ContractConfig, 'maxParallelUnits'>): number {
  return contract.isolation === 'shared' ? 1 : Math.max(1, config.maxParallelUnits);
}

/**
 * The one phase every group runs. In worktree mode the phase commits the
 * unit's whole item worktree onto its item branch when the unit passed (the
 * worktree holds only that unit's work), which is what the engine's
 * integration lane then merges into the contract branch. In shared mode it
 * commits nothing: the contract commits its touched paths when the
 * deliverable passes.
 */
export function unitPhases(isolation: Contract['isolation'], capacity: number): PhaseSpec[] {
  return [{ role: 'engineer', capacity, kind: 'engineer', gate: { scope: isolation === 'worktree' ? 'all' : 'off', gates: [] } }];
}

/** What remains of a ceiling after `used`, or undefined when there is no ceiling. Money and token arithmetic, in code. */
export function remainingBudget(ceiling: BudgetCeiling | undefined, used: WorkItemUsage): BudgetCeiling | undefined {
  if (ceiling === undefined) return undefined;
  const tokens = used.inputTokens + used.outputTokens;
  return {
    ...(ceiling.maxTokens === undefined ? {} : { maxTokens: Math.max(0, ceiling.maxTokens - tokens) }),
    ...(ceiling.maxCostUsd === undefined ? {} : { maxCostUsd: Math.max(0, ceiling.maxCostUsd - (used.costUsd ?? 0)) }),
  };
}

/** The work item for one unit: its brief (with "Previous checks" once it was checked), route, tool contract and binding. */
export function unitWorkItem(contract: Contract, group: ContractGroup, unit: ContractUnit): WorkItemSpec {
  if (contract.shape === undefined) throw new Error(`contract ${contract.id} has no request shape`);
  // A unit runs its own agent, or (best-of-N in worktree mode) one agent per attempt; each is routed before it spawns.
  for (const routed of unit.attemptUnits ?? [unit]) {
    if (routed.route === undefined) throw new Error(`unit ${routed.id} has no route; the route selector must pick one before its agent is spawned`);
  }
  const tools = unitToolContract(unit.role, contract.shape);
  const groupUnitIds = new Set(group.unitIds);
  return {
    id: unit.id,
    title: unit.title,
    task: briefWithPreviousChecks(buildUnitBrief(contract, group, unit), unit),
    dependsOn: unit.dependsOn.filter((id) => groupUnitIds.has(id)),
    contractId: contract.id,
    contractUnitId: unit.id,
    ...(unit.route === undefined ? {} : { route: unit.route }),
    // A unit's agent can always read how its own criteria read; the name only takes effect where the tool is registered.
    // A unit that changes the project has its project's tool servers and checklist too, inside the copy it works in
    // (agents/orchestrator.ts capturedStepProject); a read-only unit's list stays its own.
    tools: [...(tools.tools ?? []), UNIT_SELF_CHECK_TOOL, ...(tools.readOnly ? [] : ['mcp', 'work_plan'])],
    restrictTools: tools.restrictTools,
    template: unitTemplate(unit.role),
    files: [...unit.files],
    ...(unit.attempts > 1 ? { attempts: unit.attempts, autoAcceptWinner: false } : {}),
    ...(unit.attemptUnits === undefined ? {} : { attemptRoutes: unit.attemptUnits.map((attempt) => attempt.route) }),
  };
}

/** The workstream that runs one group. `used` is the contract's usage so far, for the remaining budget. */
export function groupWorkstreamInput(
  contract: Contract,
  group: ContractGroup,
  config: Pick<ContractConfig, 'maxParallelUnits'>,
  used: WorkItemUsage,
): CreateWorkstreamInput {
  const units = group.unitIds.map((unitId) => {
    const unit = contract.units.find((candidate) => candidate.id === unitId);
    if (unit === undefined) throw new Error(`group ${group.id} names unit ${unitId}, which the contract does not have`);
    return unit;
  });
  const budget = remainingBudget(contract.budget, used);
  return {
    id: group.id,
    title: group.title,
    phases: unitPhases(contract.isolation, phaseCapacity(contract, config)),
    items: units.map((unit) => unitWorkItem(contract, group, unit)),
    ...(budget === undefined ? {} : { budget }),
    isolation: contract.isolation,
    releasePolicy: 'reviewed-and-merged',
  };
}

// ── The shared-tree lock (design 6.1) ─────────────────────────────────────────

/** Who holds a shared working tree: written beside the lock by its holder. */
export interface SharedTreeHolder {
  readonly contractId: string;
  /** The group working in the tree, or `session` for a session-mode contract. */
  readonly groupId: string;
  readonly pid: number;
}

function treeKey(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}

function sharedTreeLockPath(root: string): string {
  return join(treeKey(root), '.goodvibes', 'contracts', '.shared-tree.writer.sqlite');
}

function holderPath(root: string): string {
  return join(treeKey(root), '.goodvibes', 'contracts', '.shared-tree.holder.json');
}

function parseHolder(value: unknown): SharedTreeHolder {
  const record = value as Partial<SharedTreeHolder> | null;
  if (record === null || typeof record !== 'object' || typeof record.contractId !== 'string' || typeof record.groupId !== 'string' || typeof record.pid !== 'number') throw new Error('not a holder record');
  return { contractId: record.contractId, groupId: record.groupId, pid: record.pid };
}

/** Who holds the tree now, as its holder recorded it; undefined when nothing says. */
export function sharedTreeHolder(root: string): SharedTreeHolder | undefined {
  try {
    return parseHolder(JSON.parse(readFileSync(holderPath(root), 'utf8')));
  } catch {
    return undefined;
  }
}

/** The longest one wait timer can run; a waiter whose turn has not come by then simply waits again. */
const LONGEST_WAIT_MS = 2_147_483_647;

/** Holders and waiters per tree in this process, for status. */
const inProcess = new Map<string, number>();

function count(key: string, by: number): void {
  const next = (inProcess.get(key) ?? 0) + by;
  if (next <= 0) inProcess.delete(key); else inProcess.set(key, next);
}

/** What a waiting caller is told: who holds the tree, when that is known. */
export function describeSharedTreeWait(holder: SharedTreeHolder | undefined): string {
  if (holder === undefined) return 'waiting for the shared working tree, which another contract is changing';
  const by = holder.groupId === 'session' ? `contract ${holder.contractId} (session mode)` : `contract ${holder.contractId} group ${holder.groupId}`;
  return `waiting for the shared working tree, held by ${by}${holder.pid === process.pid ? '' : ` in process ${holder.pid}`}`;
}

async function takeTreeLock(path: string, root: string, options: { readonly signal?: AbortSignal | undefined; readonly onWait?: ((heldBy: SharedTreeHolder | undefined) => void) | undefined }): Promise<HeldProcessLock> {
  const free = holdProcessLock(path);
  if (free !== null) return free;
  options.onWait?.(sharedTreeHolder(root));
  for (;;) {
    try { return await acquireProcessLock(path, { waitMs: LONGEST_WAIT_MS, ...(options.signal === undefined ? {} : { signal: options.signal }) }); }
    catch (error) { if (!(error instanceof ProcessLockBusyError)) throw error; }
  }
}

/**
 * Takes the lock on a shared working tree, for every process on the machine.
 * Resolves with the release function once the caller holds it; release is
 * idempotent. When the tree is held, `onWait` is called once with the holder
 * before the wait starts. `signal` withdraws a caller still waiting (the
 * promise then rejects with the signal's reason). Cost: one open and two
 * statements when free, one small holder write per acquisition.
 */
export async function acquireSharedTree(root: string, holder: { readonly contractId: string; readonly groupId: string }, options: {
  readonly signal?: AbortSignal | undefined;
  readonly onWait?: ((heldBy: SharedTreeHolder | undefined) => void) | undefined;
} = {}): Promise<() => void> {
  const key = treeKey(root);
  const path = sharedTreeLockPath(root);
  options.signal?.throwIfAborted();
  count(key, 1);
  let held: HeldProcessLock;
  try {
    held = await takeTreeLock(path, root, options);
  } catch (error) {
    count(key, -1);
    throw error;
  }
  try { writeDocument(holderPath(root), { contractId: holder.contractId, groupId: holder.groupId, pid: process.pid }); }
  catch { /* The holder note only names the holder for waiters; the lock is what excludes them. */ }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // The note goes before the lock, so it never removes the next holder's.
    try { unlinkSync(holderPath(root)); } catch { /* already gone */ }
    held.release();
    count(key, -1);
  };
}

/** How many callers in this process hold or wait for a shared tree (status). */
export function sharedTreeWaiters(root: string): number {
  return inProcess.get(treeKey(root)) ?? 0;
}

/** Records that a group waits for the tree: one decision and the contract's status line. */
export function noteSharedTreeWait(run: ContractRun, groupId: string, holder: SharedTreeHolder | undefined): void {
  const line = describeSharedTreeWait(holder);
  run.decide('queued', groupId, line);
  run.contract.statusLine = `Contract ${run.id}: ${line}`;
}

/** Clears the waiting line once the tree is held. */
export function clearSharedTreeWait(run: ContractRun): void {
  if (run.contract.statusLine?.includes('waiting for the shared working tree') === true) run.contract.statusLine = undefined;
}

/** Takes the tree for a group of a shared-mode contract, recording a wait when another holder has it. */
export async function takeSharedTreeForGroup(run: ContractRun, groupId: string): Promise<void> {
  const release = await acquireSharedTree(run.contract.projectRoot, { contractId: run.id, groupId }, {
    signal: run.abort.signal,
    onWait: (holder) => noteSharedTreeWait(run, groupId, holder),
  });
  if (run.terminal) { release(); return; }
  run.sharedTreeReleases.get(groupId)?.();
  run.sharedTreeReleases.set(groupId, release);
  clearSharedTreeWait(run);
}

/** Whether a group takes the shared tree itself: a shared-mode group that is not a fix running inside the unit's own group. */
export function groupTakesSharedTree(contract: Contract, group: ContractGroup): boolean {
  return contract.isolation === 'shared' && contract.sessionMode !== true && !(group.kind === 'fix' && group.repairs?.scope === 'unit');
}

/** Unit states in which nothing of the unit can change the tree. */
const IDLE_UNIT_STATUSES: ReadonlySet<ContractUnit['status']> = new Set(['pending', 'blocked', 'awaiting-owner', 'held-merge', 'passed', 'failed', 'cancelled']);

/**
 * A unit or group now waits for its owner: the group gives the shared tree up
 * so other contracts are not held behind the question, unless another of its
 * units is still working in the tree (it then keeps it until the group ends).
 */
export function releaseSharedTreeForOwner(run: ContractRun, groupId: string): void {
  const release = run.sharedTreeReleases.get(groupId);
  if (release === undefined) return;
  if (run.contract.units.some((unit) => unit.groupId === groupId && !IDLE_UNIT_STATUSES.has(unit.status))) return;
  run.sharedTreeReleases.delete(groupId);
  release();
}

/**
 * The owner answered a unit's question: its group takes the tree again before
 * the unit works on (also after a restart, when the group never retook it).
 */
export async function retakeSharedTreeAfterOwner(run: ContractRun, groupId: string): Promise<void> {
  const group = run.group(groupId);
  if (group === undefined || run.terminal || !groupTakesSharedTree(run.contract, group) || run.sharedTreeReleases.has(groupId)) return;
  if (group.status === 'passed' || group.status === 'failed' || group.status === 'cancelled' || group.status === 'pending' || group.status === 'blocked') return;
  await takeSharedTreeForGroup(run, groupId);
}
