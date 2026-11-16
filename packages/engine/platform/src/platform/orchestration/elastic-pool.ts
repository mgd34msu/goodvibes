/**
 * elastic-pool.ts, the elastic-fleet muscles of the shared workstream engine.
 * Agents are per task: a ready task SPAWNS a fresh agent for its phase (the
 * phase runner), up to `fleet.maxSize`, and that agent ends with its phase,
 * so the fleet's size follows the graph's width with nothing kept warm.
 * At cap is a VISIBLE state on the task ("N ready, M running, at cap") and in
 * the pool snapshot (`poolState`), never a silent stall; a spawn refusal
 * leaves the task visibly ready with its reason.
 *
 * Also owns the bounded per-task retry decision (auto-retry a failed task up
 * to the bound, then hard-fail → the orphan pass surfaces dependents).
 */
import type { OrchestrationEvent, WorkItem, Workstream } from './types.js';
import type { PoolStateSnapshot } from './graph-dynamics.js';

/** Live probe of the configured fleet ceiling (fleet.maxSize), injected by the composition root. */
export interface FleetCapacityProbe {
  /** Agents the daemon is responsible for right now (native + ACP-hosted + elastic fixers). */
  readonly active: number;
  readonly maxSize: number;
  readonly capKey: string;
  /** A policy refusal independent of the ceiling (host resources, spawn policy), when any. */
  readonly refusal?: string | undefined;
}

export type FleetCapacityFn = () => FleetCapacityProbe;

/** Whether this workstream runs under the elastic pool (the review-sourced fix graphs do). */
export function isElastic(workstream: Workstream): boolean {
  return workstream.releasePolicy === 'reviewed-and-merged';
}

export function readyCount(workstream: Workstream): number {
  return workstream.items.filter(
    (item) => item.state === 'pending' || item.state === 'awaiting-capacity',
  ).length;
}

export function runningCount(workstream: Workstream): number {
  return workstream.items.filter((item) => item.state === 'in-phase').length;
}

export interface PoolGateDecision {
  readonly allow: boolean;
  /** The visible reason stamped on the still-ready item when refused. */
  readonly reason?: string | undefined;
  readonly event?: OrchestrationEvent | undefined;
}

/**
 * Gate one claim against the fleet ceiling. Allowing the claim IS the spawn,
 * the phase-runner spawns a fresh per-task agent for it. Refusals leave the
 * item in its ready state with the honest reason, which is where at cap is
 * shown; only a policy refusal is also announced as an event.
 */
export function gateClaimAgainstFleet(
  workstream: Workstream,
  item: WorkItem,
  probe: FleetCapacityProbe,
): PoolGateDecision {
  if (probe.refusal) {
    return {
      allow: false,
      reason: `spawn refused: ${probe.refusal} (task stays ready)`,
      event: { type: 'pool-spawn-refused', workstreamId: workstream.id, itemId: item.id, reason: probe.refusal },
    };
  }
  if (probe.active >= probe.maxSize) {
    return {
      allow: false,
      reason: `${readyCount(workstream)} ready, ${runningCount(workstream)} running, at cap (${probe.capKey}=${probe.maxSize})`,
    };
  }
  return { allow: true };
}

/** The pool state a graph snapshot serves. */
export function poolState(workstream: Workstream, probe: FleetCapacityProbe | null): PoolStateSnapshot | null {
  if (!isElastic(workstream) || !probe) return null;
  return {
    ready: readyCount(workstream),
    running: runningCount(workstream),
    atCap: probe.active >= probe.maxSize,
    capKey: probe.capKey,
    maxSize: probe.maxSize,
    refusal: probe.refusal,
  };
}

/**
 * Bounded auto-retry decision for a failed item. True = consume one retry
 * (the caller resets the item and re-ticks); false = hard-fail (the orphan
 * pass then surfaces dependents). Cancellations never retry.
 */
export function shouldAutoRetry(item: WorkItem, cancelled: boolean, maxItemRetries: number): boolean {
  if (maxItemRetries <= 0) return false;
  if (cancelled) return false;
  return (item.retryCount ?? 0) < maxItemRetries;
}

/** True when a FAILED item is past its retry bound (the orphan pass's blocker predicate). */
export function isHardFailed(item: WorkItem, maxItemRetries: number): boolean {
  return item.state === 'failed' && (maxItemRetries <= 0 || (item.retryCount ?? 0) >= maxItemRetries);
}
