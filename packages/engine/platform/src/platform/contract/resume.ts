/**
 * Resume and zombie reaping at startup (docs/design/contract-runner.md
 * section 7.2): `resumeAll()` reads every contract file, and each contract
 * that had not ended either resumes at the step it was on or, when what it
 * needs to resume is gone, is reaped as a zombie.
 *
 * - Zombie: a group the contract marks running or fixing has no loadable
 *   workstream snapshot, or (worktree mode, work under way) the contract
 *   worktree no longer exists. The contract fails with `failureKind: 'zombie'`
 *   and a reason naming what is missing.
 * - Shaping, planning and checking the plan start planning again.
 * - Running and fixing: the contract's engine reloads its workstreams. A unit
 *   whose agent was working gets a fresh agent with its brief and "Previous
 *   checks"; a unit that was held, checked or nudged is checked again with
 *   trigger `resume` over the work its agent left, and the check decides
 *   whether it passes, is nudged through a fresh agent, stalls or goes to the
 *   owner. Until the runner decides, such a unit's phase spawns nothing.
 * - Waiting on the owner stays waiting, its escalation open; the work that
 *   does not wait on the owner resumes.
 * - Judging and committing do those steps again.
 * - The active-contract cap applies: a contract that finds it full waits in
 *   `queued` and resumes from its step when a slot opens. A contract waiting on
 *   its owner keeps the slot it had.
 *
 * A contract another live process already runs is skipped; a process that died
 * left its claim behind and the next one takes it over.
 *
 * Every choice here is code over recorded statuses; nothing is judged. The
 * checks the resumed units get are ordinary unit checks (check.ts).
 */
import { assertContractInputObjects, assertContractInputView, assertContractExecutionView, restoreContractInputDevice } from './input-snapshot.js';
import { withConfiguredDecisionModelPolicy } from '../runtime/decision-policy.js';

import { existsSync } from 'node:fs';
import { selectBaselineExecutionRoot } from './tree-baseline.js';
import { loadWorkstreamSnapshot } from '../orchestration/persistence.js';
import { awaitNativeResumeConditions, nativeDecisionState } from './native-decisions.js';
import { logger } from '../utils/logger.js';
import { queueSessionNudge, type UnitCheckLoop } from './agent-hooks.js';
import { engineItem, type GroupRunner } from './group-runner.js';
import type { ContractRun } from './run-context.js';
import type { ContractStepsWithReplies } from './steps.js';
import type { ContractStore } from './store.js';
import { groupTakesSharedTree, takeSharedTreeForGroup } from './workstreams.js';
import { preserveDeclaredReadReceipts } from './private-read-receipts.js';
import { changedFinalAcceptancePolicy } from './acceptance-policy.js';
import { isPublicationPause, retryPublicationPause } from './escalation.js';
import { rebindOwnedContractSource } from './owned-source.js';
import { isTerminalContractStatus, isTerminalUnitStatus, type Contract, type ContractFailureKind, type ContractStatus, type ContractUnit } from './types.js';

/** The step a resumed contract takes up. */
export type ResumeStep = 'start' | 'shape' | 'plan' | 'run' | 'judge' | 'commit' | 'await-owner';

export interface ResumeReport {
  /** Contracts resumed now, with the step each took up. */
  readonly resumed: readonly { readonly contractId: string; readonly step: ResumeStep }[];
  /** Contracts that found the active-contract cap full and wait in the queue. */
  readonly queued: readonly string[];
  /** Zombies, failed with `failureKind: 'zombie'`. */
  readonly reaped: readonly { readonly contractId: string; readonly reason: string }[];
  /** Contracts already running here or held by the active policy; left as they are. */
  readonly skipped: readonly string[];
}

/** Statuses whose work runs on the contract's engine and in its worktree. */
const WORK_STATUSES: ReadonlySet<ContractStatus> = new Set(['running', 'fixing', 'judging']);
/** Unit statuses whose work item was in its phase: after a restart its phase waits for the runner before spawning. */
const IN_PHASE_UNITS: ReadonlySet<ContractUnit['status']> = new Set(['running', 'checking', 'held', 'nudged', 'fixing', 'awaiting-owner']);
/** Unit statuses whose check already passed: after a restart their phase only settles, it never spawns. */
const CHECKED_UNITS: ReadonlySet<ContractUnit['status']> = new Set(['held-merge', 'passed']);
/** Unit statuses whose agent works in its item's phase: they cannot resume once that item ended without them. */
const WORKING_UNITS: ReadonlySet<ContractUnit['status']> = new Set(['running', 'checking', 'held', 'nudged']);
/** Unit statuses checked again with trigger `resume`. */
const RECHECKED_UNITS: ReadonlySet<ContractUnit['status']> = new Set(['held', 'checking', 'nudged']);

