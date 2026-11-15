/**
 * lifecycle.ts
 *
 * Compaction lifecycle state machine for the compaction engine.
 *
 * Provides:
 * - Valid transition map for the 9-state machine
 * - Pure transition helpers (no side-effects)
 * - The lifecycle state for a chosen strategy
 */

import type { CompactionLifecycleState, CompactionStrategy } from './types.js';
import { defineLifecycle } from '../../utils/lifecycle-machine.js';

// ---------------------------------------------------------------------------
// Transition map
// ---------------------------------------------------------------------------

/**
 * The compaction lifecycle: for each state, the states reachable from it. This
 * is the sequence `CompactionManager.runLifecycle` runs: a check, the one
 * strategy the session chose, the boundary commit, then done, or failed from
 * any step, and back to idle.
 */
export const compactionLifecycle = defineLifecycle<CompactionLifecycleState>('compaction', {
  idle:               ['checking_threshold'],
  checking_threshold: ['microcompact', 'collapse', 'autocompact', 'reactive_compact', 'failed'],
  microcompact:       ['boundary_commit', 'failed'],
  collapse:           ['boundary_commit', 'failed'],
  autocompact:        ['boundary_commit', 'failed'],
  reactive_compact:   ['boundary_commit', 'failed'],
  boundary_commit:    ['done', 'failed'],
  done:               ['idle'],
  failed:             ['idle'],
});

// ---------------------------------------------------------------------------
// Transition helpers
// ---------------------------------------------------------------------------

/**
 * Returns whether a transition from `from` to `to` is valid.
 */
export function canTransition(
  from: CompactionLifecycleState,
  to: CompactionLifecycleState,
): boolean {
  return compactionLifecycle.can(from, to);
}

/**
 * Returns all states reachable from `from`.
 */
export function reachableFrom(
  from: CompactionLifecycleState,
): ReadonlySet<CompactionLifecycleState> {
  return new Set(compactionLifecycle.next(from));
}

/** Discriminated result of `applyTransition`. */
export type TransitionResult =
  | { ok: true;  state: CompactionLifecycleState }
  | { ok: false; reason: string };

/**
 * Validates and applies a state transition.
 *
 * @returns `{ ok: true, state }` on success, `{ ok: false, reason }` on rejection.
 */
export function applyTransition(
  current: CompactionLifecycleState,
  target: CompactionLifecycleState,
): TransitionResult {
  if (canTransition(current, target)) {
    return { ok: true, state: target };
  }
  return {
    ok: false,
    reason: `Invalid compaction transition: ${current} → ${target}`,
  };
}

// ---------------------------------------------------------------------------
// Terminal / operational helpers
// ---------------------------------------------------------------------------

/** Returns true if the state is a terminal completion state (done | failed). */
export function isTerminal(state: CompactionLifecycleState): boolean {
  return state === 'done' || state === 'failed';
}

/** Returns true if the state represents active compaction work in progress. */
export function isCompacting(state: CompactionLifecycleState): boolean {
  return (
    state === 'microcompact' ||
    state === 'collapse' ||
    state === 'autocompact' ||
    state === 'reactive_compact' ||
    state === 'boundary_commit'
  );
}

/**
 * Maps a chosen CompactionStrategy to its corresponding lifecycle state.
 */
export function strategyToState(
  strategy: CompactionStrategy,
): CompactionLifecycleState {
  switch (strategy) {
    case 'microcompact': return 'microcompact';
    case 'collapse':     return 'collapse';
    case 'autocompact':  return 'autocompact';
    case 'reactive':     return 'reactive_compact';
    default: {
      const _exhaustive: never = strategy;
      throw new Error(`Unknown compaction strategy: ${_exhaustive}`);
    }
  }
}
