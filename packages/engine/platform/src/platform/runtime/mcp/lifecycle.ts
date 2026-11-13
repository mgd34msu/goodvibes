/**
 * MCP server lifecycle state machine.
 *
 * Pure transition logic, no side effects, no I/O.
 * All state changes flow through `applyTransition()`.
 */
import type { McpServerState } from './types.js';
import { defineLifecycle } from '../../utils/lifecycle-machine.js';

// ── Valid transitions ─────────────────────────────────────────────────────────

/** The MCP server lifecycle: for each state, the states reachable from it. */
export const mcpServerLifecycle = defineLifecycle<McpServerState>('MCP server', {
  configured:    ['connecting', 'disconnected'],
  connecting:    ['connected', 'auth_required', 'reconnecting', 'disconnected'],
  connected:     ['degraded', 'auth_required', 'reconnecting', 'disconnected'],
  degraded:      ['connected', 'reconnecting', 'disconnected'],
  auth_required: ['connecting', 'disconnected'],
  reconnecting:  ['connecting', 'connected', 'disconnected'],
  disconnected:  ['connecting'],
});

// ── Guards ────────────────────────────────────────────────────────────────────

/**
 * Returns `true` if transitioning from `from` to `to` is permitted by the
 * state machine definition.
 *
 * @param from - Current state
 * @param to   - Proposed next state
 */
export function canTransition(from: McpServerState, to: McpServerState): boolean {
  return mcpServerLifecycle.can(from, to);
}

/**
 * Returns all states reachable from the given state.
 *
 * @param from - Current state
 */
export function reachableFrom(from: McpServerState): ReadonlySet<McpServerState> {
  return new Set(mcpServerLifecycle.next(from));
}

// ── Transition result ─────────────────────────────────────────────────────────

/** Result of attempting a state transition. */
export type TransitionResult =
  | { success: true; previous: McpServerState; next: McpServerState }
  | { success: false; reason: string };

/**
 * Attempt to apply a state transition.
 *
 * Returns `{ success: true, previous, next }` if the transition is valid,
 * or `{ success: false, reason }` if it is not.
 *
 * This function is pure, callers are responsible for updating the entry.
 *
 * @param current  - The current state of the server
 * @param target   - The desired next state
 */
export function applyTransition(
  current: McpServerState,
  target: McpServerState,
): TransitionResult {
  if (current === target) {
    return { success: false, reason: `already in state '${current}'` };
  }
  if (!canTransition(current, target)) {
    return {
      success: false,
      reason: `transition '${current}' → '${target}' is not permitted`,
    };
  }
  return { success: true, previous: current, next: target };
}

/**
 * Returns `true` if the state represents an active/usable server.
 *
 * Both `connected` and `degraded` allow tool calls to proceed.
 */
export function isOperational(state: McpServerState): boolean {
  return state === 'connected' || state === 'degraded';
}

/**
 * Returns `true` if the state is terminal for a reconnect cycle
 * (i.e., the manager should not attempt further reconnects automatically).
 */
export function isTerminal(state: McpServerState): boolean {
  return state === 'disconnected';
}
