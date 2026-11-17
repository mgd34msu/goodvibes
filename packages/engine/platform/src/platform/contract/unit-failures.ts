/**
 * What a unit agent's terminal events mean to its contract
 * (docs/design/contract-runner.md sections 4.2, 4.9, 4.10 and 6.5).
 *
 * - Completed: the unit passed (its hold released) and its phase settles; an
 *   agent that completed without being held is checked now.
 * - Failed on its turn budget or the circuit breaker: checked with trigger
 *   `agent-failed`; a nudge wakes it.
 * - Failed otherwise: the status and code the agent's record carries decide
 *   first, with no model request (5xx, 408, 429 and connection codes retry;
 *   401, 402, 403, 404 and other refusals of the request do not). Only a
 *   failure those tables cannot place is read by the decision model
 *   (`readFailure`, site `contract.transport-retry`); when that reading cannot
 *   be made (no model, policy off, unreachable) the failure is treated as
 *   transient, since an outage is exactly when agents fail. A transient failure
 *   is retried with a fresh agent, up to `contract.transportRetryLimit`; the
 *   wait is the provider's Retry-After when it gave one, otherwise
 *   `contract.transportRetryDelayMs` doubled for each retry already spent
 *   (at most a minute). Anything else fails the unit (`transport` for a
 *   transient fault past the limit, `other` otherwise): the unit waits on the
 *   owner to retry or cancel when it can, else the contract fails with it.
 * - Cancelled by anyone but the runner: an operator stopped a member, which
 *   stops the whole contract.
 * - Silent past `contract.heartbeatTimeoutMs`: the agent is killed and the unit
 *   retried once; the second time the contract fails.
 *
 * An attempt of a best-of-N unit that fails ends alone: its siblings go on,
 * and the selection reads the ones that passed (best-of-n.ts).
 *
 * A retry is not a stall and not a fix round: the unit keeps its checks, and
 * the fresh agent's brief carries a "Previous checks" section.
 */
import { classifyFailure, judgmentPort, readFailure, transienceFromReading, type FailureEvidence } from '@goodvibes-jev/engine/errors';
import type { AgentEvent } from '../../events/agents.js';
import type { CommunicationEvent } from '../../events/communication.js';
import { TURN_BUDGET_EXHAUSTED } from '../agents/turn-budget.js';
import { CIRCUIT_BREAKER_TRIPPED } from '../core/circuit-breaker.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { AgentRecord } from '../tools/agent/index.js';
import { logger } from '../utils/logger.js';
import type { UnitCheckLoop } from './agent-hooks.js';
import type { ContractRun, SpawnPurpose } from './run-context.js';
import { isTerminalUnitStatus, type ContractFailureKind, type ContractUnit } from './types.js';
import type { WatchedAgent } from './watchdog.js';
import { nativeContractPort } from './native-decisions.js';

/** The decision site the transport reading is logged under. */
export const TRANSPORT_RETRY_SITE = 'contract.transport-retry';

/** The longest a transport retry waits, whatever the backoff or the provider's Retry-After asks. */
const MAX_TRANSPORT_RETRY_DELAY_MS = 60_000;

/** A failure as the retry decision reads it: the agent's message plus whatever structure its record kept. */
interface UnitFailureEvidence extends FailureEvidence {
  readonly retryAfterMs?: number | undefined;
}

/** How the retry decision was reached, for the decision history. */
type RetryBasis = 'status' | 'reading' | 'no-reading';

interface RetryDecision {
  readonly retryable: boolean;
  readonly basis: RetryBasis;
  readonly retryAfterMs?: number | undefined;
  readonly decisionIds: readonly string[];
}

