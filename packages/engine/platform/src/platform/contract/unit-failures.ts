/**
 * What a unit agent's terminal events mean to its contract
 * (docs/design/contract-runner.md sections 4.2, 4.9, 4.10 and 6.5).
 *
 * - Completed: the unit passed (its hold released) and its phase settles; an
 *   agent that completed without being held is checked now.
 * - Failed on its turn budget or the circuit breaker: checked with trigger
 *   `agent-failed`; a nudge wakes it.
 * - Failed otherwise: the step fails at once, with what failed in words (a
 *   connection to its model that failed and could not be made again, said as
 *   such, from the status and code its record carries; anything else in the
 *   agent's own words). Work runs nothing again by itself: the provider's
 *   transport already tried to make the connection again before the agent
 *   failed. The step's question (run it again, go on without it, stop) is
 *   put to the owner, in every mode (as released); a contract that cannot wait
 *   on it fails.
 * - Cancelled by anyone but the runner: an operator stopped a member, which
 *   stops the whole contract.
 * - Quiet: nothing. A step is never stopped, run again or failed for being
 *   quiet; it ends on one of the events above, or when the owner or a decision
 *   stops it.
 *
 * An attempt of a best-of-N unit that fails ends alone: its siblings go on,
 * and the selection reads the ones that passed (best-of-n.ts).
 *
 * A step run again is not a stall and not a fix round: the unit keeps its
 * checks, and the fresh agent's brief carries a "Previous checks" section.
 */
import { classifyFailure, type FailureEvidence } from '@goodvibes/engine/errors';
import type { AgentEvent } from '../../events/agents.js';
import type { CommunicationEvent } from '../../events/communication.js';
import { TURN_BUDGET_EXHAUSTED } from '../agents/turn-budget.js';
import { CIRCUIT_BREAKER_TRIPPED } from '../core/circuit-breaker.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { AgentRecord } from '../tools/agent/index.js';
import { logger } from '../utils/logger.js';
import type { UnitCheckLoop } from './agent-hooks.js';
import type { ContractRun } from './run-context.js';
import { isTerminalUnitStatus, type ContractFailureKind, type ContractUnit } from './types.js';

/** Whether the run waits at a failed step of agent-run work (its pause open), nothing else of it asked. */
function waitsAtFailedStep(run: ContractRun): boolean {
  return run.contract.sessionMode !== true && run.contract.status === 'awaiting-owner'
    && run.contract.escalations.some((entry) => entry.resolvedAt === undefined && entry.failurePause === true && entry.scope === 'unit');
}

/** A step named as a person reads it: its title, never its id. */
function stepName(unit: Pick<ContractUnit, 'id' | 'title'>): string {
  return `"${(unit.title || unit.id).replace(/\s+/g, ' ').trim()}"`;
}

/** The decision site a failed session turn's reading is logged under (the daemon's session driver). */
export const TRANSPORT_RETRY_SITE = 'contract.transport-retry';

/** A failed step's failure: the agent's message plus whatever structure its record kept. */
interface UnitFailureEvidence extends FailureEvidence {
  readonly retryAfterMs?: number | undefined;
}

export interface UnitFailureDeps {
  readonly runs: () => Iterable<ContractRun>;
  /**
   * True once the host that runs the work is closing (the daemon stopping): its agents end with it, which is
   * neither someone stopping the work nor a step failing. The runner keeps a restart checkpoint instead.
   */
  readonly hostClosing?: (() => boolean) | undefined;
  readonly agentManager: {
    getStatus(agentId: string): AgentRecord | null;
    cancel(agentId: string, kind?: 'interrupt' | 'kill'): boolean;
  };
  readonly runtimeBus: Pick<RuntimeEventBus, 'on'>;
  readonly checks: UnitCheckLoop;
  readonly failContract: (run: ContractRun, kind: ContractFailureKind, reason: string) => void;
  readonly cancelContract: (run: ContractRun, reason: string) => void;
  /**
   * Puts the failed step's question (run it again, go on without it, stop) to whoever decides it under the owner's
   * mode instead of failing the contract (escalation.ts `pauseFailedUnit`); false when the contract cannot wait on
   * it, and the unit and the contract fail.
   */
  readonly pauseFailedUnit?: ((run: ContractRun, unit: ContractUnit, reason: string) => boolean) | undefined;
}

/**
 * Statuses in which a unit's agent was let go on purpose: correction took the
 * unit (fixing), the owner has it (awaiting-owner), or a fresh agent is on its
 * way (pending, blocked). That agent completing or failing means nothing.
 */
const RELEASED: ReadonlySet<ContractUnit['status']> = new Set(['fixing', 'awaiting-owner', 'pending', 'blocked']);