/**
 * The status whose step a contract resumes: its own; for one waiting on its
 * owner, the status it left for the owner; for one queued at a previous
 * resume, the status it waits to return to.
 */
export function resumeStatus(contract: Pick<Contract, 'status' | 'statusBeforeOwner' | 'resumeFrom' | 'groups'>): ContractStatus {
  if (contract.status === 'queued') return contract.resumeFrom ?? 'queued';
  if (contract.status === 'awaiting-owner') return contract.statusBeforeOwner ?? (contract.groups.length > 0 ? 'running' : 'planning');
  return contract.status;
}

export function resumeStepOf(contract: Pick<Contract, 'status' | 'statusBeforeOwner' | 'resumeFrom' | 'groups'>): ResumeStep {
  if (contract.status === 'awaiting-owner') return 'await-owner';
  switch (resumeStatus(contract)) {
    case 'queued': return 'start';
    case 'shaping': return 'shape';
    case 'planning':
    case 'checking-plan': return 'plan';
    case 'judging': return 'judge';
    case 'committing': return 'commit';
    default: return 'run';
  }
}

/**
 * Why a contract cannot resume, or null when it can: a running or fixing
 * group whose workstream snapshot does not load (a corrupt one is quarantined
 * by the load), or, in worktree mode with work under way, a missing contract
 * worktree. A session-mode contract has no engine and no worktree.
 */
export function findZombieCause(contract: Contract): string | null {
  if (contract.isolation === 'worktree') {
    if (contract.inputSnapshot === undefined) {
      if (contract.schemaVersion >= 2 && contract.status === 'queued' && contract.resumeFrom === undefined && contract.shape === undefined) return null;
      return 'no recorded input receipt; legacy or interrupted admission needs manual recovery';
    }
    if (contract.worktreePath === undefined || !existsSync(contract.worktreePath)) return `its contract worktree ${contract.worktreePath ?? '(unrecorded)'} no longer exists`;
    try {
      assertContractInputObjects(contract.inputSnapshot, contract.projectRoot);
      assertContractExecutionView(contract.inputSnapshot, contract.worktreePath!, contract.branch!);
    }
    catch (error) { return `recorded input is unavailable: ${error instanceof Error ? error.message : String(error)}`; }
  }
  if (contract.sessionMode === true) return null;
  const status = resumeStatus(contract);
  if (WORK_STATUSES.has(status) && contract.isolation === 'worktree' && contract.worktreePath !== undefined && !existsSync(contract.worktreePath)) {
    return `its contract worktree ${contract.worktreePath} no longer exists`;
  }
  for (const group of contract.groups) {
    if (group.status !== 'running' && group.status !== 'fixing') continue;
    if (loadWorkstreamSnapshot({ root: contract.projectRoot, namespace: contract.id }, group.id) === null) {
      return `group ${group.id} is ${group.status} but has no loadable workstream snapshot`;
    }
  }
  return null;
}

export interface ContractResumeDeps {
  /** Native owners retain source-less legacy records for inspection only. */
  readonly nativeOnly?: boolean | undefined;
  readonly store: ContractStore;
  /** Whether this runner already runs the contract. */
  readonly isLive: (contractId: string) => boolean;
  /** Takes this process's claim on the contract; false when another live process holds it. */
  readonly claim?: ((contractId: string) => boolean) | undefined;
  /** Makes a loaded contract a run of this runner (not yet holding a slot). */
  readonly adopt: (contract: Contract) => ContractRun;
  /** Whether an active-contract slot is free. */
  readonly hasSlot: () => boolean;
  /** Takes a slot for the run without starting it. */
  readonly takeSlot: (run: ContractRun) => void;
  /** Puts the run at the back of the queue. */
  readonly enqueue: (run: ContractRun) => void;
  readonly fail: (run: ContractRun, kind: ContractFailureKind, reason: string, membersSettled?: boolean) => void;
  /** Fails one unit and, with it, the contract (a failed attempt of a best-of-N unit fails alone). */
  readonly failUnit: (run: ContractRun, unit: ContractUnit, kind: ContractFailureKind, reason: string) => void;
  readonly groups: GroupRunner;
  readonly checks: UnitCheckLoop;
  readonly steps: ContractStepsWithReplies;
  /** Starts a contract from the beginning: shaping, then planning. */
  readonly activate: (run: ContractRun) => Promise<void>;
  /** Plans a shaped contract again from the beginning, then runs the accepted plan. */
  readonly plan: (run: ContractRun) => Promise<void>;
  /** A session-mode unit passed: its group is judged. */
  readonly sessionUnitPassed: (run: ContractRun, unit: ContractUnit) => void;
  readonly ownerProgress: (run: ContractRun) => void;
}