export interface UnitFailureDeps {
  readonly runs: () => Iterable<ContractRun>;
  readonly agentManager: {
    getStatus(agentId: string): AgentRecord | null;
    cancel(agentId: string, kind?: 'interrupt' | 'kill'): boolean;
  };
  readonly runtimeBus: Pick<RuntimeEventBus, 'on'>;
  readonly checks: UnitCheckLoop;
  readonly failContract: (run: ContractRun, kind: ContractFailureKind, reason: string) => void;
  readonly cancelContract: (run: ContractRun, reason: string) => void;
  /** Requeues the unit's work item for a fresh agent (brief plus "Previous checks", then `firstTurn` when given). */
  readonly requeueUnit: (run: ContractRun, unit: ContractUnit, reason: string, purpose: SpawnPurpose, firstTurn?: string) => void;
  /**
   * Asks the owner to retry or cancel a failed unit instead of failing the
   * contract (escalation.ts `pauseFailedUnit`); false when the contract cannot
   * wait on it, and the unit and the contract fail.
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
  /** The watchdog found an agent silent past the timeout. */
  onSilent(agent: WatchedAgent, silentMs: number): void;
  /**
   * Fails one unit. A unit of an agent-run contract waits on the owner (retry or
   * cancel) when it can; otherwise the contract fails with it. A failed attempt of
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

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
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
    // The work already done is kept and the owner decides: one failed unit no longer throws away every unit that passed.
    if (unit.attemptOf === undefined && !isTerminalUnitStatus(unit.status) && deps.pauseFailedUnit?.(run, unit, reason) === true) {
      run.decide('failed', unit.id, `${reason}; waiting for the owner to retry or cancel`, decisionIds);
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
    void run.work.run(() => retryOrFail(run, unit, agentId, evidence));
  }

  /** Whether the unit still waits on this failed agent: nothing released, replaced or ended it meanwhile. */
  function stillAwaits(run: ContractRun, unit: ContractUnit, agentId: string): boolean {
    return !run.terminal && unit.activeAgentId === agentId && !isTerminalUnitStatus(unit.status) && unit.status !== 'held-merge' && !RELEASED.has(unit.status);
  }

  /**
   * Whether a failure is worth a fresh agent. The status and code tables decide
   * whatever they can place; the model reads only the rest; a reading that
   * cannot be made counts as transient (bounded by the retry limit).
   */
  async function decideRetry(run: ContractRun, unit: ContractUnit, evidence: UnitFailureEvidence): Promise<RetryDecision> {
    const known = classifyFailure({ status: evidence.status, code: evidence.code, retryAfterMs: evidence.retryAfterMs });
    if (known !== undefined && known.category !== 'unknown') {
      return { retryable: known.retryable && known.category !== 'billing', basis: 'status', retryAfterMs: known.retryAfterMs, decisionIds: [] };
    }
    const runtime = run.runtime(unit);
    const signal = AbortSignal.any([run.abort.signal, runtime.abort.signal]);
    try {
      const reading = await readFailure(evidence, TRANSPORT_RETRY_SITE, run.contract.nativeSource === undefined ? undefined : {
        port: nativeContractPort(run.contract, run.env.native, judgmentPort(TRANSPORT_RETRY_SITE), signal), signal,
      });
      // Tables only: the decision model did not answer (off, unreachable, refused).
      if (reading.source === 'classic' && reading.category === 'unknown') return { retryable: true, basis: 'no-reading', decisionIds: [] };
      const retryable = !reading.billing && (reading.transientNetwork || reading.beforeResponse
        || (reading.category !== 'unknown' && transienceFromReading(reading).failureClass === 'retryable'));
      return { retryable, basis: 'reading', decisionIds: reading.decisionId === undefined ? [] : [reading.decisionId] };
    } catch {
      signal.throwIfAborted();
      return { retryable: true, basis: 'no-reading', decisionIds: [] };
    }
  }

