import { captureAutonomousSource, retainAutonomousSource } from '../permissions/autonomous.js';
import { assertNeverObserved, RefusalError, refusal } from '@goodvibes-jev/engine/errors';
import { assertSynchronousJudgmentGuard } from '@goodvibes-jev/judgment/decisions';
import { getContractActionSource, getContractActionSignal } from '../tools/agent/contract-binding.js';
import { bindOwnedContractSource, assertOwnedContractSource } from './owned-source.js';
import { pinContractInputAdmission } from './input-authority.js';
import { inspectContractIntegration } from './integration-inspection.js';
import { briefWithPreviousChecks, buildUnitBrief } from './brief.js';
import type { ContractIntegrationInspection } from './integration-inspection-wire.js';
/**
 * The contract runner (docs/design/contract-runner.md sections 1, 2.2, 6.5
 * and 7.3): `createContractRunner(deps)` owns every contract's lifecycle.
 *
 * - `start` resolves repository placement without blocking the host, then
 *   creates the contract and its owner record (the record parents and
 *   surfaces wait on; it runs no model). The contract is
 *   shaped and planned (planner.ts), then its groups run on one orchestration
 *   engine per contract (group-runner.ts) with the full nudge loop
 *   (agent-hooks.ts, unit-failures.ts).
 * - At most `contract.maxActiveContracts` contracts are past `queued`; the
 *   rest wait in a FIFO queue and the oldest starts whenever one ends. A
 *   contract awaiting its owner keeps its slot.
 * - A contract ends passed, failed or cancelled. The owner record ends with
 *   it: its status, answer (`fullOutput`), status line (operator audience
 *   only), usage and tool-call totals are the contract's.
 *
 * Group and deliverable judging, stall routing, owner escalations and the
 * commit are the correction and completion steps (steps.ts). The owner's
 * replies to escalations arrive through `reply`.
 *
 * Session mode: when the user forbids delegation, the contract's
 * one unit is done by the session's own turns (the core turn loop binds its
 * turn to the unit and is held and nudged exactly as a sub-agent is); no
 * engine runs and no sub-agent is spawned.
 */