export interface UnitFailureHandling {
  /**
   * Fails one unit. A unit of an agent-run contract has its question (run it
   * again, go on without it, stop) decided under the owner's mode when it can;
   * otherwise the contract fails with it. A failed attempt of
   * a best-of-N unit fails alone and is never a candidate.
   */
  failUnit(run: ContractRun, unit: ContractUnit, kind: ContractFailureKind, reason: string): void;
  /**
   * An agent's execution drained: when its record ended but no terminal event
   * for it was seen, the unit takes that end as if the event had arrived.
   */
  reconcile(agentId: string): void;
  dispose(): void;
}

/** Unit statuses in which the unit waits on its active agent to end. */
const AWAITING_AGENT: ReadonlySet<ContractUnit['status']> = new Set(['running', 'checking', 'nudged']);

export function createUnitFailureHandling(deps: UnitFailureDeps): UnitFailureHandling {
  // Unit agents whose terminal event arrived since they last started running.
  const ended = new Set<string>();

  function noteEnded(agentId: string): void {
    if (locate(agentId) !== null) ended.add(agentId);
  }

  function locate(agentId: string): { readonly run: ContractRun; readonly unit: ContractUnit } | null {
    for (const run of deps.runs()) {
      if (run.terminal) continue;
      const found = run.activeUnitOf(agentId);
      if (found !== null) return { run, unit: found.unit };
    }
    return null;
  }

  function failUnit(run: ContractRun, unit: ContractUnit, kind: ContractFailureKind, reason: string, decisionIds: readonly string[] = []): void {
    if (run.terminal) return;
    // Kept for the work's end if what comes next is to stop there: it then fails for this, in these words.
    unit.failureKind = kind;
    // The work already done is kept and the owner decides: one failed unit no longer throws away every unit that passed.
    if (unit.attemptOf === undefined && !isTerminalUnitStatus(unit.status) && deps.pauseFailedUnit?.(run, unit, reason) === true) {
      run.decide('failed', unit.id, `${reason}; the owner is asked whether it runs again`, decisionIds);
      return;
    }
    if (!isTerminalUnitStatus(unit.status)) {
      unit.failureReason = reason;
      run.releaseHold(unit);
      run.moveUnit(unit, 'failed');
      run.decide('failed', unit.id, reason, decisionIds);
    }
    run.settle(unit, 'failed');
    // The selection reads the unit's attempts once all of them ended (design 6.2).
    if (unit.attemptOf !== undefined) return;
    deps.failContract(run, kind, reason);
  }

  function onCompleted(agentId: string): void {
    noteEnded(agentId);
    const found = locate(agentId);
    if (found === null) return;
    const { run, unit } = found;
    if (unit.status === 'passed' || unit.status === 'held-merge') {
      run.settle(unit, 'completed');
      return;
    }
    if (isTerminalUnitStatus(unit.status) || RELEASED.has(unit.status)) return;
    // The loop completed without holding (no contract hooks in its run
    // context): the work was never checked at completion, so check it now; a
    // nudge wakes the completed agent.
    logger.warn('contract runner: a unit agent completed without a completion hold; checking it now', { contractId: run.id, unitId: unit.id, agentId });
    const runtime = run.runtime(unit);
    deps.checks.supersede(runtime);
    void deps.checks.runCheck(run, unit, 'completion');
  }

  function onFailed(agentId: string, error: string): void {
    noteEnded(agentId);
    // An agent cut off by the host closing has not failed its step.
    if (deps.hostClosing?.() === true) return;
    const found = locate(agentId);
    if (found === null) return;
    const { run, unit } = found;
    if (isTerminalUnitStatus(unit.status) || unit.status === 'held-merge' || RELEASED.has(unit.status)) return;
    const runtime = run.runtime(unit);
    deps.checks.supersede(runtime);
    const record = deps.agentManager.getStatus(agentId);
    const stop = record?.failureReason;
    if (stop === TURN_BUDGET_EXHAUSTED || stop === CIRCUIT_BREAKER_TRIPPED) {
      void deps.checks.runCheck(run, unit, 'agent-failed');
      return;
    }
    const evidence: UnitFailureEvidence = {
      message: record?.error?.trim() || error.trim() || 'the agent failed without an error message',
      ...(record?.failureStatus === undefined ? {} : { status: record.failureStatus }),
      ...(record?.failureCode === undefined ? {} : { code: record.failureCode }),
      ...(record?.failureRetryAfterMs === undefined ? {} : { retryAfterMs: record.failureRetryAfterMs }),
    };
    failStep(run, unit, evidence);
  }

  /**
   * The step failed: it ends failed at once, with what failed in words. Work runs nothing again on its own: the
   * provider's transport already tried to make its connection again before the agent failed. What comes next (run it
   * again, go on without it, or stop) is the failed step's question, put to the owner in every mode
   * (escalation.ts `pauseFailedUnit`).
   */
  function failStep(run: ContractRun, unit: ContractUnit, evidence: UnitFailureEvidence): void {
    const message = evidence.status === undefined ? evidence.message : `HTTP ${evidence.status}: ${evidence.message}`;
    const known = classifyFailure({ status: evidence.status, code: evidence.code, retryAfterMs: evidence.retryAfterMs });
    const connection = known !== undefined && known.category !== 'unknown' && known.category !== 'billing' && known.retryable;
    const kind: ContractFailureKind = connection ? 'transport' : 'other';
    failUnit(run, unit, kind, connection
      ? `step ${stepName(unit)} failed: the connection to its model failed and could not be made again (${message})`
      : `step ${stepName(unit)} failed: ${message}`);
  }

  function onCancelled(agentId: string): void {
    noteEnded(agentId);
    // The host is closing: every agent ends with it; the work stands as it was and is gone on with at the next start.
    if (deps.hostClosing?.() === true) return;
    for (const run of deps.runs()) {
      for (const runtime of run.unitRuntimes.values()) {
        if (runtime.expectedCancels.delete(agentId)) return;
      }
    }
    // The owner record is the contract as parents and surfaces see it: stopping it stops the contract.
    for (const run of deps.runs()) {
      // Work stopped at a failed step waits for the person, with nothing of it running: its owner record ending (the
      // daemon stopping takes every agent with it) is not someone stopping the work. It is stopped by its own control.
      if (!run.terminal && run.contract.ownerAgentId === agentId && waitsAtFailedStep(run)) return;
      if (!run.terminal && run.contract.ownerAgentId === agentId) {
        deps.cancelContract(run, `the contract's owner record ${agentId} was stopped by an operator`);
        return;
      }
    }
    const found = locate(agentId);
    if (found === null) return;
    // Work waiting at a failed step keeps waiting: a step's agent lost meanwhile (the daemon stopping) runs again when
    // the work is picked up again.
    if (waitsAtFailedStep(found.run)) return;
    deps.cancelContract(found.run, `the agent working on step ${stepName(found.unit)} was stopped by hand`);
  }

  function onConsumed(messageId: string, agentId: string, turn: number): void {
    for (const run of deps.runs()) {
      if (run.terminal) continue;
      for (const unit of run.allUnits()) {
        const nudge = unit.nudges.find((candidate) => candidate.id === messageId);
        if (nudge === undefined) continue;
        if (nudge.consumedAt !== undefined) return;
        nudge.consumedAt = run.env.now();
        run.emit({ type: 'CONTRACT_NUDGE_CONSUMED', contractId: run.id, unitId: unit.id, nudgeId: nudge.id, agentId, turn });
        if (unit.status === 'nudged' && unit.activeAgentId === agentId) run.moveUnit(unit, 'running');
        return;
      }
    }
  }

  function reconcile(agentId: string): void {
    const seen = ended.delete(agentId);
    if (seen) return;
    const found = locate(agentId);
    if (found === null || !AWAITING_AGENT.has(found.unit.status)) return;
    const record = deps.agentManager.getStatus(agentId);
    if (record === null) return;
    if (record.status !== 'failed' && record.status !== 'completed' && record.status !== 'cancelled') return;
    logger.warn('contract runner: a unit agent ended without a terminal event; taking its recorded end', { contractId: found.run.id, unitId: found.unit.id, agentId, status: record.status });
    if (record.status === 'failed') onFailed(agentId, record.error ?? '');
    else if (record.status === 'completed') onCompleted(agentId);
    else onCancelled(agentId);
    ended.delete(agentId);
  }

  const unsubscribers = [
    deps.runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_RUNNING' }>>('AGENT_RUNNING', ({ payload }) => { ended.delete(payload.agentId); }),
    deps.runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_COMPLETED' }>>('AGENT_COMPLETED', ({ payload }) => onCompleted(payload.agentId)),
    deps.runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_FAILED' }>>('AGENT_FAILED', ({ payload }) => onFailed(payload.agentId, payload.error)),
    deps.runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_CANCELLED' }>>('AGENT_CANCELLED', ({ payload }) => onCancelled(payload.agentId)),
    deps.runtimeBus.on<Extract<CommunicationEvent, { type: 'COMMUNICATION_CONSUMED' }>>('COMMUNICATION_CONSUMED', ({ payload }) => onConsumed(payload.messageId, payload.agentId, payload.turn)),
  ];

  return {
    failUnit,
    reconcile,
    dispose: () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
      ended.clear();
    },
  };
}
