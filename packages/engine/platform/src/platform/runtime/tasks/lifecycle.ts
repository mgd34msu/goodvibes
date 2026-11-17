/**
 * Task lifecycle state machine, pure transition logic with no side effects.
 *
 * Implements the task lifecycle state machine:
 *
 * ```
 * queued → running | completed | failed | cancelled
 * running → blocked | completed | failed | cancelled | queued (retry re-queue)
 * blocked → running | cancelled | failed | queued (retry re-queue)
 * completed → (terminal)
 * failed → (terminal; an explicit retry re-queues it)
 * cancelled → (terminal; an explicit retry re-queues it)
 * ```
 *
 * A queued task may finish without a running report in between: its owner can
 * end the work before the start is seen, and a task recorded by hand is
 * finished by hand.
 */
import type { TaskLifecycleState } from '../store/domains/tasks.js';
import { defineLifecycle } from '../../utils/lifecycle-machine.js';

/**
 * The task lifecycle. Terminal states have no outbound transitions.
 */
export const taskLifecycle = defineLifecycle<TaskLifecycleState>('task', {
  queued: ['running', 'completed', 'failed', 'cancelled'],
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
 * Whether the task store accepts moving a record from `from` to `to`. Wider
 * than the table in exactly two declared ways:
 *   - an explicit retry (failed/cancelled -> queued, see {@link canRetry});
 *   - a non-terminal state may be re-asserted (the same status reported again,
 *     which carries a patch such as progress); a terminal one may not, so a
 *     finished task is never re-stamped.
 */
export function canMirror(from: TaskLifecycleState, to: TaskLifecycleState): boolean {
  if (taskLifecycle.can(from, to)) return true;
  if (to === 'queued' && canRetry(from)) return true;
  return from === to && !taskLifecycle.isTerminal(from);
}

/**
 * The acts open to a task in `status`, in words, for a refusal to name: the
 * moves the table allows, plus retry where it applies.
 */
export function describeTaskMoves(status: TaskLifecycleState): string {
  const moves: string[] = [...taskLifecycle.next(status)];
  if (canRetry(status)) moves.push('queued (retry)');
  return moves.length === 0 ? `a ${status} task cannot be moved` : `from ${status} it can become ${moves.join(', ')}`;
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
 * // => ['blocked', 'completed', 'failed', 'cancelled', 'queued']
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