export interface ContractResume {
  /** Applies native historical-wait migration before explicit durable resume chooses its step. */
  prepareNative(run: ContractRun): void;
  resumeAll(): Promise<ResumeReport>;
  /** Takes a resumed contract up at its step; for one that waited in the queue, when its slot opened. */
  continueResumed(run: ContractRun): Promise<void>;
}

export function createContractResume(deps: ContractResumeDeps): ContractResume {
  async function resumeAll(): Promise<ResumeReport> {
    return withConfiguredDecisionModelPolicy(resumeOwned);
  }
  async function resumeOwned(): Promise<ResumeReport> {
    const resumed: { contractId: string; step: ResumeStep }[] = [];
    const queued: string[] = [];
    const reaped: { contractId: string; reason: string }[] = [];
    const skipped: string[] = [];
    const pending: ContractRun[] = [];
    for (const contractId of deps.store.listStoredIds()) {
      if (deps.isLive(contractId)) {
        skipped.push(contractId);
        continue;
      }
      // An ended contract is known from its small summary and stays on disk: its checkpoint is not read.
      if (deps.store.endedSummary(contractId) !== undefined) continue;
      const contract = deps.store.load(contractId);
      if (contract === null) continue;
      if (isTerminalContractStatus(contract.status) && ((deps.nativeOnly === true) !== (contract.nativeSource !== undefined) || contract.durableAdmission !== undefined)) {
        deps.store.noteEnded(contract); continue;
      }
      if ((deps.nativeOnly === true) !== (contract.nativeSource !== undefined)) { deps.store.hold(contract); skipped.push(contractId); continue; }
      // Native authority is never reconstructed from disk. Only resumeDurable may adopt this binding.
      if (contract.durableAdmission !== undefined) { deps.store.hold(contract); skipped.push(contractId); continue; }
      // A terminal verifier failure has already exhausted its operation. Never
      // restart it during startup; recovery requires explicit owner action.
      if (isTerminalContractStatus(contract.status)) {
        deps.store.noteEnded(contract);
        continue;
      }
      if (contract.inputSnapshot !== undefined) {
        try {
          contract.inputSnapshot = await restoreContractInputDevice(contract.inputSnapshot);
        } catch (error) {
          // Do not spawn workers with an invalid input lease, or discard their
          // retained work merely because this startup could not verify it.
          deps.store.hold(contract);
          skipped.push(contractId);
          logger.warn('contract runner: input recovery held', { contractId, error: error instanceof Error ? error.message : String(error) });
          continue;
        }
      }
      // A contract another live process runs is its to continue; two runners over one contract would both drive it.
      if (deps.claim !== undefined && !deps.claim(contractId)) {
        deps.store.hold(contract);
        skipped.push(contractId);
        logger.info('contract runner: contract is run by another process, left to it', { contractId });
        continue;
      }
      const run = deps.adopt(contract);
      try {
        prepareResume(run);
      } catch (error) {
        // One contract whose saved state cannot be migrated must not stop the others from resuming.
        const reason = `contract ${contract.id} could not resume: ${error instanceof Error ? error.message : String(error)}`;
        run.decide('reaped', contract.id, reason);
        deps.fail(run, 'zombie', reason, true);
        reaped.push({ contractId, reason });
        continue;
      }
      const zombie = findZombieCause(contract);
      if (zombie !== null) {
        const reason = `contract ${contract.id} could not resume: ${zombie}`;
        run.decide('reaped', contract.id, reason);
        deps.fail(run, 'zombie', reason, true);
        reaped.push({ contractId, reason });
        continue;
      }
      pending.push(run);
    }
    // A contract waiting on its owner keeps the slot it had; the rest take slots oldest first.
    const ordered = [
      ...pending.filter((run) => run.contract.status === 'awaiting-owner'),
      ...pending.filter((run) => run.contract.status !== 'awaiting-owner').sort((a, b) => a.contract.createdAt - b.contract.createdAt),
    ];
    const continuations: Promise<void>[] = [];
    for (const run of ordered) {
      const step = resumeStepOf(run.contract);
      if (step !== 'await-owner' && !deps.hasSlot()) {
        if (run.contract.status !== 'queued') {
          run.contract.resumeFrom = run.contract.status;
          run.moveContract('queued');
        }
        run.decide('queued', run.id, `resumed after a restart; ${step === 'start' ? 'waiting' : `waiting to resume ${run.contract.resumeFrom ?? 'its work'}`} for an active-contract slot`);
        deps.enqueue(run);
        queued.push(run.id);
        continue;
      }
      deps.takeSlot(run);
      resumed.push({ contractId: run.id, step });
      // Continuing can run a whole shaping, planning or work step (model calls). Start it without waiting, so the contracts
      // after this one get their slot and their resume now; the report still waits for all of them below.
      const continuing = run.work.run('continue resumed', () => continueResumed(run));
      if (run.contract.nativeSource === undefined) continuations.push(continuing);
      else void continuing;
    }
    // Legacy continuations settle here as before (the host drains recovery through this call); each ends its own contract on failure.
    await Promise.all(continuations);
    logger.info('contract runner: resumed contracts from disk', { resumed: resumed.length, queued: queued.length, reaped: reaped.length, skipped: skipped.length });
    return { resumed, queued, reaped, skipped };
  }

  function prepareResume(run: ContractRun): void {
    const contract = run.contract;
    preserveDeclaredReadReceipts(contract);
    // Unattended work's contract keeps its saved source as the fixed root.
    rebindOwnedContractSource(contract);
    // A result that could not be published is published again on resume: the owner was told resume retries it.
    const pause = contract.escalations.find(isPublicationPause);
    if (pause !== undefined && contract.status === 'awaiting-owner' && retryPublicationPause(run, pause, 'retried on resume')) {
      run.moveContract('committing');
      deps.store.put(contract);
      return;
    }
    if (contract.nativeSource === undefined) {
      const pending = contract.escalations.filter(item => item.resolvedAt === undefined);
      if (contract.status === 'awaiting-owner' && contract.units.length > 0 && contract.units.every(unit => unit.status === 'passed')
        && contract.groups.length > 0 && contract.groups.every(group => group.status === 'passed') && pending.length > 0
        && pending.every(item => item.scope === 'deliverable' && item.targetId === contract.id && ['stalled', 'unsettled', 'fix-rounds-exhausted'].includes(item.reason))
        && changedFinalAcceptancePolicy(contract, run.env.config().acceptanceStakes)) {
        // The old checker question is superseded, not answered or approved.
        // Re-run the retained result under the new policy with the same scope.
        for (const item of pending) item.resolvedAt = run.env.now();
        contract.statusBeforeOwner = undefined;
        run.moveContract('judging');
        run.decide('resumed', contract.id, 'Retired the obsolete final-check question after an acceptance-policy change; retained work requires fresh original-requirement and content checks before publication. No owner approval was inferred.');
        deps.store.put(contract);
      }
      if (contract.status === 'awaiting-owner' && contract.units.length === 0 && pending.length > 0
        && pending.every(item => item.scope === 'shape' && item.reason === 'writing-unclear')) {
        // The old shaping question is no longer a prerequisite for planning.
        // Preserve its history without inventing an owner reply or permission to edit.
        for (const item of pending) item.resolvedAt = run.env.now();
        contract.statusBeforeOwner = undefined;
        run.moveContract('planning');
        run.decide('resumed', contract.id, 'Retired writing-unclear question; planning continues from the original request');
        deps.store.put(contract);
      }
      return;
    }
    contract.nativeWaiting = undefined;
    const state = nativeDecisionState(contract);
    if (contract.status !== 'awaiting-owner') return;
    // A failure pause is not a historical approval wait: it stays open so the owner can still retry or cancel.
    if (contract.escalations.some(item => item.resolvedAt === undefined && item.failurePause === true)) return;
    const old = contract.escalations.filter(item => item.resolvedAt === undefined);
    const plan = old.find(item => item.scope === 'plan');
    if (plan !== undefined) {
      state.plannerOutputs.plan ??= plan.question;
      // The planner's own runs; a fix planner's saved candidates are planned decisions under their own targets.
      state.spent.plan = Math.max(state.spent.plan ?? 0, contract.decisions.filter(item => item.action === 'planned' && item.targetId === contract.id).length);
    }
    // awaiting-owner cannot return to shaping; the plan step shapes again when no shape was settled.
    const next = old.some(item => item.scope === 'shape' || item.scope === 'plan') ? 'planning' : contract.statusBeforeOwner ?? 'running';
    run.moveContract(next); contract.statusBeforeOwner = undefined;
    for (const unit of contract.units) if (unit.status === 'awaiting-owner') run.moveUnit(unit, 'checking');
    for (const group of contract.groups) if (group.status === 'awaiting-owner') run.moveGroup(group, 'judging');
    run.decide('resumed', contract.id, 'Historical owner wait retained for inspection; native continuation requires fresh evidence and a fresh Jev decision');
    deps.store.put(contract);
  }

  async function continueResumed(run: ContractRun): Promise<void> {
    return withConfiguredDecisionModelPolicy(() => continueOwnedResumed(run));
  }
  async function continueOwnedResumed(run: ContractRun): Promise<void> {
    const { contract } = run;
    const step = resumeStepOf(contract);
    const from = resumeStatus(contract);
    try {
      // Inside the try: a refusal here must end the contract (and free its slot), not reject unseen.
      run.abort.signal.throwIfAborted();
      contract.resumeFrom = undefined;
      if (contract.inputSnapshot !== undefined) await assertContractInputView(contract.inputSnapshot, run.abort.signal);
      await awaitNativeResumeConditions(contract, run.env.native, run.abort.signal);
      switch (step) {
        case 'start':
          await deps.activate(run);
          return;
        case 'shape':
          run.decide('resumed', contract.id, 'resumed after a restart while shaping: shaping starts again');
          await deps.activate(run);
          return;
        case 'plan':
          run.decide('resumed', contract.id, `resumed after a restart in ${from}: planning starts again from the beginning`);
          if (contract.shape === undefined) {
            // Shaping can only start from a queued contract, and a record saved without its shape was left in planning.
            if (contract.status === 'planning') run.moveContract('queued');
            await deps.activate(run);
          } else await deps.plan(run);
          return;
        case 'commit':
          run.decide('resumed', contract.id, 'resumed after a restart while committing: the commit runs again');
          await deps.steps.commitDeliverable(run);
          return;
        default:
          await resumeWork(run, step, from);
      }
    } catch (error) {
      if (run.terminal) return;
      deps.fail(run, 'other', `contract ${contract.id} could not resume: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Running, fixing, judging, or waiting on the owner with work under way. */
  async function resumeWork(run: ContractRun, step: ResumeStep, from: ContractStatus): Promise<void> {
    const { contract } = run;
    const started = WORK_STATUSES.has(from);
    run.decide('resumed', contract.id, step === 'await-owner'
      ? `resumed after a restart waiting on the owner; ${started ? 'the work that does not wait on the owner resumes' : 'nothing runs until the owner replies'}`
      : `resumed after a restart in ${from}`);
    if (!started) {
      deps.ownerProgress(run);
      return;
    }
    if (contract.sessionMode === true) {
      // The session's turns write in the shared tree: take its lock again before they can.
      await takeSharedTreeForGroup(run, 'session');
      if (run.terminal) return;
      resumeSession(run);
    } else await resumeEngine(run);
    if (run.terminal) return;
    await deps.steps.resumeNative(run);
    if (run.terminal) return;
    if (contract.status === 'queued') run.moveContract(from);
    for (const group of contract.groups) {
      if (group.status === 'judging') void deps.steps.judgeGroup(run, group.id, 'resume');
      if (group.status !== 'running') continue;
      const units = contract.units.filter((unit) => unit.groupId === group.id);
      const last = units.at(-1);
      if (last === undefined || !units.every((unit) => unit.status === 'passed')) continue;
      if (contract.sessionMode === true) deps.sessionUnitPassed(run, last);
      else deps.groups.unitPassed(run, last);
    }
    if (contract.sessionMode !== true) deps.groups.startReadyGroups(run);
    const allPassed = contract.groups.length > 0 && contract.groups.every((group) => group.status === 'passed');
    if (step === 'judge' || (step === 'run' && from === 'running' && allPassed)) void deps.steps.judgeDeliverable(run, 'resume');
    deps.ownerProgress(run);
  }

  /** The engine reloads the contract's workstreams; each unit takes up its step. */
  async function resumeEngine(run: ContractRun): Promise<void> {
    const { contract } = run;
    // Shared mode: a group that was running held the shared tree; it takes the tree again before anything runs in it.
    for (const group of contract.groups) {
      if ((group.status !== 'running' && group.status !== 'fixing') || !groupTakesSharedTree(contract, group)) continue;
      await takeSharedTreeForGroup(run, group.id);
      if (run.terminal) return;
    }
    // Before the engine can claim anything: every unit whose item was in its phase waits for the runner,
    // and a unit whose check passed before the restart settles its phase without a fresh agent.
    for (const unit of run.allUnits()) {
      if (unit.attemptUnits !== undefined) continue;
      if (IN_PHASE_UNITS.has(unit.status)) {
        const runtime = run.runtime(unit);
        runtime.preSpawn = 'wait';
        runtime.agentLost = true;
      } else if (CHECKED_UNITS.has(unit.status)) {
        run.runtime(unit).preSpawn = { kind: 'settled', outcome: 'completed' };
      }
    }
    deps.groups.resumeEngine(run);
    for (const unit of run.allUnits()) {
      const runtime = run.runtime(unit);
      const item = engineItem(run, unit.id);
      // An item that already left its phase (a unit's work merged for a planned fix) runs no phase to wait on.
      const leftPhase = item === undefined || item.state === 'passed' || item.state === 'failed' || item.state === 'held-merge';
      if (leftPhase && runtime.preSpawn !== null && runtime.preSpawn !== 'wait' && CHECKED_UNITS.has(unit.status)) runtime.preSpawn = null;
      if (isTerminalUnitStatus(unit.status)) continue;
      if (leftPhase && WORKING_UNITS.has(unit.status) && unit.attemptUnits === undefined && (item === undefined || item.state === 'failed')) {
        // The two checkpoints disagree after a crash: the unit's work item ended without it, so nothing would ever run or settle it.
        runtime.preSpawn = null;
        deps.failUnit(run, unit, 'other', `unit ${unit.id} could not resume: its work item ${item === undefined ? 'is missing from the workstream snapshot' : `failed${item.failureReason === undefined ? '' : ` (${item.failureReason})`}`}`);
        if (run.terminal) return;
        continue;
      }
      if (runtime.preSpawn === 'wait' && leftPhase) runtime.preSpawn = null;
      runtime.cwd = item?.worktreePath ?? contract.worktreePath ?? contract.projectRoot;
      selectBaselineExecutionRoot(unit.baseline, runtime.cwd);
      if (unit.attemptUnits !== undefined) {
        // A best-of-N unit: a selection that did not finish is read again.
        if (unit.status === 'checking') deps.groups.selectAttempts(run, unit.id);
        else deps.groups.reconcileMerged(run, unit);
        continue;
      }
      if (unit.status === 'running' && run.spawnWaits(unit)) {
        deps.groups.requeueUnit(run, unit, `resumed after a restart: agent ${unit.activeAgentId ?? '(none)'} did not survive it, so a fresh agent takes the unit with its brief and previous checks`, 'resume');
      } else if (RECHECKED_UNITS.has(unit.status)) {
        void deps.checks.runCheck(run, unit, 'resume', unit.lastOutput ?? '');
      } else if (unit.status === 'held-merge') {
        deps.groups.reconcileMerged(run, unit);
      }
    }
  }

  /** Session mode: no engine; the unit waits for the session's next turn, or is checked again. */
  function resumeSession(run: ContractRun): void {
    const { contract } = run;
    for (const unit of contract.units) {
      if (isTerminalUnitStatus(unit.status)) continue;
      const runtime = run.runtime(unit);
      runtime.agentLost = true;
      runtime.cwd = contract.projectRoot;
      selectBaselineExecutionRoot(unit.baseline, runtime.cwd);
      if (unit.status === 'held' || unit.status === 'checking') {
        void deps.checks.runCheck(run, unit, 'resume', unit.lastOutput ?? '');
      } else if (unit.status === 'nudged') {
        // The nudge that waited for the session's next turn did not survive; it waits again.
        const nudge = unit.nudges.at(-1);
        if (nudge !== undefined && nudge.consumedAt === undefined) queueSessionNudge(run, unit, nudge.text, nudge.id);
      }
    }
  }

  return { resumeAll, continueResumed, prepareNative: prepareResume };
}