  async function retryOrFail(run: ContractRun, unit: ContractUnit, agentId: string, evidence: UnitFailureEvidence): Promise<void> {
    const runtime = run.runtime(unit);
    const message = evidence.status === undefined ? evidence.message : `HTTP ${evidence.status}: ${evidence.message}`;
    let decision: RetryDecision;
    try {
      decision = await decideRetry(run, unit, evidence);
    } catch {
      // Only an abort reaches here: the contract or the unit was stopped meanwhile.
      return;
    }
    if (!stillAwaits(run, unit, agentId)) return;
    const config = run.env.config();
    if (!decision.retryable || unit.transportRetries >= config.transportRetryLimit) {
      const kind: ContractFailureKind = decision.retryable ? 'transport' : 'other';
      const why = decision.retryable
        ? `a transient failure after ${unit.transportRetries} retr${unit.transportRetries === 1 ? 'y' : 'ies'} (contract.transportRetryLimit is ${config.transportRetryLimit})`
        : 'a failure a retry cannot clear';
      failUnit(run, unit, kind, `unit ${unit.id} failed with ${why}: ${message}`, decision.decisionIds);
      return;
    }
    const delayMs = Math.min(MAX_TRANSPORT_RETRY_DELAY_MS, decision.retryAfterMs ?? config.transportRetryDelayMs * 2 ** unit.transportRetries);
    unit.transportRetries += 1;
    const basis = decision.basis === 'no-reading' ? ', cause unknown while the decision model is unavailable' : '';
    run.decide('transport-retry', unit.id, `retry ${unit.transportRetries} of ${config.transportRetryLimit} in ${Math.round(delayMs / 1000)}s${basis}: ${message}`, decision.decisionIds);
    await sleep(delayMs, runtime.abort.signal);
    if (!stillAwaits(run, unit, agentId)) return;
    deps.requeueUnit(run, unit, `transport retry ${unit.transportRetries}`, 'transport-retry');
  }

  function onCancelled(agentId: string): void {
    noteEnded(agentId);
    for (const run of deps.runs()) {
      for (const runtime of run.unitRuntimes.values()) {
        if (runtime.expectedCancels.delete(agentId)) return;
      }
    }
    // The owner record is the contract as parents and surfaces see it: stopping it stops the contract.
    for (const run of deps.runs()) {
      if (!run.terminal && run.contract.ownerAgentId === agentId) {
        deps.cancelContract(run, `the contract's owner record ${agentId} was stopped by an operator`);
        return;
      }
    }
    const found = locate(agentId);
    if (found === null) return;
    deps.cancelContract(found.run, `unit ${found.unit.id}'s agent ${agentId} was stopped by an operator`);
  }

  function onSilent(agent: WatchedAgent, silentMs: number): void {
    const run = [...deps.runs()].find((candidate) => candidate.id === agent.contractId);
    const unit = run?.unit(agent.unitId);
    if (run === undefined || unit === undefined || run.terminal || unit.activeAgentId !== agent.agentId) return;
    const retried = run.contract.decisions.some((decision) => decision.action === 'silence-retry' && decision.targetId === unit.id);
    if (retried) {
      run.emit({ type: 'CONTRACT_UNIT_SILENT', contractId: run.id, unitId: unit.id, agentId: agent.agentId, silentMs, action: 'failed' });
      run.runtime(unit).expectedCancels.add(agent.agentId);
      deps.agentManager.cancel(agent.agentId, 'kill');
      failUnit(run, unit, 'other', `unit ${unit.id} went silent twice`);
      return;
    }
    run.emit({ type: 'CONTRACT_UNIT_SILENT', contractId: run.id, unitId: unit.id, agentId: agent.agentId, silentMs, action: 'retried' });
    run.decide('silence-retry', unit.id, `agent ${agent.agentId} silent for ${Math.round(silentMs / 1000)}s`);
    run.runtime(unit).expectedCancels.add(agent.agentId);
    deps.agentManager.cancel(agent.agentId, 'kill');
    deps.requeueUnit(run, unit, `silence retry: ${agent.agentId} was silent for ${silentMs} ms`, 'silence-retry');
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
    onSilent,
    failUnit,
    reconcile,
    dispose: () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
      ended.clear();
    },
  };
}
