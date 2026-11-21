/**
 * Tasks domain state, unified task lifecycle tracking across all
 * subsystem kinds: exec, agent, acp, scheduler, daemon, mcp, plugin, integration.
 */

/** States for the task lifecycle machine. */
export type TaskLifecycleState =
  | 'queued'
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Task kind used by the runtime task domain. */
export type TaskKind =
  | 'exec'
  | 'agent'
  | 'acp'
  | 'scheduler'
  | 'daemon'
  | 'mcp'
  | 'plugin'
  | 'integration';

/**
 * Full runtime task record. Every active or recently completed task
 * in the system has one of these in the tasks map.
 */
export interface RuntimeTask {
  /** Unique task ID (uuid). */
  id: string;
  /** Task kind stored on a runtime task record. */
  kind: TaskKind;
  /** Human-readable title for display in task monitor. */
  title: string;
  /** Optional detailed description. */
  description?: string | undefined;
  /** Current lifecycle state. */
  status: TaskLifecycleState;

  // ── Ownership ────────────────────────────────────────────────────────────
  /** Subsystem or agent ID that owns this task. */
  owner: string;
  /** Whether this task can be cancelled by the user. */
  cancellable: boolean;

  // ── Hierarchy ────────────────────────────────────────────────────────────
  /** Parent task ID if this is a subtask. */
  parentTaskId?: string | undefined;
  /** IDs of child tasks spawned by this task. */
  childTaskIds: string[];

  // ── Timing ───────────────────────────────────────────────────────────────
  /** Epoch ms when the task was queued. */
  queuedAt: number;
  /** Epoch ms when the task started running. */
  startedAt?: number | undefined;
  /** Epoch ms when the task completed, failed, or was cancelled. */
  endedAt?: number | undefined;

  // ── Result ───────────────────────────────────────────────────────────────
  /** Exit code for exec tasks. */
  exitCode?: number | undefined;
  /** Error message if status === 'failed'; a blocked task carries its blocked reason here until it starts again. */
  error?: string | undefined;
  /** Latest progress message reported for the task, kept apart from `description`. */
  progress?: string | undefined;
  /** Optional structured result payload. */
  result?: unknown | undefined;

  // ── Correlation ──────────────────────────────────────────────────────────
  /** Correlation ID for distributed tracing. */
  correlationId?: string | undefined;
  /** Turn ID this task was spawned within. */
  turnId?: string | undefined;
}

/**
 * TaskDomainState, all runtime tasks across all subsystems.
 */
export interface TaskDomainState {
  // ── Domain metadata ────────────────────────────────────────────────────────
  /** Monotonic revision counter; increments on every mutation. */
  revision: number;
  /** Timestamp of last mutation (Date.now()). */
  lastUpdatedAt: number;
  /** Subsystem that triggered the last mutation. */
  source: string;

  // ── Task registry ──────────────────────────────────────────────────────────
  /** All known tasks keyed by task ID. */
  tasks: Map<string, RuntimeTask>;
  /** IDs of tasks in 'queued' state, ordered by queue time. */
  queuedIds: string[];
  /** IDs of tasks in 'running' state. */
  runningIds: string[];
  /** IDs of tasks in 'blocked' state. */
  blockedIds: string[];

  // ── Statistics ─────────────────────────────────────────────────────────────
  /** Total tasks created this session. */
  totalCreated: number;
  /** Total tasks that completed successfully. */
  totalCompleted: number;
  /** Total tasks that failed. */
  totalFailed: number;
  /** Total tasks that were cancelled. */
  totalCancelled: number;
}

/**
 * Returns the default initial state for the tasks domain.
 */
export function createInitialTasksState(): TaskDomainState {
  return {
    revision: 0,
    lastUpdatedAt: 0,
    source: 'init',
    tasks: new Map(),
    queuedIds: [],
    runningIds: [],
    blockedIds: [],
    totalCreated: 0,
    totalCompleted: 0,
    totalFailed: 0,
    totalCancelled: 0,
  };
}
