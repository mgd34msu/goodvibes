/**
 * Task lifecycle state machine, pure transition logic with no side effects.
 *
 * Implements the task lifecycle state machine:
 *
 * ```
 * queued → running
 * running → blocked | completed | failed | cancelled | queued (retry re-queue)
 * blocked → running | cancelled | failed
 * completed → (terminal)
 * failed → (terminal)
 * cancelled → (terminal)
 * ```
 */
import type { TaskLifecycleState } from '../store/domains/tasks.js';
import { defineLifecycle } from '../../utils/lifecycle-machine.js';

/**
 * The task lifecycle. Terminal states have no outbound transitions.
 */
export const taskLifecycle = defineLifecycle<TaskLifecycleState>('task', {
  queued: ['running', 'cancelled'],
  running: ['blocked', 'completed', 'failed', 'cancelled', 'queued'], // queued = retry re-queue
  blocked: ['running', 'cancelled', 'failed', 'queued'], // queued = retry re-queue (failTask with a retry policy)
  completed: [],
  failed: [],
  cancelled: [],
});

/**
 * The one documented exception to "failed and cancelled are final": an
 * operator or caller may retry them, which moves the task back to `queued`.
 * They stay terminal (`isTerminalStatus` is unchanged), so nothing that merely
 * observes a task ever moves it on; only an explicit retry does. This is the
 * single definition used by the task manager and the ops control plane.
 */
export const RETRYABLE_TASK_STATES: ReadonlySet<TaskLifecycleState> = new Set<TaskLifecycleState>(['failed', 'cancelled']);

/** True when a task in `status` may be explicitly retried (moved back to `queued`). */
export function canRetry(status: TaskLifecycleState): boolean {
  return RETRYABLE_TASK_STATES.has(status);
}

/**
 * Whether a runtime task record may be moved from `from` to `to` by a bridge
 * that mirrors an external runner (agent, process, ACP, scheduler, daemon
 * agent sync). Wider than the table in exactly three declared ways:
 *   - an explicit retry (failed/cancelled -> queued, see {@link canRetry});
 *   - a non-terminal state may be re-asserted (the same status reported again,
 *     which carries a patch such as progress); a terminal one may not, so a
 *     finished task is never re-stamped;
 *   - a task still `queued` may be reported finished (completed/failed) with
 *     no running report in between, since the runner can end before it is seen.
 */
export function canMirror(from: TaskLifecycleState, to: TaskLifecycleState): boolean {
  if (taskLifecycle.can(from, to)) return true;
  if (to === 'queued' && canRetry(from)) return true;
  if (from === to) return !taskLifecycle.isTerminal(from);
  return from === 'queued' && (to === 'completed' || to === 'failed');
}

/**
 * Returns true if a transition from `from` to `to` is permitted by the
 * task lifecycle state machine.
 *
 * @param from - Current task status.
 * @param to - Desired target status.
 * @returns `true` if the transition is valid; `false` otherwise.
 *
 * @example
 * ```ts
 * canTransition('queued', 'running');    // true
 * canTransition('completed', 'running'); // false
 * canTransition('running', 'blocked');   // true
 * ```
 */
export function canTransition(
  from: TaskLifecycleState,
  to: TaskLifecycleState
): boolean {
  return taskLifecycle.can(from, to);
}

/**
 * Returns the set of states reachable from `from` in one transition.
 *
 * @param from - Current task status.
 * @returns Array of valid target statuses (may be empty for terminal states).
 *
 * @example
 * ```ts
 * getValidTransitions('running');
 * // => ['blocked', 'completed', 'failed', 'cancelled']
 *
 * getValidTransitions('completed');
 * // => []
 * ```
 */
export function getValidTransitions(
  from: TaskLifecycleState
): TaskLifecycleState[] {
  return [...taskLifecycle.next(from)];
}

/**
 * Returns true if `status` is a terminal lifecycle state (no further
 * transitions are possible).
 *
 * @param status - The task status to check.
 */
export function isTerminalStatus(status: TaskLifecycleState): boolean {
  return taskLifecycle.isTerminal(status);
}
