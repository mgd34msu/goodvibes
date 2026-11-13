import type { CompactionLifecycleState } from './compaction/index.js';
import { compactionLifecycle } from './compaction/lifecycle.js';
import { mcpServerLifecycle } from './mcp/lifecycle.js';
import { pluginLifecycle } from './plugins/lifecycle.js';
import { taskLifecycle } from './tasks/lifecycle.js';
import {
  applyTransition as applyCompactionTransition,
  canTransition as canCompactionTransition,
  isTerminal as isTerminalCompactionState,
  reachableFrom as reachableFromCompactionState,
  type TransitionResult as CompactionTransitionResult,
} from './compaction/index.js';
import type { McpServerState } from './mcp/index.js';
import {
  applyTransition as applyMcpTransition,
  canTransition as canMcpTransition,
  isOperational as isOperationalMcpState,
  isTerminal as isTerminalMcpState,
  reachableFrom as reachableFromMcpState,
  type TransitionResult as McpTransitionResult,
} from './mcp/index.js';
import type { PluginLifecycleState } from './plugins/index.js';
import {
  applyTransition as applyPluginTransition,
  canTransition as canPluginTransition,
  isOperational as isOperationalPluginState,
  isReloadable as isReloadablePluginState,
  isTerminal as isTerminalPluginState,
  type TransitionResult as PluginTransitionResult,
} from './plugins/index.js';
import type { TaskLifecycleState } from './store/domains/tasks.js';
import {
  canTransition as canTaskTransition,
  getValidTransitions as getValidTaskTransitions,
  isTerminalStatus,
} from './tasks/index.js';

type RuntimeLifecycleState =
  | TaskLifecycleState
  | PluginLifecycleState
  | McpServerState
  | CompactionLifecycleState;

export type RuntimeTransitionResult =
  | (PluginTransitionResult & { readonly success?: never; readonly previous?: never; readonly next?: never; readonly state?: never })
  | (
      | { ok: true; success: true; previous: McpServerState; next: McpServerState; from: McpServerState; to: McpServerState; readonly state?: never }
      | { ok: false; success: false; reason: string; readonly previous?: never; readonly next?: never; readonly from?: never; readonly to?: never; readonly state?: never }
    )
  | (CompactionTransitionResult & { readonly success?: never; readonly previous?: never; readonly next?: never; readonly from?: never; readonly to?: never })
  | { ok: true; from: TaskLifecycleState; to: TaskLifecycleState; readonly success?: never; readonly previous?: never; readonly next?: never; readonly state?: never }
  | { ok: false; reason: string; readonly success?: never; readonly previous?: never; readonly next?: never; readonly from?: never; readonly to?: never; readonly state?: never };

function isTaskState(state: string): state is TaskLifecycleState {
  return taskLifecycle.isState(state);
}

function isPluginState(state: string): state is PluginLifecycleState {
  return pluginLifecycle.isState(state);
}

function isMcpState(state: string): state is McpServerState {
  return mcpServerLifecycle.isState(state);
}

function isCompactionState(state: string): state is CompactionLifecycleState {
  return compactionLifecycle.isState(state);
}

export function canTransition(from: McpServerState, to: McpServerState): boolean;
export function canTransition(from: PluginLifecycleState, to: PluginLifecycleState): boolean;
export function canTransition(from: TaskLifecycleState, to: TaskLifecycleState): boolean;
export function canTransition(from: CompactionLifecycleState, to: CompactionLifecycleState): boolean;
export function canTransition(from: RuntimeLifecycleState, to: RuntimeLifecycleState): boolean {
  if (isPluginState(from) && isPluginState(to)) return canPluginTransition(from, to);
  if (isMcpState(from) && isMcpState(to)) return canMcpTransition(from, to);
  if (isCompactionState(from) && isCompactionState(to)) return canCompactionTransition(from, to);
  if (isTaskState(from) && isTaskState(to)) return canTaskTransition(from, to);
  return false;
}

export function applyTransition(from: RuntimeLifecycleState, to: RuntimeLifecycleState): RuntimeTransitionResult {
  if (isPluginState(from) && isPluginState(to)) return applyPluginTransition(from, to);
  if (isMcpState(from) && isMcpState(to)) {
    const result = applyMcpTransition(from, to);
    if (result.success) {
      return {
        ...result,
        ok: true,
        from: result.previous,
        to: result.next,
      };
    }
    return {
      ...result,
      ok: false,
    };
  }
  if (isCompactionState(from) && isCompactionState(to)) return applyCompactionTransition(from, to);
  if (isTaskState(from) && isTaskState(to)) {
    if (canTaskTransition(from, to)) return { ok: true, from, to };
    return {
      ok: false,
      reason: `Invalid task transition: ${from} -> ${to}`,
    };
  }
  return {
    ok: false,
    reason: `No runtime lifecycle state machine accepts transition ${String(from)} -> ${String(to)}`,
  };
}

export function reachableFrom(from: McpServerState): ReadonlySet<McpServerState>;
export function reachableFrom(from: CompactionLifecycleState): ReadonlySet<CompactionLifecycleState>;
export function reachableFrom(from: TaskLifecycleState): ReadonlySet<TaskLifecycleState>;
export function reachableFrom(from: RuntimeLifecycleState): ReadonlySet<RuntimeLifecycleState> {
  if (isMcpState(from)) return reachableFromMcpState(from);
  if (isCompactionState(from)) return reachableFromCompactionState(from);
  if (isTaskState(from)) return new Set(getValidTaskTransitions(from));
  if (isPluginState(from)) {
    return new Set(pluginLifecycle.next(from));
  }
  return new Set();
}

export function isOperational(state: PluginLifecycleState | McpServerState): boolean {
  if (isPluginState(state)) return isOperationalPluginState(state);
  if (isMcpState(state)) return isOperationalMcpState(state);
  return false;
}

export function isReloadable(state: PluginLifecycleState): boolean {
  return isReloadablePluginState(state);
}

export function isTerminal(
  state: TaskLifecycleState | PluginLifecycleState | McpServerState | CompactionLifecycleState,
): boolean {
  if (isPluginState(state)) return isTerminalPluginState(state);
  if (isMcpState(state)) return isTerminalMcpState(state);
  if (isCompactionState(state)) return isTerminalCompactionState(state);
  if (isTaskState(state)) return isTerminalStatus(state);
  return false;
}