import { assertDurableCheckpoint, DurableContractAdmissions, DurableContractAdmissionError, freezeDurableKey, durableKeyIdentity, durablePayloadRevision, sameDurableRequest, freezeDurableRequest, parseDurableAdmission, type DurableContractAdmission, type DurableContractBoundary, type DurableContractKey, type DurableContractRequest, type DurableStartedContract } from './durable-admission.js';
import { resolveContractGitPlacement, resolveContractIsolation, resolveContractBase } from './git-placement.js';
import { existsSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import type { ContractEvent } from '../../events/contract.js';
import type { AgentMessageBus } from '../agents/message-bus.js';
import { setAgentProgress } from '../agents/progress-audience.js';
import { IsolatedWorktree } from '../agents/worktree.js';
import type { DecompositionRunner } from '../core/plan-decomposition.js';
import type { OrchestrationEngine } from '../orchestration/engine.js';
import type { FleetCapacityFn } from '../orchestration/elastic-pool.js';
import type { ContractPreSpawn, ContractUnitOutcome, ContractUnitSettlement } from '../orchestration/phase-runner.js';
import { emptyWorkItemUsage, type BudgetCeiling, type PriceProvenanceFn, type WorkItem } from '../orchestration/types.js';
import { emitAgentCancelled, emitAgentCompleted, emitAgentFailed } from '../runtime/emitters/index.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { AgentManager, AgentRecord } from '../tools/agent/index.js';
import { startContractOwner, bindContractActionSignal } from '../tools/agent/contract-binding.js';
import { delegationForbidden } from './batteries/request-shape.js';
import { createUnitCheckLoop, queueSessionNudge, type ContractSessionHooks } from './agent-hooks.js';
import { contractGateProblems, readContractConfig, type ContractConfigReader } from './config.js';
import { emitContractEvent } from './events.js';
import { OwnerReplyRefusedError, type FailurePauseInput, type OwnerReplyOutcome } from './escalation.js';
import { createGroupRunner, type ContractEngineInput } from './group-runner.js';
import { takeSharedTreeForGroup } from './workstreams.js';
import { CONTRACT_RUNNER_AGENT_ID } from './nudge.js';
import { captureContractInput, contractInputPath, materializeContractInput, assertContractInputView, assertContractExecutionView, prepareContractInputParent, restoreContractInputDevice } from './input-snapshot.js';
import { planContract, shapeContract, type ContractPlannerDeps, type PlanningOutcome, type ShapeOutcome } from './planner.js';
import type { NativeContractDecisionHost, NativeContractServices } from './native-decisions.js';
import { bindNativeContractSource, captureNativeContractSource, nativeSourceCriteria } from './native-source.js';
import { createContractPlanSync, type ExecutionPlans, type WorkPlanService } from './plan-sync.js';
import { ContractExecutionWork } from './owned-execution-work.js';
import { claimContractLease } from './lease.js';
import { createContractResume, findZombieCause, type ContractClaim, type ContractHold, type ResumeReport } from './resume.js';
import type { CloseReport } from '../utils/owned-work.js';
import { numberDraft } from './draft-plan.js';
import { WorktreeRegistry } from '../runtime/worktree/registry.js';
import { createContractFleetControls, type ContractFleetControls } from './fleet-controls.js';
import type { OwnerEvidenceReader } from './owner-evidence.js';
import { ContractRun, failureFromError, type RunEnv } from './run-context.js';
import { createContractSteps, type ContractSteps, type ContractStepsWithReplies } from './steps.js';
import { contractIdempotencyLockPath, deserializeContract, deserializeOwnedContractCheckpoint, serializeContract, type ContractCreationReservation, type ContractRemoval, type ContractStore } from './store.js';
import { acquireProcessLock, ProcessLockBusyError, type HeldProcessLock } from '../utils/process-lock.js';
import { retainOriginalReviewDescriptors } from './review-file-observations.js';
import { captureTreeBaseline, retainOriginalTreeBaselines } from './tree-baseline.js';
import {
  CURRENT_CONTRACT_SCHEMA_VERSION,
  isOpaqueContractId,
  isTerminalContractStatus,
  isTerminalUnitStatus,
  newContractId,
  type Contract,
  type ContractFailureKind,
  type ContractOwnership,
  type ContractRouteSelector,
  type ContractView,
  type StartContractInput,
  type StartFromPlanInput,
} from './types.js';
import { createUnitFailureHandling } from './unit-failures.js';
import { contractAgentIds, noteAgentUsage, ownerRecordUsage, rollUpContractUsage, type PriceUsageFn } from './usage.js';
import { createUnitWatchdog, type WatchedAgent } from './watchdog.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { nativeContractActionSource, nativeContractPort } from './native-decisions.js';
import type { DurableContractExecution } from './durable-admission.js';

/** The key a session-mode contract's shared-tree lock is held under (a group id otherwise). */
const SESSION_TREE_HOLDER = 'session';

/** How long a disposed runner waits for its runs to drain before releasing their claims and naming them still running. */
const DISPOSE_DRAIN_LIMIT_MS = 5_000;
const EMPTY_CLOSE_REPORT: CloseReport = Object.freeze({ stopped: Object.freeze([]), killed: Object.freeze([]), stillRunning: Object.freeze([]) });

export interface ContractRunnerDeps {
  readonly judgmentLog?: Pick<import('@goodvibes-jev/judgment').DecisionLog, 'get'> | undefined;
  readonly readOwnerEvidence?: OwnerEvidenceReader | undefined;
  readonly getSelectedModel?: (() => Pick<import('../providers/registry-types.js').ModelDefinition, 'id' | 'provider' | 'registryKey' | 'displayName'>) | undefined;
  readonly nativeDecisions?: NativeContractDecisionHost | undefined;
  /** Host ledger synchronization and live deterministic validation for native-bound launches. */
  readonly durableAdmission?: DurableContractBoundary | undefined;
  readonly agentManager: Pick<AgentManager, 'spawn' | 'getStatus' | 'list' | 'cancel' | 'wakeWithSteer'> & Partial<Pick<AgentManager, 'join'>>;
  readonly messageBus: Pick<AgentMessageBus, 'send' | 'registerAgent'>;
  readonly runtimeBus: RuntimeEventBus;
  readonly configManager: ContractConfigReader;
  readonly projectRoot: string;
  /** Picks the model for the planner and every unit; required, there is no default model. */
  readonly routeSelector: ContractRouteSelector;
  /** Runs the read-only planner agent (agents/planner-decomposition-runner.ts). */
  readonly decompositionRunner: DecompositionRunner;
  /** One orchestration engine per contract. */
  readonly createEngine: (input: ContractEngineInput) => OrchestrationEngine;
  /** The fleet ceiling every contract's units share. */
  readonly fleetCapacity: FleetCapacityFn;
  readonly priceUsage: PriceUsageFn;
  readonly priceProvenance: PriceProvenanceFn;
  readonly store: ContractStore;
  /**
   * Individual correction and completion steps a host takes over (a surface
   * that answers attempt selections itself, a test); every other step is the
   * runner's own (steps.ts).
   */
  readonly steps?: Partial<ContractSteps> | undefined;
  /** The project work plan: each contract and unit as a task. Absent where the host has no project planning. */
  readonly workPlanService?: WorkPlanService | undefined;
  /** The execution plan: items a unit's agents worked on complete when the unit passes. */
  readonly planManager?: ExecutionPlans | undefined;
  /** The repository summary the planner starts from; defaults to the repo_map tool. */
  readonly readAccessFilter?: import('../tools/shared/read-access.js').ReadAccessFilter | undefined;
  readonly repositoryMap?: ((projectRoot: string) => Promise<string>) | undefined;
  readonly now?: (() => number) | undefined;
  /** Where an ended worktree-mode contract's tree is handed for removal (default: the project's worktree registry). */
  readonly worktrees?: Pick<WorktreeRegistry, 'releaseEnded'> | undefined;
  /** Waits `ms` or until `signal` aborts; defaults to a timer. A test injects its own so no real time passes. */
  readonly wait?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
}

export interface StartedContract {
  /** Actual admitted work and cleanup, independent of terminal record status. */
  readonly settled?: Promise<void> | undefined;
  readonly contract: ContractView;
  /** The owner record parents wait on. */
  readonly owner: AgentRecord;
}

/** An owned start certifies real drainage and captures cancellation by contract id. */
export interface OwnedStartedContract extends StartedContract {
  readonly settled: Promise<void>;
  cancel(reason: string): boolean;
}

/** Live host restrictions on asynchronous preparation; never serialized. */
export interface ContractStartOptions {
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent?: (() => void) | undefined;
}

/** A caller's retry key for one start: the same principal and key name the same contract, across restarts. */
export interface IdempotentStartRequest {
  readonly principalId: string;
  readonly key: string;
}

/** A start by retry key: the contract, its owner's id, and whether it was started by an earlier call with the key. */
export interface IdempotentStartedContract {
  readonly contract: ContractView;
  readonly ownerAgentId: string;
  readonly replayed: boolean;
}

/** The retry key was already used for a start with a different request: a refusal (state, reason, next step), status 409. */
function idempotencyKeyReused(contractId: string): RefusalError {
  return new RefusalError(refusal({
    code: 'IDEMPOTENCY_KEY_REUSED',
    state: `the key already started contract ${contractId}`,
    reason: 'This Idempotency-Key was already used to start a contract with a different request',
    next: ['Send a new Idempotency-Key for a different request, or repeat the first request exactly to get its contract'],
    status: 409,
  }));
}

/** The retry key could not be recorded or locked: nothing was started, because an unkeyed start could run twice. */
function idempotencyKeyUnrecorded(error: unknown): RefusalError {
  return new RefusalError(refusal({
    code: 'CONTRACT_KEY_UNRECORDED',
    state: 'no contract was started',
    reason: `The Idempotency-Key could not be recorded in the project's contract directory (${summarizeError(error)}), so a retry could not find this start`,
    next: ['Make the project\'s .goodvibes/contracts directory writable and send the same request with the same key again', 'Or send the request without an Idempotency-Key if a second start on retry is acceptable'],
    status: 503,
    retryable: false,
  }));
}

/** Another process is starting a contract with this key and has not published it within the wait. */
function idempotencyKeyInFlight(): RefusalError {
  return new RefusalError(refusal({
    code: 'IDEMPOTENCY_KEY_IN_FLIGHT',
    state: 'a start with this key is still running in another process',
    reason: 'A contract start with this Idempotency-Key is still being prepared elsewhere on this project',
    next: ['Send the same request with the same key again in a few seconds; it returns that contract once it is published'],
    status: 409,
    retryable: true,
  }));
}

/** The request a retry must repeat, in a canonical form: the same fields in any order give the same text. */
function startFingerprint(input: StartContractInput): string {
  const fields: Record<string, unknown> = { ask: input.ask, sessionId: input.sessionId, origin: input.origin, projectRoot: input.projectRoot, isolation: input.isolation ?? null };
  return JSON.stringify(Object.fromEntries(Object.keys(fields).sort().map((key) => [key, fields[key]])));
}

/** The session a contract gets when an agent spawn starts it with no conversation session (AgentManager's own event session). */
export const AGENT_MANAGER_SESSION_ID = 'agent-manager';

/** The longest a shutdown waits for queued work-plan writes; a stuck service must not hold the process open. */
const WORK_PLAN_FLUSH_LIMIT_MS = 5_000;

async function boundedWait(work: Promise<void>, limitMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work, new Promise<void>((resolve) => { timer = setTimeout(resolve, limitMs); timer.unref?.(); })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** What `retryUnit` did: `restarted` (a fresh agent), `committed` (a failed commit recorded), or `refused` with the reason. */
export interface UnitRetryOutcome {
  readonly outcome: 'restarted' | 'committed' | 'refused';
  readonly reason: string;
}

export interface ContractRunner {
  /** Source-less legacy entry points/records must not activate approval fallback in a native owner. */
  readonly nativeMode?: boolean;
  /** Atomically bind a native attempt to one durable runner record. Exact replay never starts another execution. */
  startDurable(request: DurableContractRequest): Promise<DurableStartedContract>;
  /** Explicit restart of the same record, after fresh validation; never mint a second native attempt. */
  resumeDurable(key: DurableContractKey): Promise<DurableStartedContract>;
  /** Read-only durable receipt/checkpoint inspection; never loads execution or invokes admission. */
  inspectDurable?(key: DurableContractKey): DurableStartedContract | null;
  /** Non-executing drainage confirmation; a live foreign execution lease fails closed. */
  joinDurable?(key: DurableContractKey): Promise<void>;
  /** Resolves repository placement before publishing the contract and owner. */
  start(input: StartContractInput, options?: ContractStartOptions): Promise<StartedContract>;
  /**
   * `start` with a caller's retry key (contracts.start with an Idempotency-Key,
   * over either HTTP path). The first call starts the contract and records
   * the key with the contract store, so a retry, also one after a daemon
   * restart, gets the same contract back instead of starting the work twice;
   * the same key with a different request is refused (IDEMPOTENCY_KEY_REUSED, 409).
   * Cost: one small file read per start, one exclusive file write per new
   * contract. Optional for custom runners; the factory always supplies it.
   */
  startIdempotent?(input: StartContractInput, request: IdempotentStartRequest, options?: ContractStartOptions): Promise<IdempotentStartedContract>;
  /**
   * Starts a contract from a plan drafted before it (a launched plan proposal
   * or workstream draft): the planner keeps the drafted units and
   * writes their criteria, and every plan check runs.
   */
  startFromPlan(input: StartFromPlanInput, options?: ContractStartOptions): Promise<StartedContract>;
  /**
   * AgentManager.spawn's seam for a spawn that is not outside every contract:
   * the spawned record becomes the owner of a new contract whose
   * ask is its task. No executor runs for it.
   */
  startForOwner(ownerRecord: AgentRecord, options?: ContractStartOptions): Promise<StartedContract>;
  /** Checks owned-start prerequisites before AgentManager admits an owner record. */
  assertOwnedExecution(): void;
  /** Explicit capability for a scoped spawn; legacy custom runners may omit it. */
  startOwnedForOwner(ownerRecord: AgentRecord, options?: ContractStartOptions): Promise<OwnedStartedContract>;
  /** Waits for the actual work admitted by this contract, after it ends. */
  join(contractId: string): Promise<void>;
  get(contractId: string): ContractView | null;
  /** Detached live facts only; never loads, starts or resumes. Optional for custom runners; the factory always supplies it. */
  inspectIntegration?(contractId: string): ContractIntegrationInspection;
  list(filter?: { readonly sessionId?: string | undefined; readonly includeTerminal?: boolean | undefined;
    /** Display summaries do not need the captured repository's file manifest. Full reads remain the default. */
    readonly includeInputSnapshot?: boolean | undefined;
    /** Keeps only the contracts this accepts; an ended one is asked from its summary, so a refused one is never read from disk. */
    readonly admit?: ((owner: ContractOwnership) => boolean) | undefined }): ContractView[];
  /** Stops a contract and everything it runs. False when it is unknown or already ended. */
  cancel(contractId: string, reason: string): boolean;
  /**
   * Deletes an ended contract's record (its checkpoint, summary and run claim).
   * `not-ended` while it runs or still settles here, `native` for native work
   * (its native execution owns the record), `not-found` for an unknown id.
   * Ended contracts are also removed by retention (contract/store.ts).
   * Optional for custom runners; the factory always supplies it.
   */
  remove?(contractId: string): ContractRemoval;
  /**
   * Runs one unit again: a working unit gets a fresh agent, and a passed unit
   * whose commit failed has it recorded again. Refused, with the reason and
   * what to do instead, for a unit that has not started, is being fixed, or
   * ended with its contract. Optional for custom runners; the factory always supplies it.
   */
  retryUnit?(contractId: string, unitId: string): Promise<UnitRetryOutcome>;
  /**
   * Replaces a running contract's token and cost ceiling. Each running group's
   * remaining allowance moves by the same amount, and units waiting on the old
   * ceiling start. False when the contract is not running here. Optional for
   * custom runners; the factory always supplies it.
   */
  raiseBudget?(contractId: string, ceiling: BudgetCeiling): boolean;
  /**
   * Resolves once the project work plan holds the contracts' latest statuses, or after a bounded wait. A host that
   * is about to exit awaits it after `dispose`, which cannot: `dispose` is synchronous. Optional for custom runners;
   * the factory always supplies it.
   */
  flushWorkPlan?(): Promise<void>;
  /** An owner's free-text reply to an open escalation, read with the reply pattern. */
  reply(contractId: string, escalationId: string, text: string): Promise<OwnerReplyOutcome>;
  /**
   * A native session contract's turn keeps failing: it pauses (awaiting-owner, its
   * work kept) and asks the owner to retry or cancel. The answer goes through
   * `reply`; "retry" returns the contract to running, "cancel" stops it. This is
   * not an approval path: native contracts still have no owner approval of the work.
   * Throws for any contract that is not a running native session contract.
   */
  pauseForOwnerRetry(contractId: string, failure: FailurePauseInput): { readonly escalationId: string };
  /**
   * At startup: every contract on disk that had not ended
   * resumes at the step it was on, or is reaped as a zombie when what it needs
   * to resume is gone. The active-contract cap applies.
   */
  resumeAll(): Promise<ResumeReport>;
  importContract(snapshotJson: string, force?: boolean): boolean;
  serializeContract(contractId: string): string | null;
  /** Installed into AgentOrchestrator's tool dependencies and the core turn loop. */
  hooks(): ContractSessionHooks;
  /** The fleet operator verbs' controller over every running contract's engine, with contract-qualified ids. */
  fleetControls(): ContractFleetControls;
  on(listener: (event: ContractEvent) => void): () => void;
  /**
   * A stored contract this runner holds without running it, with why (its recorded input could not be restored, or
   * no run claim could be taken); null when it is not held. Optional for custom runners; the factory always supplies it.
   */
  held?(contractId: string): ContractHold | null;
  dispose(): void;
  /**
   * After `dispose`: resolves once every run's claim is released, each because its work drained or because it is
   * named in `stillRunning` after the drain deadline. A host that exits awaits it and reports what is still running.
   * Optional for custom runners; the factory always supplies it.
   */
  closed?(): Promise<CloseReport>;
}

/** `auto` isolation: a worktree when the root is a git repository with at least one commit, else the shared tree. */
export async function resolveIsolation(setting: 'auto' | 'worktree' | 'shared', projectRoot: string,
  signal: AbortSignal = new AbortController().signal): Promise<'worktree' | 'shared'> {
  return resolveContractIsolation(setting, projectRoot, signal);
}

/**
 * What the contract branch is measured and merged against: the branch checked
 * out in the project root, or, on a detached HEAD, the commit HEAD names (a
 * branch name the root is not on would measure the work against the wrong
 * history, or against nothing).
 */
export async function currentBase(projectRoot: string, signal: AbortSignal = new AbortController().signal): Promise<string> {
  return resolveContractBase(projectRoot, signal);
}

/** The contract id a snapshot names, when it can be read at all. */
function snapshotContractId(snapshotJson: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(snapshotJson);
    const contract = parsed !== null && typeof parsed === 'object' && 'contract' in parsed ? parsed.contract : undefined;
    const id = contract !== null && typeof contract === 'object' && contract !== undefined && 'id' in contract ? contract.id : undefined;
    return typeof id === 'string' ? id : undefined;
  } catch {
    return undefined;
  }
}

/** The count of distinct files the contract's units changed, as their checks recorded them. */
export function filesModified(contract: Pick<Contract, 'units'>): number {
  return new Set(contract.units.flatMap((unit) => unit.touchedPaths)).size;
}

/** Unmet criteria named in a failure line; the rest are counted. */
const FAILURE_CRITERIA_NAMED = 8;

/**
 * A failed contract's status line, from facts the contract holds: what failed
 * (the reason and the criteria still unmet), what work is kept and where, and
 * the next step. The owner did not choose the failure, so the line must let
 * them find and use the work.
 */
export function failureStatusLine(contract: Pick<Contract, 'id' | 'units' | 'groups' | 'criteria' | 'isolation' | 'branch' | 'worktreePath' | 'failureKind'>, reason: string): string {
  const unmet = [...new Set([...contract.criteria, ...contract.groups.flatMap((group) => group.criteria), ...contract.units.flatMap((unit) => unit.criteria)]
    .filter((criterion) => criterion.disposition === 'judged' && (criterion.status === 'unmet' || criterion.status === 'unshown'))
    .map((criterion) => criterion.id))];
  const unmetPart = unmet.length === 0 ? '' : `; unmet criteria: ${unmet.slice(0, FAILURE_CRITERIA_NAMED).join(', ')}${unmet.length > FAILURE_CRITERIA_NAMED ? ` and ${unmet.length - FAILURE_CRITERIA_NAMED} more` : ''}`;
  const count = filesModified(contract);
  const files = `${count} changed file${count === 1 ? '' : 's'}`;
  const onBranch = contract.isolation === 'worktree' && contract.branch !== undefined;
  const kept = count === 0 ? 'no files were changed'
    : onBranch ? `${files} kept on branch ${contract.branch}${contract.worktreePath === undefined ? '' : ` (worktree ${contract.worktreePath})`}`
    : `${files} left in your working tree`;
  const retry = contract.failureKind === 'judgment-unavailable' || contract.failureKind === 'transport'
    ? 'start the request again once the model is reachable' : 'start the request again, changed to address the reason above';
  const next = count > 0 && onBranch ? `to keep the work, merge it with git merge ${contract.branch}; or ${retry}` : retry;
  return `Contract ${contract.id} failed: ${reason}${unmetPart}. Kept: ${kept}. Next: ${next}.`;
}

export function createContractRunner(deps: ContractRunnerDeps): ContractRunner & Required<Pick<ContractRunner, 'inspectIntegration' | 'remove'>> {
  const now = deps.now ?? Date.now;
  const durableAdmissions = new DurableContractAdmissions(deps.store.projectRoot);
  const durableLeases = new Map<string, () => void>();
  /** The claim this runner holds on each contract it runs, so a second process does not resume it. Released once the run's final checkpoint is written. */
  const processLeases = new Map<string, () => void>();
  function releaseProcessLease(contractId: string): void {
    const release = processLeases.get(contractId);
    processLeases.delete(contractId);
    release?.();
  }
  /**
   * Takes this process's run claim on a contract. A claim that cannot be made at all (an unwritable directory, a
   * filesystem without file locks) is reported as such: the caller does not run a stored contract it could not claim,
   * because another process may be running it.
   */
  function claimProcessLease(contractId: string): ContractClaim {
    if (processLeases.has(contractId)) return 'claimed';
    let release: (() => void) | null;
    try { release = claimContractLease(deps.store.projectRoot, contractId); }
    catch (error) { return { unavailable: `the run claim could not be taken: ${summarizeError(error)}` }; }
    if (release === null) return 'elsewhere';
    processLeases.set(contractId, release);
    return 'claimed';
  }
  /** Stored contracts this runner holds without running, with why; the operator's status and cancel read it. */
  const heldContracts = new Map<string, ContractHold>();
  /** Resolves once every lease dispose kept for a draining run is released: drained, or named still running. */
  let closing: Promise<CloseReport> | undefined;
  // Placement is prepared before a ContractRun exists. Disposal still owns
  // those children, and admission awaits their real close before releasing its lease.
  const placementAbort = new AbortController();
  const listeners = new Set<(event: ContractEvent) => void>();
  const runs = new Map<string, ContractRun>();
  const settlements = new Map<string, { readonly promise: Promise<void>; readonly resolve: () => void }>();
  const settling = new Map<string, ContractRun>();
  // Disposal keeps its resumable control state. Only usage from work already
  // admitted before disposal may be added after cancellation has drained.
  const disposalCheckpoints = new Map<string, Contract | null>();

  function reserveSettlement(contractId: string) {
    let entry = settlements.get(contractId);
    if (!entry) {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      entry = { promise, resolve };
      settlements.set(contractId, entry);
    }
    return entry;
  }

  /**
   * Hands the ended contract's worktree, and the captured input view made for it, to the retention rules.
   * Never throws: a tree that stays is only disk use.
   */
  function releaseEndedWorktree(contract: Contract): void {
    const worktrees = deps.worktrees ?? new WorktreeRegistry(contract.projectRoot);
    const targets = [{ path: contract.worktreePath!, baseBranch: contract.baseBranch },
      ...(contract.inputSnapshot === undefined ? [] : [{ path: contractInputPath(contract.inputSnapshot), baseBranch: contract.baseBranch }])];
    void worktrees.releaseEnded(targets).then((report) => {
      // What the release did is recorded; a tree kept with work in it is listed again with its next steps at the next start.
      for (const entry of report.removed) logger.info('contract worktree released', { contractId: contract.id, path: entry.path, note: entry.note });
      for (const entry of report.kept) logger.info('contract worktree kept', { contractId: contract.id, path: entry.path, why: entry.reason.why, detail: entry.reason.detail });
      for (const entry of report.failed) logger.warn('contract worktree could not be removed', { contractId: contract.id, path: entry.path, error: entry.error });
    }).catch((error: unknown) => {
      logger.warn('contract worktree could not be released', { contractId: contract.id, error: summarizeError(error) });
    });
  }

  /**
   * After dispose: waits up to DISPOSE_DRAIN_LIMIT_MS for each run's work to drain (its settlement releases its
   * claim once the final checkpoint is written), then releases the claim of each run still going and names it.
   */
  async function closeDraining(ids: readonly string[]): Promise<CloseReport> {
    if (ids.length === 0) return EMPTY_CLOSE_REPORT;
    const pending = ids.map((id) => ({ id, done: false, settled: settlements.get(id)?.promise ?? Promise.resolve() }));
    for (const entry of pending) void entry.settled.then(() => { entry.done = true; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, DISPOSE_DRAIN_LIMIT_MS); (timer as { unref?: () => void }).unref?.(); });
    await Promise.race([Promise.all(pending.map((entry) => entry.settled)), deadline]);
    clearTimeout(timer);
    const stillRunning = pending.filter((entry) => !entry.done).map((entry) => entry.id);
    for (const id of stillRunning) releaseProcessLease(id);
    if (stillRunning.length > 0) logger.warn('contract runner: contracts still running at shutdown; their claims were released so a rebuilt runner can resume them', { stillRunning });
    return Object.freeze({
      stopped: Object.freeze(pending.filter((entry) => entry.done).map((entry) => `contract ${entry.id}`)),
      killed: Object.freeze([]),
      stillRunning: Object.freeze(stillRunning.map((id) => Object.freeze({ label: `contract ${id}` }))),
    });
  }

  // Separate from outward terminal events: an abort/status is never a join.
  function settleWork(run: ContractRun): void {
    if (settling.has(run.id)) return;
    settling.set(run.id, run);
    const entry = reserveSettlement(run.id);
    void (async () => {
      await run.work.join();
      await run.engine?.join?.();
      // Planning can publish its agent id while unwinding after cancellation.
      // Engine phases independently join unit executors before their cleanup.
      await Promise.all(contractAgentIds(run.contract).map((id) => deps.agentManager.join?.(id)));
      await run.work.join();
      let checkpointed = false;
      try {
        if (deps.store.get(run.id) !== run.contract) throw new Error('Contract settlement checkpoint owner changed');
        if (disposed) {
          const checkpoint = disposalCheckpoints.get(run.id);
          if (checkpoint === null || checkpoint === undefined) throw new Error('Contract disposal checkpoint is unavailable');
          const before = checkpoint.judgmentUsage;
          const after = run.contract.judgmentUsage;
          if (before.calls !== after.calls || before.inputTokens !== after.inputTokens || before.outputTokens !== after.outputTokens) {
            checkpoint.judgmentUsage = { ...after };
            deps.store.hold(checkpoint);
            if (!deps.store.write(run.id)) throw new Error('Contract disposal usage checkpoint failed');
          }
        } else {
          // Terminal events can precede the last metered response. The final
          // checkpoint includes late usage and precedes execution lease release.
          if (!deps.store.write(run.id)) throw new Error('Contract settlement checkpoint failed');
        }
        disposalCheckpoints.delete(run.id);
        checkpointed = true;
      } catch (error) {
        // join still reports actual executor drainage. Failed persistence must
        // not release a durable lease and make a stale checkpoint resumable.
        logger.error('contract final checkpoint failed', { contractId: run.id, executionLeaseRetained: durableLeases.has(run.id), error: summarizeError(error) });
      }
      for (const release of run.sharedTreeReleases.values()) release();
      run.sharedTreeReleases.clear();
      if (checkpointed) {
        durableLeases.get(run.id)?.();
        durableLeases.delete(run.id);
        releaseProcessLease(run.id);
      }
      // A worktree-mode contract's tree has nothing left to do now that its work drained. The retention rules
      // remove it only when it holds nothing unique (no uncommitted changes, no commits missing from the base).
      if (checkpointed && !disposed && run.contract.worktreePath !== undefined) releaseEndedWorktree(run.contract);
      entry.resolve();
      settlements.delete(run.id);
      settling.delete(run.id);
      // An ended contract leaves memory once written; reads load it from disk (bounded cache in the store).
      if (checkpointed && !disposed && isTerminalContractStatus(run.contract.status)) deps.store.noteEnded(run.contract);
    })().catch((error: unknown) => {
      // A failed join cannot certify settlement. Retain the pending barrier.
      logger.warn('contract settlement could not be established', { contractId: run.id, error });
    });
  }
  /** Contracts holding an active slot: admitted past the queue and not yet ended. */
  const admitted = new Set<string>();
  /**
   * A contract paused on its owner after a failed session turn is not running, so it does not count
   * against the active limit: queued contracts, in any session, must not wait indefinitely on an owner
   * who has not answered. Other waits for the owner still hold their slot.
   */
  const activeCount = (): number => {
    let count = 0;
    for (const id of admitted) {
      const contract = runs.get(id)?.contract;
      // A failed unit's question does not free the slot: the contract's other units go on working.
      const paused = contract?.status === 'awaiting-owner' && contract.escalations.some((item) => item.resolvedAt === undefined && item.failurePause === true
        && (item.scope !== 'unit' || contract.sessionMode === true));
      if (!paused) count++;
    }
    return count;
  };
  const queue: ContractRun[] = [];
  const pricing = { priceUsage: deps.priceUsage, priceProvenance: deps.priceProvenance };
  const getStatus = (agentId: string): AgentRecord | null => deps.agentManager.getStatus(agentId);
  let disposed = false;

  function emit(contract: Contract, event: ContractEvent): void {
    const occurrence = emitContractEvent(deps.runtimeBus, contract.sessionId, event);
    for (const listener of listeners) {
      try {
        listener(occurrence);
      } catch {
        // A listener cannot break the runner; the store and surfaces log their own faults.
      }
    }
  }

  function on(listener: (event: ContractEvent) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  const native: NativeContractServices | undefined = deps.nativeDecisions === undefined ? undefined : { host: deps.nativeDecisions, changed: contract => { deps.store.put(contract); }, checkpoint: contract => { deps.store.put(contract); if (!deps.store.write(contract.id)) throw new Error('Native semantic checkpoint failed'); }, cancel: (contract, reason) => { const run = runs.get(contract.id); if (run !== undefined) cancelRun(run, reason); } };
  const env: RunEnv = {
    native,
    now,
    ...(deps.wait === undefined ? {} : { wait: deps.wait }),
    config: () => readContractConfig(deps.configManager),
    emit,
    touchAgent: (agentId) => watchdog.touch(agentId),
    contractMoved: (contract) => setOwnerProgress(contract),
  };

  deps.messageBus.registerAgent({ agentId: CONTRACT_RUNNER_AGENT_ID, role: 'orchestrator' });
  const detachStore = deps.store.attach(on);
  const planSync = createContractPlanSync({
    workPlanService: deps.workPlanService,
    planManager: deps.planManager,
    getContract: (contractId) => runs.get(contractId)?.contract ?? deps.store.get(contractId) ?? deps.store.ended(contractId),
  });
  const detachPlanSync = on(planSync.onEvent);

  const settlement: ContractUnitSettlement = {
    autonomousPort(item) {
      const run = item.contractId === undefined ? undefined : runs.get(item.contractId);
      return run?.contract.nativeSource === undefined ? undefined : port => nativeContractPort(run.contract, native, port, run.abort.signal);
    },
    autonomousSource(item) {
      const run = item.contractId === undefined ? undefined : runs.get(item.contractId);
      if (run === undefined) return undefined;
      if (run.contract.originalSource) return () => { run.abort.signal.throwIfAborted(); assertOwnedContractSource(run.contract); return getContractActionSource(run.contract)!(); };
      if (run.contract.nativeSource === undefined) return undefined;
      return nativeContractActionSource(run.contract, native, run.abort.signal);
    },
    withCurrentExecution(item, execute) {
      const run = item.contractId === undefined ? undefined : runs.get(item.contractId);
      if (run === undefined || run.terminal || run.abort.signal.aborted) return Promise.reject(new DurableContractAdmissionError('boundary'));
      if (run.contract.durableAdmission === undefined) return execute();
      return withCurrentDurableExecution(run, execute).catch((error: unknown) => {
        cancelRun(run, 'native execution binding is no longer current');
        throw error;
      });
    },
    settle(item, agentId, signal) {
      const run = item.contractId === undefined ? undefined : runs.get(item.contractId);
      const unit = item.contractUnitId === undefined ? undefined : run?.unit(item.contractUnitId);
      if (run === undefined || unit === undefined || run.terminal || signal.aborted) return Promise.resolve('cancelled');
      const runtime = run.runtime(unit);
      return new Promise<ContractUnitOutcome>((resolve) => {
        const entry = {
          agentId,
          resolve: (outcome: ContractUnitOutcome) => {
            signal.removeEventListener('abort', onAbort);
            resolve(outcome);
          },
        };
        function onAbort(): void {
          if (runtime.settlement === entry) runtime.settlement = null;
          resolve('cancelled');
        }
        signal.addEventListener('abort', onAbort, { once: true });
        runtime.settlement = entry;
        // Independent of the silence watchdog (off by default): once the
        // agent's execution drained, an end that published no event still settles the unit.
        void deps.agentManager.join?.(agentId).then(() => {
          // The contract keeps what the agent used, whatever later happens to its record.
          noteAgentUsage(run.contract, agentId, getStatus, pricing);
          setTimeout(() => { if (!run.terminal) failures.reconcile(agentId); }, 0).unref?.();
        });
      });
    },
    async beforeSpawn(item, signal) {
      const decision = await decideSpawn(item, signal);
      if (decision.kind !== 'spawn') return decision;
      // The unit's diff is measured from here: taken before its first agent can write.
      const run = item.contractId === undefined ? undefined : runs.get(item.contractId);
      const unit = item.contractUnitId === undefined ? undefined : run?.unit(item.contractUnitId);
      if (run !== undefined && unit !== undefined && unit.baseline === undefined && !run.terminal) {
        unit.baseline = await captureTreeBaseline(item.worktreePath ?? run.contract.worktreePath ?? run.contract.projectRoot);
      }
      return decision;
    },
  };

  /** What a contract unit's phase does before it spawns: spawn (with the current brief), wait for the runner after a restart, or settle. */
  function decideSpawn(item: WorkItem, signal: AbortSignal): Promise<ContractPreSpawn> {
    const run = item.contractId === undefined ? undefined : runs.get(item.contractId);
    const unit = item.contractUnitId === undefined ? undefined : run?.unit(item.contractUnitId);
    const cancelled: ContractPreSpawn = { kind: 'settled', outcome: 'cancelled' };
    if (run === undefined || unit === undefined || run.terminal || signal.aborted) return Promise.resolve(cancelled);
    const runtime = run.runtime(unit);
    const decided = runtime.preSpawn;
    if (decided === null) {
      const group = run.group(unit.groupId);
      if (group === undefined) return Promise.resolve(cancelled);
      // Items can wait behind peers, or survive a restart, with an old task.
      // Bind current accepted results when the worker is actually admitted.
      return Promise.resolve({ kind: 'spawn', task: briefWithPreviousChecks(buildUnitBrief(run.contract, group, unit, deps.readOwnerEvidence?.(run.contract, '')), unit) });
    }
    if (decided !== 'wait') {
      runtime.preSpawn = null;
      return Promise.resolve(decided);
    }
    // After a restart: the phase waits until a check, a respawn or the owner decides.
    return new Promise<ContractPreSpawn>((resolve) => {
      const entry = {
        resolve: (decision: ContractPreSpawn) => {
          signal.removeEventListener('abort', onAbort);
          resolve(decision);
        },
      };
      function onAbort(): void {
        if (runtime.spawnGate === entry) runtime.spawnGate = null;
        resolve(cancelled);
      }
      signal.addEventListener('abort', onAbort, { once: true });
      runtime.spawnGate = entry;
    });
  }

  function watched(): WatchedAgent[] {
    const agents: WatchedAgent[] = [];
    for (const run of runs.values()) {
      if (run.terminal) continue;
      for (const unit of run.allUnits()) {
        if (unit.activeAgentId === undefined || (unit.status !== 'running' && unit.status !== 'checking' && unit.status !== 'nudged')) continue;
        const status = getStatus(unit.activeAgentId)?.status;
        if (status !== 'running' && status !== 'pending') continue;
        agents.push({ contractId: run.id, unitId: unit.id, agentId: unit.activeAgentId, startedAt: run.runtime(unit).agentStartedAt });
      }
    }
    return agents;
  }

  const watchdog = createUnitWatchdog({
    runtimeBus: deps.runtimeBus,
    timeoutMs: () => env.config().heartbeatTimeoutMs,
    watched,
    onSilent: (agent, silentMs) => failures.onSilent(agent, silentMs),
    now,
  });

  const ownSteps = createContractSteps({
    judgmentLog: deps.judgmentLog,
    readOwnerEvidence: deps.readOwnerEvidence,
    native,
    agentManager: deps.agentManager,
    configManager: deps.configManager,
    runtimeBus: deps.runtimeBus,
    routeSelector: deps.routeSelector,
    decompositionRunner: deps.decompositionRunner,
    plannerDeps: (run) => plannerDeps(run),
    getStatus,
    groups: () => groups,
    checks: () => checks,
    continuePlanning: (run, outcome) => continuePlanning(run, outcome),
    ownerProgress: (run) => updateOwnerProgress(run),
    checkpoint: run => { deps.store.put(run.contract); if (!deps.store.write(run.id)) throw new Error('Contract correction checkpoint failed'); },
  });
  const untrackedSteps = { ...ownSteps, ...deps.steps };
  // Every step, including host overrides, runs under the contract's real
  // lifetime. Reserve before calling it: steps can end the contract inline.
  const steps = Object.fromEntries(Object.entries(untrackedSteps).map(([key, step]) => [
    key,
    (run: ContractRun, ...args: unknown[]) => run.work.run('contract work', () =>
      ((run.contract.nativeSource === undefined ? step : ownSteps[key as keyof typeof ownSteps]) as (run: ContractRun, ...args: unknown[]) => Promise<unknown>)(run, ...args)),
  ])) as unknown as ContractStepsWithReplies;

  const checks = createUnitCheckLoop({
    readOwnerEvidence: deps.readOwnerEvidence,
    checkpoint: run => deps.store.scheduleWrite(run.id),
    checkpointSeverity: run => {
      // A shutdown snapshot must not be overwritten by cancellation cleanup.
      // settleWork adds late usage to its detached resumable state instead.
      if (disposed) return;
      if (deps.store.get(run.id) !== run.contract || !deps.store.write(run.id)) throw new Error('Contract severity checkpoint failed');
    },
    findRun: (contractId) => runs.get(contractId),
    agentManager: deps.agentManager,
    messageBus: deps.messageBus,
    configManager: deps.configManager,
    runtimeBus: deps.runtimeBus,
    watchdog,
    escalations: steps,
    failContract: (run, kind, reason) => fail(run, kind, reason),
    unitPassed: (run, unit) => (run.contract.sessionMode === true ? sessionUnitPassed(run, unit) : groups.unitPassed(run, unit)),
    respawnUnit: (run, unit, reason, firstTurn) => {
      // Session mode has no agent to respawn: the nudge waits for the session's next turn.
      if (run.contract.sessionMode === true) queueSessionNudge(run, unit, firstTurn, unit.nudges.at(-1)?.id ?? '');
      else groups.requeueUnit(run, unit, reason, 'resume', firstTurn);
    },
    sessionUnit,
  });

  const groups = createGroupRunner({
    createEngine: deps.createEngine,
    fleetCapacity: deps.fleetCapacity,
    routeSelector: deps.routeSelector,
    getStatus,
    watchdog,
    settlement,
    steps,
    pricing,
    failContract: (run, kind, reason) => fail(run, kind, reason),
    failUnit: (run, unit, kind, reason) => failures.failUnit(run, unit, kind, reason),
  });

  const failures = createUnitFailureHandling({
    runs: () => runs.values(),
    agentManager: deps.agentManager,
    runtimeBus: deps.runtimeBus,
    checks,
    failContract: (run, kind, reason) => fail(run, kind, reason),
    cancelContract: (run, reason) => cancelRun(run, reason),
    requeueUnit: (run, unit, reason, purpose, firstTurn) => groups.requeueUnit(run, unit, reason, purpose, firstTurn),
    pauseFailedUnit: (run, unit, reason) => ownSteps.pauseFailedUnit(run, unit, reason) !== null,
  });

  // ── The cap and queue ──────────────────────────────────────────

  /** Takes a slot for the contract and starts it, or, for a resumed contract that waited, takes up its step. */
  function admit(run: ContractRun): void {
    if (run.terminal || disposed) return;
    admitted.add(run.id);
    if (run.contract.durableAdmission !== undefined) {
      void launchDurable(run).catch(() => cancelRun(run, 'native admission is no longer current'));
    } else void run.work.run('contract work', () => run.contract.resumeFrom === undefined ? activate(run) : resume.continueResumed(run));
  }

  function dequeue(): void {
    const cap = env.config().maxActiveContracts;
    while (queue.length > 0 && activeCount() < cap && !disposed) {
      const next = queue.shift()!;
      if (next.terminal) continue;
      next.decide('queued', next.id, 'a slot opened; starting');
      admit(next);
    }
  }

  // ── Starting ────────────────────────────────────────────────────────────────

  function ownerProgress(contract: Contract): string {
    return `Contract ${contract.id}: ${contract.status}`;
  }

  function captureStartInput(input: StartContractInput, captureModel = true): StartContractInput {
    if (input.nativeSource === undefined && deps.nativeDecisions !== undefined) throw new Error('Native admission requires the complete original source snapshot');
    if (input.nativeSource !== undefined && deps.nativeDecisions === undefined) throw new Error('Native contract requires its authenticated semantic owner');
    const selectedModel = input.selectedModel ?? (captureModel ? deps.getSelectedModel?.() : undefined);
    return { ...input,
      ...(input.budget === undefined ? {} : { budget: { ...input.budget } }),
      ...(input.proposedUnits === undefined ? {} : { proposedUnits: input.proposedUnits.map(unit => ({ ...unit })) }),
      ...(selectedModel === undefined ? {} : { selectedModel: { id: selectedModel.id, provider: selectedModel.provider, registryKey: selectedModel.registryKey, displayName: selectedModel.displayName } }),
      ...(input.nativeSource === undefined ? {} : { nativeSource: captureNativeContractSource(input.nativeSource) }),
    };
  }

  /**
   * A native contract's latest saved state: its own checkpoint file. The copy
   * in the admission receipt is the first checkpoint, read only when that file
   * was never published (a crash between the two writes at creation). Only an
   * absent file falls back to it: a checkpoint that was refused (quarantined,
   * unreadable) throws its refusal, so the contract is never started again
   * from its first checkpoint.
   */
  function durableCheckpoint(admission: DurableContractAdmission): Contract | null {
    const read = deps.store.load(admission.contractId);
    switch (read.kind) {
      case 'present': return read.value;
      case 'absent': return deserializeOwnedContractCheckpoint(durableAdmissions.checkpointRead(admission.key));
      case 'failed': throw new RefusalError(read.refusal);
      default: return assertNeverObserved(read);
    }
  }

  function durableResult(admission: DurableContractAdmission): DurableStartedContract {
    const contract = runs.get(admission.contractId)?.contract ?? durableCheckpoint(admission);
    if (contract === null || contract.durableAdmission?.payloadRevision !== admission.payloadRevision
      || contract.ownerAgentId !== admission.ownerAgentId) throw new DurableContractAdmissionError('checkpoint');
    assertDurableCheckpoint(contract, admission);
    const { input: _input, ...receipt } = admission;
    return { admission: Object.freeze(receipt), contract: structuredClone(contract), state: isTerminalContractStatus(contract.status)
      ? 'terminal' : contract.durableLaunchState ?? 'prepared' };
  }

  async function withCurrentDurableExecution(run: ContractRun, execute: () => Promise<void>, claimLaunch = false): Promise<void> {
    const admission = run.contract.durableAdmission;
    const boundary = deps.durableAdmission;
    if (admission === undefined || boundary === undefined) throw new DurableContractAdmissionError('boundary');
    let open = true;
    let invoked = false;
    let execution: Promise<void> | undefined;
    let boundaryFailed = false;
    let boundaryError: unknown;
    try {
      const boundaryResult = boundary.withCurrent(admission, (assertCurrent) => {
        if (!open || invoked || typeof assertCurrent !== 'function') throw new DurableContractAdmissionError('boundary');
        invoked = true;
        if (disposed || run.terminal || run.abort.signal.aborted) throw new DurableContractAdmissionError('boundary');
        if (claimLaunch) {
          run.contract.durableLaunchState = 'launch-claimed';
          if (!deps.store.write(run.id)) throw new DurableContractAdmissionError('checkpoint');
        }
        // Every borrowed/reentrant hook, including persistence and AgentManager's spawning events,
        // precedes this synchronous check. The host holds its ledger lock through invocation.
        assertDurableCheckpoint(run.contract, admission);
        const validity: unknown = assertCurrent();
        if (validity !== undefined) {
          void Promise.resolve(validity).catch(() => undefined);
          throw new DurableContractAdmissionError('boundary');
        }
        assertDurableCheckpoint(run.contract, admission);
        if (disposed || run.terminal || run.abort.signal.aborted) throw new DurableContractAdmissionError('boundary');
        execution = execute();
        // Observe rejection immediately even when the host's lock-release promise is still pending.
        void execution.catch(() => undefined);
      });
      if (boundaryResult === undefined) open = false;
      await boundaryResult;
      if (!invoked) throw new DurableContractAdmissionError('boundary');
    } catch (error) {
      boundaryFailed = true;
      boundaryError = error;
      cancelRun(run, 'native admission boundary failed');
    } finally { open = false; }
    if (boundaryFailed) {
      // Launch may already have entered an executor. Failed lock release/commit is not drainage.
      try { await execution; } catch { /* Preserve the boundary failure after actual executor cleanup. */ }
      throw boundaryError;
    }
    // Do not hold the ledger lock for an executor's entire lifetime.
    await execution;
  }

  async function launchDurable(run: ContractRun): Promise<void> {
    return withCurrentDurableExecution(run, () => {
      void run.work.run('contract work', () => run.contract.resumeFrom === undefined ? activate(run) : resume.continueResumed(run));
      return Promise.resolve();
    }, true);
  }

  async function startDurable(request: DurableContractRequest): Promise<DurableStartedContract> {
    // The caller has already bound this payload; defaults must not change its revision.
    const frozen = freezeDurableRequest({ ...request, input: captureStartInput(request.input, false) });
    assertOwnedExecution();
    if (disposed) throw new Error('Contract runner is disposed');
    if (deps.durableAdmission === undefined) throw new DurableContractAdmissionError('boundary');
    // An immutable binding is already committed before the host boundary runs. Exact delivery
    // replay must remain readable even while that boundary waits for its ledger transaction.
    const committed = durableAdmissions.read(frozen.key);
    if (committed !== null) {
      if (!sameDurableRequest(committed, frozen)) throw new DurableContractAdmissionError('conflict');
      return durableResult(committed);
    }
    const release = await durableAdmissions.lock(frozen.key);
    try {
      if (disposed) throw new Error('Contract runner is disposed');
      const existing = durableAdmissions.read(frozen.key);
      if (existing !== null) {
        if (!sameDurableRequest(existing, frozen)) throw new DurableContractAdmissionError('conflict');
        return durableResult(existing);
      }
      // Never mint another binding if a surviving contract proves the receipt went missing. The
      // contract-id index names every bound key in small files; no checkpoint is read for it.
      for (const { key } of durableAdmissions.indexedKeys()) {
        if (durableKeyIdentity(key) === durableKeyIdentity(frozen.key)
          || (frozen.input.nativeSource !== undefined && key.workId === frozen.key.workId && key.attemptId === frozen.key.attemptId)) {
          throw new DurableContractAdmissionError('checkpoint');
        }
      }
      // Ids from before the index existed have no entry in it; only their checkpoints are read.
      for (const storedId of deps.store.listStoredIds().filter((id) => !isOpaqueContractId(id))) {
        const read = deps.store.load(storedId);
        // A refused checkpoint is quarantined and proves nothing either way; the index and receipts still fence.
        const stored = read.kind === 'present' ? read.value : null;
        const admission = stored?.durableAdmission;
        if (admission !== undefined && (durableKeyIdentity(admission.key) === durableKeyIdentity(frozen.key)
          // A surviving native checkpoint also fences a lost intent/receipt
          // whose older criteria label cannot be reconstructed. A fresh label
          // must never turn the same ledger attempt into a second execution.
          || (stored?.nativeSource !== undefined && frozen.input.nativeSource !== undefined
            && admission.key.workId === frozen.key.workId && admission.key.attemptId === frozen.key.attemptId))) {
          throw new DurableContractAdmissionError('checkpoint');
        }
      }
      const lease = await durableAdmissions.lease(frozen.key);
      const id = newContractId();
      let creation: ContractCreationReservation;
      try { creation = reserveCreation(id); }
      catch (error) { lease(); throw error; }
      durableLeases.set(id, lease);
      let owner: AgentRecord | undefined;
      let created: StartedContract | undefined;
      try {
        const execution = await resolveContractGitPlacement(frozen.input.isolation ?? env.config().isolation,
          frozen.input.projectRoot, id, placementAbort.signal);
        if (disposed) throw new Error('Contract runner is disposed');
        creation.assertCurrent();
        owner = spawnOwner(frozen.input, id);
        creation.assertCurrent();
        const admission = parseDurableAdmission({ ...frozen, schemaVersion: 2, execution, contractId: id,
          ownerAgentId: owner.id, payloadRevision: durablePayloadRevision(frozen) });
        created = create(frozen.input, id, owner, { durableAdmission: admission, execution, creation }, true, true);
        if (isTerminalContractStatus(created.contract.status)) {
          // A reentrant creation listener may cancel before launch admission.
          // The live run has already retired, but its final checkpoint still
          // belongs to executor drainage; never acknowledge the old prepared
          // disk image while that original settlement is pending.
          await created.settled;
          const result = durableResult(admission);
          if (result.state !== 'terminal') throw new DurableContractAdmissionError('checkpoint');
          return result;
        }
        const run = runs.get(id);
        if (run !== undefined && !run.terminal && !disposed) {
          if (activeCount() < env.config().maxActiveContracts) {
            admitted.add(id);
            try { await launchDurable(run); }
            catch (error) { cancelRun(run, 'native admission launch was not validated'); throw error; }
          } else {
            queue.push(run);
            run.decide('queued', id, 'waiting for an active-contract slot');
          }
        }
        return durableResult(admission);
      } catch (error) {
        const run = runs.get(id);
        if (run !== undefined && creation.owns(run.contract)) cancelRun(run, 'native admission could not start');
        // Once creation succeeded, terminal settlement alone releases the
        // execution lease. A failed final checkpoint must keep it fenced even
        // after its real drainage barrier has resolved and retired the run.
        else if (created === undefined && !settling.has(id)) {
          try { if (owner) deps.agentManager.cancel(owner.id); const pending = settlements.get(id); pending?.resolve(); if (runs.get(id) === undefined && settlements.get(id) === pending) settlements.delete(id); }
          finally { durableLeases.delete(id); lease(); }
        }
        throw error;
      } finally { creation.release(); }
    } finally { release(); }
  }

  async function resumeDurable(key: DurableContractKey): Promise<DurableStartedContract> {
    assertOwnedExecution();
    if (disposed) throw new Error('Contract runner is disposed');
    if (deps.durableAdmission === undefined) throw new DurableContractAdmissionError('boundary');
    // Detach the key before lock acquisition can yield to caller code.
    const frozenKey = freezeDurableKey(key);
    const release = await durableAdmissions.lock(frozenKey);
    try {
      if (disposed) throw new Error('Contract runner is disposed');
      const admission = durableAdmissions.read(frozenKey);
      if (admission === null) throw new DurableContractAdmissionError('missing');
      captureStartInput(admission.input);
      const result = durableResult(admission);
      if (runs.has(admission.contractId) || result.state === 'terminal') return result;
      // Old receipts remain inspectable/replayable, but their mutable checkpoint is
      // not evidence of the isolation/configuration originally selected at admission.
      if (admission.execution === undefined) throw new DurableContractAdmissionError('checkpoint');
      const lease = await durableAdmissions.lease(frozenKey);
      durableLeases.set(admission.contractId, lease);
      let contract: Contract;
      try {
        const restored = durableCheckpoint(admission);
        if (restored === null) throw new DurableContractAdmissionError('checkpoint');
        contract = restored;
        assertDurableCheckpoint(contract, admission);
        if (contract.inputSnapshot !== undefined) contract.inputSnapshot = await restoreContractInputDevice(contract.inputSnapshot);
        deps.store.hold(contract);
      }
      catch (error) { durableLeases.delete(admission.contractId); lease(); throw error; }
      const run = newRun(contract);
      run.requireSettlement = true;
      try { resume.prepareNative(run); }
      catch (error) { fail(run, 'zombie', `native contract checkpoint cannot resume: ${summarizeError(error)}`, true); return durableResult(admission); }
      const zombie = findZombieCause(contract);
      if (zombie !== null) { fail(run, 'zombie', 'native contract checkpoint cannot resume', true); return durableResult(admission); }
      // Preserve the restart step even while queued. The persisted native binding never grants launch.
      contract.resumeFrom = contract.resumeFrom ?? contract.status;
      if (activeCount() < env.config().maxActiveContracts) {
        admitted.add(run.id);
        try { await launchDurable(run); }
        catch (error) { cancelRun(run, 'native admission resume was not validated'); throw error; }
      } else {
        if (contract.status !== 'queued') run.moveContract('queued');
        queue.push(run);
        run.decide('queued', run.id, 'waiting to resume a native contract');
      }
      return durableResult(admission);
    } finally { release(); }
  }

  function reserveCreation(id: string): ContractCreationReservation {
    if (runs.has(id) || settlements.has(id) || durableLeases.has(id) || deps.store.get(id) !== null) throw new DurableContractAdmissionError('conflict');
    return deps.store.reserveCreation(id);
  }

  async function prepareStart(input: StartContractInput, id: string, options: ContractStartOptions, creation: ContractCreationReservation,
    extraCurrent: () => void = () => {}, ownerSignal?: AbortSignal) {
    const originalSignal = options.signal, assertion = options.assertCurrent;
    const signal = AbortSignal.any([placementAbort.signal, ...(originalSignal ? [originalSignal] : []), ...(ownerSignal ? [ownerSignal] : [])]);
    const current = (): void => {
      signal.throwIfAborted();
      if (disposed) throw new Error('Contract runner is disposed');
      assertSynchronousJudgmentGuard(assertion, () => new Error('Contract start requires a synchronous current owner'));
      extraCurrent(); creation.assertCurrent();
      signal.throwIfAborted();
    };
    current();
    const execution = await resolveContractGitPlacement(input.isolation ?? env.config().isolation, input.projectRoot, id, signal);
    current();
    return { execution, signal, current };
  }

  function failedStart(id: string, owner: AgentRecord | undefined, creation: ContractCreationReservation): void {
    const run = runs.get(id);
    if (run !== undefined && creation.owns(run.contract)) { cancelRun(run, 'contract preparation or publication failed'); return; }
    try { if (owner !== undefined) deps.agentManager.cancel(owner.id); }
    finally {
      if (run === undefined) { const pending = settlements.get(id); pending?.resolve(); if (runs.get(id) === undefined && settlements.get(id) === pending) settlements.delete(id); }
    }
  }

  /** `reserved` hears the new contract's id before anything is prepared or published (the retry key is recorded there). */
  function start(input: StartContractInput, options: ContractStartOptions = {}, reserved?: (contractId: string) => void): Promise<StartedContract> {
    if (disposed) throw new Error('Contract runner is disposed');
    const captured = captureStartInput(input);
    const id = newContractId(), creation = reserveCreation(id);
    return (async () => {
      let owner: AgentRecord | undefined;
      try {
        // Inside the try: a key that cannot be recorded refuses the start and gives the reserved id back.
        reserved?.(id);
        const prepared = await prepareStart(captured, id, options, creation);
        prepared.current();
        owner = spawnOwner(captured, id); prepared.current();
        return create(captured, id, owner, { ...prepared, creation });
      } catch (error) { failedStart(id, owner, creation); throw error; }
      finally { creation.release(); }
    })();
  }

  const idempotentStarts = new Map<string, Promise<{ readonly fingerprint: string; readonly started: IdempotentStartedContract }>>();

  async function startIdempotent(input: StartContractInput, request: IdempotentStartRequest, options: ContractStartOptions = {}): Promise<IdempotentStartedContract> {
    const scope = `${request.principalId}\u0000${request.key}`;
    const fingerprint = startFingerprint(input);
    // A second call with the key while the first is still starting waits for it rather than starting again.
    const inFlight = idempotentStarts.get(scope);
    if (inFlight !== undefined) {
      const first = await inFlight;
      if (first.fingerprint !== fingerprint) throw idempotencyKeyReused(first.started.contract.id);
      return { ...first.started, replayed: true };
    }
    const operation = (async () => {
      // One starter per key across every process on this project: the key's lock is held from the read of its
      // record until the started contract's first checkpoint is published (start resolves after publication). A
      // second runner with the key waits, then finds that contract and replays it; it never starts a second one.
      let lock: HeldProcessLock;
      try { lock = await acquireProcessLock(contractIdempotencyLockPath(deps.store.projectRoot, scope), { signal: options.signal }); }
      catch (error) {
        if (error instanceof ProcessLockBusyError) throw idempotencyKeyInFlight();
        if (options.signal?.aborted) throw error;
        throw idempotencyKeyUnrecorded(error);
      }
      try {
        const known = deps.store.readIdempotentStart(scope);
        if (known !== undefined) {
          if (known.fingerprint !== fingerprint) throw idempotencyKeyReused(known.contractId);
          let contract = deps.store.get(known.contractId) ?? deps.store.ended(known.contractId);
          if (contract === null) {
            const read = deps.store.load(known.contractId);
            // The key's contract was refused on read (quarantined): it is not replayed and not started again.
            if (read.kind === 'failed') throw new RefusalError(read.refusal);
            contract = read.kind === 'present' ? read.value : null;
          }
          if (contract !== null) return { fingerprint, started: { contract: withCheckpointWarning(structuredClone(contract)), ownerAgentId: contract.ownerAgentId, replayed: true } };
          // Under the key's lock nobody is starting it: the start that recorded it ended before publishing, or its
          // contract was removed by hand. The key starts a new one.
          try { deps.store.forgetIdempotentStart(scope); } catch (error) { throw idempotencyKeyUnrecorded(error); }
        }
        // The key is recorded with the reserved id before anything is prepared or published, so a daemon that stops
        // after creating the contract finds it on the retry. A key that cannot be recorded refuses the start: an
        // unkeyed start would run again on the caller's retry.
        let recorded = false;
        const record = (contractId: string): void => {
          try { deps.store.recordIdempotentStart(scope, { contractId, fingerprint }); recorded = true; }
          catch (error) { throw idempotencyKeyUnrecorded(error); }
        };
        let started: StartedContract;
        try { started = await start(input, options, record); }
        catch (error) {
          // Nothing started: the key is free for the retry.
          if (recorded) { try { deps.store.forgetIdempotentStart(scope); } catch { /* the next start under the lock finds no contract and forgets it */ } }
          throw error;
        }
        return { fingerprint, started: { contract: started.contract, ownerAgentId: started.owner.id, replayed: false } };
      } finally { lock.release(); }
    })();
    idempotentStarts.set(scope, operation);
    try { return (await operation).started; }
    finally { if (idempotentStarts.get(scope) === operation) idempotentStarts.delete(scope); }
  }

  function startFromPlan(input: StartFromPlanInput, options: ContractStartOptions = {}): Promise<StartedContract> {
    if (disposed) throw new Error('Contract runner is disposed');
    const { draft, ...rest } = { ...input, ...captureStartInput(input) };
    const draftPlan = numberDraft(draft);
    const id = newContractId(), creation = reserveCreation(id);
    return (async () => {
      let owner: AgentRecord | undefined;
      try {
        const prepared = await prepareStart(rest, id, options, creation);
        prepared.current();
        owner = spawnOwner(rest, id); prepared.current();
        return create(rest, id, owner, { ...prepared, draftPlan, creation });
      } catch (error) { failedStart(id, owner, creation); throw error; }
      finally { creation.release(); }
    })();
  }

  function startForOwner(record: AgentRecord, options: ContractStartOptions = {}, requireSettlement = false): Promise<StartedContract> {
    if (deps.nativeDecisions !== undefined) throw new Error('Native agent starts require source-bearing host admission');
    if (disposed) throw new Error('Contract runner is disposed');
    if (record.contractId !== undefined) throw new Error(`agent ${record.id} already belongs to contract ${record.contractId}`);
    const id = newContractId();
    const sourceOf = getContractActionSource(record), ownerSignal = getContractActionSignal(record);
    const source = sourceOf === undefined ? undefined : captureAutonomousSource(sourceOf());
    const sourceIsCurrent = source === undefined ? undefined : retainAutonomousSource(source);
    const original = { id: record.id, task: record.task, directory: record.workingDirectory, parent: record.parentAgentId,
      proposed: record.proposedUnits?.map(unit => ({ ...unit })) };
    const input = captureStartInput({
      ask: source?.goal ?? original.task,
      // The contract belongs to the session that started its owner agent.
      sessionId: record.sessionId ?? AGENT_MANAGER_SESSION_ID,
      origin: 'agent-tool',
      projectRoot: record.workingDirectory ?? deps.projectRoot,
      ...(record.parentAgentId === undefined ? {} : { parentAgentId: record.parentAgentId }),
      ...(record.proposedUnits === undefined ? {} : { proposedUnits: record.proposedUnits }),
    });
    let bound = false;
    const recordCurrent = (): void => {
      if (record.id !== original.id || record.task !== original.task || record.workingDirectory !== original.directory
        || record.parentAgentId !== original.parent || !isDeepStrictEqual(record.proposedUnits, original.proposed)
        || record.contractId !== (bound ? id : undefined) || record.status === 'cancelled' || record.status === 'failed'
        || record.status === 'completed' || getContractActionSource(record) !== sourceOf || getContractActionSignal(record) !== ownerSignal
        || (bound && (record.contractRole !== 'owner' || record.reviewMode !== 'contract'))
        || (sourceOf && sourceIsCurrent && !sourceIsCurrent(sourceOf()))) throw new Error('The original contract owner changed during preparation');
    };
    const creation = reserveCreation(id);
    return (async () => {
      try {
        const prepared = await prepareStart(input, id, options, creation, recordCurrent, ownerSignal);
        prepared.current();
        record.contractId = id; record.contractRole = 'owner'; record.reviewMode = 'contract'; bound = true;
        startContractOwner(record, { contractId: id, contractRole: 'owner', progress: `Contract ${id}: queued`, settled: reserveSettlement(id).promise }, deps.runtimeBus);
        prepared.current();
        return create(input, id, record, { ...prepared, creation }, requireSettlement);
      } catch (error) { if (bound) failedStart(id, record, creation); throw error; }
      finally { creation.release(); }
    })();
  }

  function assertOwnedExecution(): void {
    if (disposed) throw new Error('Contract runner is disposed');
    if (typeof deps.agentManager.join !== 'function') throw new Error('Owned contract requires agent execution settlement');
  }

  function startOwnedForOwner(record: AgentRecord, options: ContractStartOptions = {}): Promise<OwnedStartedContract> {
    assertOwnedExecution();
    return startForOwner(record, options, true).then(started => ({
      ...started,
      settled: started.settled!,
      cancel: (reason) => {
        const run = runs.get(started.contract.id);
        return run === undefined ? false : cancelRun(run, reason);
      },
    }));
  }

  /** The owner record parents and surfaces wait on; it runs no executor. */
  function spawnOwner(input: Omit<StartContractInput, 'proposedUnits'>, id: string, restoredOwnerId?: string): AgentRecord {
    return deps.agentManager.spawn(
      {
        mode: 'spawn',
        task: input.ask,
        template: 'orchestrator',
        outsideContract: true,
        sessionId: input.sessionId,
        ...(input.selectedModel === undefined ? {} : { model: input.selectedModel.registryKey, provider: input.selectedModel.provider }),
        ...(input.parentAgentId === undefined ? {} : { parentAgentId: input.parentAgentId }),
      },
      { contractId: id, contractRole: 'owner', progress: `Contract ${id}: queued`, settled: reserveSettlement(id).promise,
        ...(restoredOwnerId === undefined ? {} : { restoredOwnerId }) },
    );
  }

  function create(
    input: Omit<StartContractInput, 'proposedUnits'> & Pick<StartContractInput, 'proposedUnits'>,
    id: string,
    owner: AgentRecord,
    extra: Pick<Contract, 'draftPlan' | 'durableAdmission'> & {
      readonly execution: DurableContractExecution;
      readonly creation: ContractCreationReservation;
      readonly signal?: AbortSignal;
      readonly current?: () => void;
    },
    requireSettlement = false,
    deferAdmission = false,
  ): StartedContract {
    const config = env.config();
    extra.current?.();
    const execution = extra.execution;
    const isolation = execution.isolation;
    const sourceOf = getContractActionSource(owner);
    const originalSource = input.nativeSource === undefined && sourceOf ? captureAutonomousSource(sourceOf()) : undefined;
    const contract: Contract = {
      id,
      ...(input.selectedModel === undefined ? {} : { selectedModel: input.selectedModel }),
      ...(extra.durableAdmission === undefined ? {} : { durableAdmission: extra.durableAdmission, durableLaunchState: 'prepared' as const }),
      schemaVersion: CURRENT_CONTRACT_SCHEMA_VERSION,
      sessionId: input.sessionId,
      origin: input.origin,
      ...(input.ownerPrincipalId === undefined ? {} : { ownerPrincipalId: input.ownerPrincipalId }),
      ask: input.ask,
      ...(originalSource ? { originalSource, taskEvidence: [owner.task, input.taskEvidence].filter(Boolean).join('\n\n') } : input.taskEvidence === undefined ? {} : { taskEvidence: input.taskEvidence }),
      ownerAgentId: owner.id,
      ...(input.parentAgentId === undefined ? {} : { parentAgentId: input.parentAgentId }),
      projectRoot: input.projectRoot,
      ...execution,
      ...(input.budget === undefined ? {} : { budget: input.budget }),
      ...(input.nativeSource === undefined ? {} : { nativeSource: input.nativeSource }),
      goal: input.nativeSource?.goal ?? originalSource?.goal ?? '',
      criteria: input.nativeSource === undefined ? [] : nativeSourceCriteria(input.nativeSource),
      groups: [],
      units: [],
      status: 'queued',
      checks: [],
      fixRounds: 0,
      escalations: [],
      decisions: [],
      usage: emptyWorkItemUsage(),
      judgmentUsage: { calls: 0, inputTokens: 0, outputTokens: 0 },
      plannerAgentIds: [],
      ...(input.proposedUnits === undefined ? {} : { proposedUnits: input.proposedUnits }),
      ...(extra.draftPlan === undefined ? {} : { draftPlan: extra.draftPlan }),
      createdAt: now(),
    };
    bindNativeContractSource(contract);
    bindOwnedContractSource(contract, owner);
    if (extra.signal) {
      const originalSignal = getContractActionSignal(contract);
      bindContractActionSignal(contract, originalSignal ? AbortSignal.any([originalSignal, extra.signal]) : extra.signal);
    }
    extra.current?.();
    // Complete exclusive first publication precedes run registration. A
    // competing/history ID survives every placement/spawn/persistence hook.
    extra.creation.assertCurrent();
    deps.store.publishCreation(extra.creation, contract);
    const run = newRun(contract);
    run.requireSettlement = requireSettlement;
    deps.store.put(contract);
    extra.current?.();
    extra.creation.assertCurrent();
    // No executor or creation event is admitted until actual claim cleanup
    // succeeds. Future creators now see the durable initial checkpoint.
    extra.creation.release();
    // A gate that cannot run is said once here, to the owner, before any check
    // reports it as a failure to a worker.
    const gateProblems = contractGateProblems(deps.configManager);
    run.decide('created', id, `origin ${input.origin}; ${isolation} isolation${extra.draftPlan === undefined ? '' : `; ${extra.draftPlan.units.length} drafted units`}`
      + (gateProblems.length === 0 ? '' : `; gate settings: ${gateProblems.join(' ')}`));
    run.emit({ type: 'CONTRACT_CREATED', contractId: id, sessionId: input.sessionId, origin: input.origin, ask: input.ask, ownerAgentId: owner.id,
      ...(gateProblems.length === 0 ? {} : { gateProblems }) });
    if (owner.status === 'cancelled') cancelRun(run, 'the owner was cancelled during spawn');
    if (run.terminal || deferAdmission) {
      // Re-entrant creation/spawn listeners can stop the owner before admission.
    } else if (activeCount() < config.maxActiveContracts) {
      admit(run);
    } else {
      queue.push(run);
      run.decide('queued', id, `${config.maxActiveContracts} contracts are active; waiting for a slot`);
    }
    return { contract: run.view(), owner, settled: reserveSettlement(id).promise };
  }

  /** A run of this runner for the contract, registered by id. */
  function newRun(contract: Contract): ContractRun {
    const run: ContractRun = new ContractRun(contract, env, {
      passGroup: (groupId) => groups.passGroup(run, groupId),
      finishPassed: (result) => finishPassed(run, result),
      fail: (kind, reason) => fail(run, kind, reason),
      cancel: (reason) => cancelRun(run, reason),
    }, contract.proposedUnits, new ContractExecutionWork(reserveSettlement(contract.id).promise));
    reserveSettlement(contract.id);
    runs.set(contract.id, run);
    // A resumed contract already holds its claim; a new contract's id is unused, so this only records it. A new id is
    // fresh randomness no other process can be running, so a claim that cannot be made only goes unrecorded.
    const claim = claimProcessLease(contract.id);
    if (typeof claim === 'object') logger.warn('contract runner: the run claim could not be taken', { contractId: contract.id, reason: claim.unavailable });
    const sourceSignal = getContractActionSignal(contract);
    if (sourceSignal) {
      // Runner shutdown retires this signal too. Its normal disposal path
      // preserves both contract and workstream checkpoints for restart.
      const cancel = () => { if (!disposed) cancelRun(run, 'Original source owner cancelled'); };
      sourceSignal.addEventListener('abort', cancel, { once: true });
      run.abort.signal.addEventListener('abort', () => sourceSignal.removeEventListener('abort', cancel), { once: true });
      if (sourceSignal.aborted) cancel();
    }
    return run;
  }

  function plannerDeps(run: ContractRun): ContractPlannerDeps {
    return {
      readOwnerEvidence: deps.readOwnerEvidence,
      native,
      onPlannerStarted: () => {
        deps.store.put(run.contract);
        if (!deps.store.write(run.contract.id)) throw new Error('Active planner checkpoint failed');
      },
      decompositionRunner: deps.decompositionRunner,
      routeSelector: deps.routeSelector,
      configManager: deps.configManager,
      emit: (event) => run.emit(event),
      ...(deps.repositoryMap === undefined ? {} : { repositoryMap: deps.repositoryMap }),
      readAccessFilter: deps.readAccessFilter,
      now,
      ...(deps.wait === undefined ? {} : { wait: deps.wait }),
    };
  }

  /** Admit one local generation before shaping, repository mapping or planner execution. */
  async function prepareInput(run: ContractRun): Promise<void> {
    const { contract } = run;
    if (contract.inputSnapshot !== undefined) {
      pinContractInputAdmission(contract, run.abort.signal);
      await assertContractInputView(contract.inputSnapshot, run.abort.signal);
      if (contract.isolation === 'worktree') assertContractExecutionView(contract.inputSnapshot, contract.worktreePath!, contract.branch!);
      return;
    }
    if (contract.isolation !== 'worktree') return;
    if (contract.schemaVersion < 2) throw new Error('legacy worktree contract has no recorded input receipt; manual recovery is required');
    const snapshot = await captureContractInput(contract.projectRoot, { signal: run.abort.signal });
    contract.inputSnapshot = snapshot;
    pinContractInputAdmission(contract, run.abort.signal);
    // Persist provenance before any workspace/model admission. Partial creation is retained and holds recovery.
    if (!deps.store.write(contract.id)) throw new Error('contract input receipt could not be persisted');
    run.abort.signal.throwIfAborted();
    const inputPath = contractInputPath(snapshot);
    await prepareContractInputParent(snapshot, inputPath);
    await prepareContractInputParent(snapshot, contract.worktreePath!);
    await new IsolatedWorktree(contract.projectRoot, inputPath, `contract-input/${snapshot.id}`, contract.baseBranch ?? 'main').create(snapshot.inputCommit, false);
    await materializeContractInput(snapshot, inputPath, run.abort.signal);
    run.abort.signal.throwIfAborted();
    await new IsolatedWorktree(contract.projectRoot, contract.worktreePath!, contract.branch!, contract.baseBranch ?? 'main').create(snapshot.inputCommit, false);
    await materializeContractInput(snapshot, contract.worktreePath!, run.abort.signal);
    run.decide('created', contract.id, `admitted local input generation ${snapshot.id}; captured tree ${snapshot.inputTree}`);
  }

  /** Shapes and plans a contract, then runs its groups. */
  async function activate(run: ContractRun): Promise<void> {
    const { contract } = run;
    try {
      run.abort.signal.throwIfAborted();
      await prepareInput(run);
      if (run.terminal) return;
      const shaped = await shapeContract(contract, plannerDeps(run), { signal: run.abort.signal });
      if (contract.shape !== undefined) settleSessionMode(run);
      if (!proceed(run, shaped)) return;
      const planned = await planContract(contract, plannerDeps(run), { proposedUnits: run.proposedUnits, signal: run.abort.signal });
      await continuePlanning(run, planned);
    } catch (error) {
      if (run.terminal) return;
      const failure = failureFromError(error);
      fail(run, failure.kind, `contract ${contract.id} could not start: ${failure.reason}`);
    }
  }

  /** Plans a shaped contract from the beginning (a restart stopped its planning), then runs the accepted plan. */
  async function replan(run: ContractRun): Promise<void> {
    try {
      run.abort.signal.throwIfAborted();
      await prepareInput(run);
      if (run.terminal) return;
      const planned = await planContract(run.contract, plannerDeps(run), { proposedUnits: run.proposedUnits, signal: run.abort.signal });
      await continuePlanning(run, planned);
    } catch (error) {
      if (run.terminal) return;
      const failure = failureFromError(error);
      fail(run, failure.kind, `contract ${run.id} could not plan again: ${failure.reason}`);
    }
  }

  /**
   * The user forbade delegation (6.6): the session's own turns do the one
   * unit in the project's own tree, so the contract runs in shared mode with
   * no contract branch.
   */
  function settleSessionMode(run: ContractRun): void {
    const { contract } = run;
    if (contract.shape === undefined || !delegationForbidden(contract.shape) || contract.sessionMode === true) return;
    contract.sessionMode = true;
    contract.isolation = 'shared';
    contract.branch = undefined;
    contract.worktreePath = undefined;
    contract.baseBranch = undefined;
    run.decide('shaped', contract.id, 'session mode: the user does not allow delegating, so the session does the work and no sub-agent is spawned');
  }

  /** Whether planning goes on after a shaping or planning outcome; settles the contract when it ended there. */
  function proceed(run: ContractRun, outcome: ShapeOutcome | PlanningOutcome): boolean {
    if (outcome.kind === 'shaped' || outcome.kind === 'accepted') return !run.terminal;
    if (outcome.kind === 'failed') settleEnded(run);
    if (outcome.kind === 'cancelled' && run.contract.nativeSource !== undefined && !run.terminal) cancelRun(run, 'Native judgment was cancelled or superseded');
    // A planner stopped while the contract still runs leaves nothing to run: say so instead of waiting.
    else if (outcome.kind === 'cancelled' && !run.terminal) fail(run, 'planning', `contract ${run.id} has no plan: its planner was stopped before it produced one`);
    if (outcome.kind === 'awaiting-owner') updateOwnerProgress(run);
    return false;
  }

  /** After planning, or an owner reply that settled the shape or the plan: plan on, or start the accepted plan. */
  async function continuePlanning(run: ContractRun, outcome: ShapeOutcome | PlanningOutcome): Promise<void> {
    const { contract } = run;
    if (outcome.kind === 'shaped') {
      settleSessionMode(run);
      const planned = await planContract(contract, plannerDeps(run), { proposedUnits: run.proposedUnits, signal: run.abort.signal });
      await continuePlanning(run, planned);
      return;
    }
    if (!proceed(run, outcome)) return;
    if (contract.sessionMode === true) {
      await startSession(run);
      updateOwnerProgress(run);
      return;
    }
    if (contract.isolation === 'worktree' && (contract.inputSnapshot === undefined || contract.worktreePath === undefined || !existsSync(contract.worktreePath))) throw new Error('contract input workspace is missing; automatic recapture is not allowed');
    groups.startRun(run);
    updateOwnerProgress(run);
  }

  // ── Session mode ───────────────────────────────────────────────

  /**
   * A session-mode contract runs: its one unit waits for the session's next
   * turn. The session's turns write in the shared tree, so the contract holds
   * the same shared-tree lock a shared-mode group takes, until it settles
   * (waiting for another holder is recorded). Its baseline is taken once and
   * is also each unit's, so a session turn finds it set.
   */
  async function startSession(run: ContractRun): Promise<void> {
    const { contract } = run;
    await takeSharedTreeForGroup(run, SESSION_TREE_HOLDER);
    if (run.terminal) return;
    contract.baseline ??= await captureTreeBaseline(contract.projectRoot);
    if (run.terminal) return;
    for (const unit of contract.units) unit.baseline ??= contract.baseline;
    run.moveContract('running');
    for (const group of contract.groups) run.moveGroup(group, 'running');
    for (const unit of contract.units) run.moveUnit(unit, 'running');
    run.decide('spawned', contract.id, 'session mode: the session\'s next turn takes the work; no sub-agent is spawned');
  }

  /**
   * The session-mode unit waiting for work in a session. `except` names contracts the caller has fenced (a
   * cancel still in flight), so the next waiting contract is not held behind one that is already ending.
   */
  function sessionUnit(sessionId: string, except?: ReadonlySet<string>): { readonly run: ContractRun; readonly unit: ContractRun['contract']['units'][number] } | null {
    for (const run of runs.values()) {
      if (run.terminal || run.contract.sessionMode !== true || run.contract.sessionId !== sessionId || except?.has(run.id) === true) continue;
      const unit = run.contract.units.find((candidate) => candidate.status === 'running' || candidate.status === 'nudged');
      if (unit !== undefined) return { run, unit };
    }
    return null;
  }

  /** A session-mode unit passed: its group is judged, as a group whose units all passed. */
  function sessionUnitPassed(run: ContractRun, unit: ContractRun['contract']['units'][number]): void {
    const group = run.group(unit.groupId);
    if (group === undefined || group.status !== 'running' || run.settledGroups.has(group.id)) return;
    if (!run.contract.units.filter((candidate) => candidate.groupId === group.id).every((candidate) => candidate.status === 'passed')) return;
    run.settledGroups.add(group.id);
    void steps.groupUnitsPassed(run, group.id);
  }

  function updateOwnerProgress(run: ContractRun): void {
    setOwnerProgress(run.contract);
  }

  function setOwnerProgress(contract: Contract): void {
    const owner = getStatus(contract.ownerAgentId);
    if (owner !== null && owner.status === 'running') setAgentProgress(owner, ownerProgress(contract), 'operator');
  }

  // ── Ending ──────────────────────────────────────────────────────────────────

  /** Settles the owner record from the contract's terminal status and frees the slot. */
  function settleEnded(run: ContractRun): void {
    if (run.contract.nativeSource !== undefined) {
      if (run.contract.nativeProgress?.state !== 'refused') run.contract.nativeProgress = undefined;
      run.contract.nativeWaiting = undefined;
      for (const key of Object.keys(run.contract.nativeDecisions?.pending ?? {})) delete run.contract.nativeDecisions!.pending[key];
    }
    const { contract } = run;
    if (!isTerminalContractStatus(contract.status) || run.ownerSettled) return;
    run.ownerSettled = true;
    // settleWork writes the terminal state after all admitted work has drained,
    // before releasing the execution lease. join reports executor drainage.
    settleWork(run);
    run.abort.abort();
    groups.stopRun(run);
    rollUpContractUsage(contract, getStatus, pricing);
    const owner = getStatus(contract.ownerAgentId);
    if (owner !== null) {
      const totals = ownerRecordUsage(contract, getStatus);
      owner.usage = totals.usage;
      owner.toolCallCount = totals.toolCallCount;
      owner.completedAt = now();
      const statusLine = contract.statusLine ?? `Contract ${contract.id} ${contract.status}${contract.error ? `: ${contract.error}` : ''}`;
      contract.statusLine = statusLine;
      setAgentProgress(owner, statusLine, 'operator');
      const ctx = { sessionId: contract.sessionId, traceId: `${contract.sessionId}:contract:${contract.id}:owner`, source: 'contract-runner', agentId: owner.id };
      const durationMs = Math.max(0, owner.completedAt - owner.startedAt);
      if (contract.status === 'passed') {
        owner.status = 'completed';
        owner.fullOutput = contract.answer ?? '';
        emitAgentCompleted(deps.runtimeBus, ctx, { agentId: owner.id, durationMs, output: owner.fullOutput, toolCallsMade: owner.toolCallCount, usage: owner.usage });
      } else if (contract.status === 'failed') {
        owner.status = 'failed';
        owner.error = contract.error ?? 'the contract failed';
        emitAgentFailed(deps.runtimeBus, ctx, { agentId: owner.id, durationMs, error: owner.error });
      } else {
        owner.status = 'cancelled';
        emitAgentCancelled(deps.runtimeBus, ctx, { agentId: owner.id, reason: contract.error ?? 'the contract was cancelled' });
      }
    }
    const index = queue.indexOf(run);
    if (index !== -1) queue.splice(index, 1);
    runs.delete(run.id);
    admitted.delete(run.id);
    dequeue();
  }

  function membersSettled(contract: Contract): boolean {
    return contractAgentIds(contract).every((agentId) => {
      const status = getStatus(agentId)?.status;
      return status === undefined || status === 'completed' || status === 'failed' || status === 'cancelled';
    });
  }

  /** Fails the contract. `settled` states the members settled (a zombie's agents did not survive the restart); otherwise it is read from their records. */
  function fail(run: ContractRun, kind: ContractFailureKind, reason: string, settled?: boolean): void {
    if (run.terminal) return;
    const { contract } = run;
    contract.failureKind = kind;
    contract.error = reason;
    contract.completedAt = now();
    run.moveContract('failed');
    run.endOpenUnits('cancelled', reason);
    run.abort.abort();
    groups.stopRun(run);
    contract.statusLine = failureStatusLine(contract, reason);
    run.decide('failed', contract.id, reason);
    run.emit({ type: 'CONTRACT_FAILED', contractId: contract.id, reason, failureKind: kind, membersSettled: settled ?? membersSettled(contract) });
    settleEnded(run);
  }

  function cancelRun(run: ContractRun, reason: string): boolean {
    if (run.terminal) return false;
    const { contract } = run;
    contract.error = reason;
    contract.completedAt = now();
    run.moveContract('cancelled');
    run.endOpenUnits('cancelled', reason);
    run.abort.abort();
    groups.stopRun(run);
    const count = filesModified(contract);
    const where = contract.isolation === 'worktree' && contract.branch !== undefined ? `on branch ${contract.branch}` : 'on disk';
    contract.statusLine = `Contract ${contract.id} cancelled; ${count} file${count === 1 ? '' : 's'} already modified ${where}`;
    run.decide('cancelled', contract.id, reason);
    run.emit({ type: 'CONTRACT_CANCELLED', contractId: contract.id, reason, filesModified: count });
    settleEnded(run);
    return true;
  }

  /**
   * A contract whose checkpoint cannot be written reads healthy until the process exits and the work is lost.
   * The read view says so; the stored contract is left as it is, so the warning is never itself persisted.
   */
  function withCheckpointWarning<T extends Pick<ContractView, 'id' | 'status' | 'statusLine'>>(view: T): T {
    const failure = deps.store.writeFailure(view.id);
    if (failure === null) return view;
    const base = view.statusLine ?? `Contract ${view.id} ${view.status}`;
    return { ...view, statusLine: `${base} (warning: ${failure.message} Progress since the last saved checkpoint is not durable.)` };
  }

  function finishPassed(run: ContractRun, result: { readonly answer: string; readonly statusLine: string }): void {
    if (run.terminal) return;
    const { contract } = run;
    const unmet = contract.units.filter((unit) => unit.status !== 'passed');
    if (unmet.length > 0) throw new Error(`contract ${contract.id} cannot pass while units ${unmet.map((unit) => unit.id).join(', ')} have not passed`);
    contract.answer = result.answer;
    contract.statusLine = result.statusLine;
    contract.completedAt = now();
    run.moveContract('passed');
    const judged = contract.criteria.filter((criterion) => criterion.disposition === 'judged');
    run.decide('passed', contract.id, result.statusLine);
    run.emit({
      type: 'CONTRACT_PASSED',
      contractId: contract.id,
      criteriaMet: judged.filter((criterion) => criterion.status === 'met').length,
      criteriaJudged: judged.length,
      excluded: contract.criteria.filter((criterion) => criterion.disposition === 'excluded').length,
      nudges: run.allUnits().reduce((total, unit) => total + unit.nudges.length, 0),
    });
    settleEnded(run);
  }

  // ── Resume ─────────────────────────────────────────────────────

  const resume = createContractResume({
    nativeOnly: deps.nativeDecisions !== undefined,
    store: deps.store,
    isLive: (contractId) => runs.has(contractId) || heldContracts.has(contractId),
    claim: claimProcessLease,
    hold: (contract, code, reason) => {
      deps.store.hold(contract);
      heldContracts.set(contract.id, { code, reason, at: now() });
      // A contract held without its claim is not this process's: nothing keeps a claim it never got.
      if (code === 'claim-unavailable') releaseProcessLease(contract.id);
    },
    adopt: (contract) => {
      deps.store.hold(contract);
      const run = newRun(contract);
      const owner = getStatus(contract.ownerAgentId);
      if (owner === null || (owner.contractId === contract.id && owner.contractRole === 'owner'
        && owner.status !== 'running' && owner.status !== 'pending')) {
        spawnOwner(contract, contract.id, contract.ownerAgentId);
        updateOwnerProgress(run);
      }
      return run;
    },
    hasSlot: () => activeCount() < env.config().maxActiveContracts,
    takeSlot: (run) => { admitted.add(run.id); },
    enqueue: (run) => { queue.push(run); },
    fail,
    failUnit: (run, unit, kind, reason) => failures.failUnit(run, unit, kind, reason),
    groups,
    checks,
    steps,
    activate: (run) => run.work.run('activate', () => activate(run)),
    plan: (run) => run.work.run('replan', () => replan(run)),
    sessionUnitPassed,
    ownerProgress: updateOwnerProgress,
  });

  const fleetControls = createContractFleetControls({
    runs: () => runs.values(),
    operatorPick: (run, unitId, attemptId) => steps.operatorPick(run, unitId, attemptId),
  });

  // ── The API ─────────────────────────────────────────────────────────────────

  return {
    nativeMode: deps.nativeDecisions !== undefined,
    startDurable,
    resumeDurable,
    start,
    startIdempotent,
    startFromPlan,
    startForOwner,
    startOwnedForOwner,
    assertOwnedExecution,
    inspectDurable(key) { const admission = durableAdmissions.read(key); return admission === null ? null : durableResult(admission); },
    async joinDurable(key) {
      const admission = durableAdmissions.read(key); if (!admission) throw new DurableContractAdmissionError('missing');
      await (settlements.get(admission.contractId)?.promise ?? Promise.resolve());
      // No status bit certifies drainage while another process still owns effects.
      const release = await durableAdmissions.lease(key);
      try { if (!isTerminalContractStatus(durableResult(admission).contract.status)) throw new DurableContractAdmissionError('checkpoint'); }
      finally { release(); }
    },
    join: (contractId) => settlements.get(contractId)?.promise ?? Promise.resolve(),
    inspectIntegration: (contractId) => inspectContractIntegration(runs.get(contractId), disposed),
    get: (contractId) => {
      const contract = deps.store.get(contractId) ?? deps.store.ended(contractId);
      return contract === null ? null : withCheckpointWarning(structuredClone(contract));
    },
    list: (filter = {}) => {
      const held = deps.store.list();
      // Ended contracts are listed from their summaries; only those the filter keeps are read.
      const heldIds = new Set(held.map((contract) => contract.id));
      const ended = filter.includeTerminal !== true ? [] : deps.store.listEnded()
        .filter((summary) => !heldIds.has(summary.id) && (filter.sessionId === undefined || summary.sessionId === filter.sessionId)
          && (filter.admit === undefined || filter.admit(summary)))
        .flatMap((summary) => { const contract = deps.store.ended(summary.id); return contract === null ? [] : [contract]; });
      return [...held.filter((contract) => filter.admit === undefined || filter.admit(contract)), ...ended]
        .filter((contract) => filter.sessionId === undefined || contract.sessionId === filter.sessionId)
        .filter((contract) => filter.includeTerminal === true || !isTerminalContractStatus(contract.status))
        .map((contract) => withCheckpointWarning(structuredClone(filter.includeInputSnapshot === false
          ? { ...contract, inputSnapshot: undefined } : contract)));
    },
    remove: (contractId) => {
      if (runs.has(contractId) || settling.has(contractId) || settlements.has(contractId)) return 'not-ended';
      return deps.store.remove(contractId);
    },
    retryUnit: async (contractId, unitId) => {
      const refused = (reason: string): UnitRetryOutcome => ({ outcome: 'refused', reason });
      const run = runs.get(contractId);
      if (run === undefined || run.terminal) return refused(`contract ${contractId} is not running here; an ended contract is run again by starting a new one with the request`);
      const unit = run.unit(unitId);
      if (unit === undefined) return refused(`contract ${contractId} has no unit ${unitId}; its units are ${run.contract.units.map((candidate) => candidate.id).join(', ') || 'not planned yet'}`);
      if (run.contract.sessionMode === true) return refused(`unit ${unit.id} is worked by the session itself; continue in that session`);
      if (unit.status === 'passed' || unit.status === 'held-merge') {
        const itemId = unit.attemptUnits === undefined ? unit.id : unit.attemptSelection?.pickedId;
        const commit = itemId === undefined || run.engine === null ? null : await run.engine.retryItemCommit(itemId);
        if (commit === null) {
          return refused(itemId === undefined
            ? `unit ${unit.id} waits for one of its attempts to be picked; there is no commit to retry`
            : unit.status === 'held-merge'
              ? `unit ${unit.id} passed and its work is committed; it is waiting for its branch to merge, so there is no commit to retry`
              : `unit ${unit.id} passed and its work is recorded; there is nothing to retry`);
        }
        if (commit.status === 'failed') return refused(`unit ${unit.id}'s commit failed again: ${commit.reason ?? 'no reason given'}; its changes are still uncommitted in its working tree and its branch is not merged until the commit lands`);
        const merged = run.contract.isolation === 'worktree' ? '; its branch was handed to the merge' : '';
        return { outcome: 'committed', reason: commit.status === 'committed' ? `unit ${unit.id}'s changes were committed (${commit.hash ?? 'no hash'})${merged}` : `unit ${unit.id} had nothing left to commit${merged}` };
      }
      // A failed unit waits on its owner's retry-or-cancel question: retrying it is answering "retry".
      const failurePause = run.contract.escalations.find((item) => item.resolvedAt === undefined && item.failurePause === true && item.scope === 'unit' && item.targetId === unit.id);
      if (failurePause !== undefined) {
        try { await steps.reply(run, failurePause.id, 'retry'); }
        catch (error) { if (error instanceof OwnerReplyRefusedError) return refused(error.message); throw error; }
        return { outcome: 'restarted', reason: `unit ${unit.id} failed and starts again with a fresh agent; the units waiting on it run once it passes` };
      }
      if (isTerminalUnitStatus(unit.status)) return refused(`unit ${unit.id} is ${unit.status}; the contract ended with it, so start a new contract for the remaining work`);
      if (unit.status === 'pending' || unit.status === 'blocked') return refused(`unit ${unit.id} has not started yet (${unit.status}); it starts once what it waits on is done`);
      if (unit.status === 'fixing') return refused(`a fix is being planned for unit ${unit.id}; retry it after the fix plan is in place`);
      groups.requeueUnit(run, unit, 'run again at the owner\'s request', 'fresh-unit');
      return { outcome: 'restarted', reason: `unit ${unit.id} starts again with a fresh agent` };
    },
    raiseBudget: (contractId, ceiling) => {
      const run = runs.get(contractId);
      if (run === undefined || run.terminal) return false;
      const previous = run.contract.budget;
      // A limit the owner did not name keeps its value: raising the cost ceiling never drops the token ceiling.
      const tokens = ceiling.maxTokens ?? previous?.maxTokens;
      const cost = ceiling.maxCostUsd ?? previous?.maxCostUsd;
      const budget: BudgetCeiling = { ...(tokens === undefined ? {} : { maxTokens: tokens }), ...(cost === undefined ? {} : { maxCostUsd: cost }) };
      // Each running group was given what remained of the old ceiling; it gets the difference on top.
      const moved = (now: number | undefined, before: number | undefined, next: number | undefined): number | undefined =>
        next === undefined ? undefined : now === undefined || before === undefined ? next : Math.max(0, now + (next - before));
      for (const workstream of run.engine?.listWorkstreams() ?? []) {
        const maxTokens = moved(workstream.budget?.maxTokens, previous?.maxTokens, budget.maxTokens);
        const maxCostUsd = moved(workstream.budget?.maxCostUsd, previous?.maxCostUsd, budget.maxCostUsd);
        const next: BudgetCeiling | undefined = maxTokens === undefined && maxCostUsd === undefined ? undefined
          : { ...(maxTokens === undefined ? {} : { maxTokens }), ...(maxCostUsd === undefined ? {} : { maxCostUsd }) };
        run.engine!.updateBudget(workstream.id, next);
      }
      Object.assign(run.contract, { budget });
      run.decide('owner-replied', run.id, `budget set to ${[budget.maxCostUsd === undefined ? '' : `$${budget.maxCostUsd}`, budget.maxTokens === undefined ? '' : `${budget.maxTokens} tokens`].filter(Boolean).join(' and ') || 'no ceiling'} by the owner`);
      if (run.contract.statusLine?.includes('its budget is used up') === true) run.contract.statusLine = undefined;
      deps.store.put(run.contract);
      return true;
    },
    cancel: (contractId, reason) => {
      const run = runs.get(contractId);
      if (run !== undefined) return cancelRun(run, reason);
      const hold = heldContracts.get(contractId);
      const contract = hold === undefined || disposed ? null : deps.store.get(contractId);
      // Only a hold this process has the run claim for may be settled here; without the claim another process may run it.
      if (hold === undefined || hold.code !== 'input-unavailable' || contract === null || isTerminalContractStatus(contract.status)) return false;
      heldContracts.delete(contractId);
      // The held contract becomes a run of this runner only to end: the ordinary cancel writes it cancelled,
      // settles its owner record and releases its claim once written.
      return cancelRun(newRun(contract), `${reason} (it was held: ${hold.reason})`);
    },
    held: (contractId) => heldContracts.get(contractId) ?? null,
    reply: async (contractId, escalationId, text) => {
      const run = runs.get(contractId);
      if (run === undefined || run.terminal) throw new OwnerReplyRefusedError(`contract ${contractId} is not running`, 'ended');
      // Only a failure pause (retry or cancel) is answerable on a native contract; it grants no approval.
      const failurePause = run.contract.escalations.some((item) => item.id === escalationId && item.failurePause === true);
      if (run.contract.nativeSource !== undefined && !failurePause) throw new OwnerReplyRefusedError('Native contracts do not accept owner approval replies', 'unsupported');
      return steps.reply(run, escalationId, text);
    },
    pauseForOwnerRetry: (contractId, failure) => {
      const run = runs.get(contractId);
      if (run === undefined || run.terminal) throw new Error(`contract ${contractId} is not running`);
      // Synchronous on purpose: the caller must see the pause recorded before it does anything else.
      const escalationId = ownSteps.pauseForOwnerRetry(run, failure).id;
      // The paused contract gives up its slot: start whatever was waiting for one.
      dequeue();
      return { escalationId };
    },
    flushWorkPlan: () => boundedWait(planSync.flush(), WORK_PLAN_FLUSH_LIMIT_MS),
    resumeAll: () => resume.resumeAll(),
    importContract: (snapshotJson, force = false) => {
      // Replacing the stored object under a live run would leave that run
      // mutating a detached copy whose final checkpoint is then refused.
      const id = snapshotContractId(snapshotJson);
      if (id !== undefined && (runs.has(id) || settling.has(id))) {
        logger.warn('contract runner: import refused, the contract is running or still settling here; cancel it or wait for it to end first', { contractId: id });
        return false;
      }
      return deps.store.importContract(snapshotJson, force);
    },
    serializeContract: (contractId) => deps.store.serialize(contractId),
    hooks: () => checks.hooks,
    fleetControls: () => fleetControls,
    on,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const run of new Set([...runs.values(), ...settling.values()])) {
        const json = serializeContract(run.contract, now());
        const copy = json === null ? null : deserializeContract(json);
        if (copy) { retainOriginalReviewDescriptors(run.contract, copy); retainOriginalTreeBaselines(run.contract, copy); }
        disposalCheckpoints.set(run.id, copy);
      }
      watchdog.dispose();
      failures.dispose();
      // Disposal preserves a restart checkpoint; explicit cancel persists a
      // terminal outcome instead. Flush and detach writers before in-memory
      // cancellation can publish failed item states or late cleanup events.
      detachStore();
      detachPlanSync();
      // Admitted source signals include placementAbort. Retiring it before
      // the snapshot and writer detach would persist a user cancellation
      // instead of the resumable state above.
      placementAbort.abort(new Error('Contract runner is disposed'));
      for (const run of runs.values()) {
        run.unsubscribeEngine?.();
        run.unsubscribeEngine = null;
        run.engine?.dispose();
        run.abort.abort();
        for (const unit of run.allUnits()) {
          run.unitRuntimes.get(unit.id)?.abort.abort();
          run.releaseHold(unit);
        }
        groups.stopRun(run);
        settleWork(run);
      }
      // A held contract runs nothing: its claim goes now. A run's claim goes only once its work drained (settleWork
      // releases it after the final checkpoint), or, for work that does not drain within the deadline (a planner that
      // does not answer), once the close report names it still running, so a rebuilt runner can resume it.
      heldContracts.clear();
      const draining = new Set([...runs.keys(), ...settling.keys()]);
      for (const id of [...processLeases.keys()]) if (!draining.has(id)) releaseProcessLease(id);
      closing = closeDraining([...draining]);
      listeners.clear();
    },
    closed: () => closing ?? Promise.resolve(EMPTY_CLOSE_REPORT),
  };
}
