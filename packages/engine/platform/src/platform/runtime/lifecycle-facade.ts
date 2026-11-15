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

/**
 * Which machine a state belongs to. State names overlap between machines
 * (`failed` is both a task and a compaction state, `degraded` both a plugin and
 * an MCP state), so a name alone is ambiguous; without this the first machine in
 * the facade's fixed order that knows the name answers.
 */
export type RuntimeLifecycleMachine = 'task' | 'plugin' | 'mcp' | 'compaction';

const wants = (machine: RuntimeLifecycleMachine | undefined, own: RuntimeLifecycleMachine): boolean =>
  machine === undefined || machine === own;

export function canTransition(from: McpServerState, to: McpServerState, machine?: 'mcp'): boolean;
export function canTransition(from: PluginLifecycleState, to: PluginLifecycleState, machine?: 'plugin'): boolean;
export function canTransition(from: TaskLifecycleState, to: TaskLifecycleState, machine?: 'task'): boolean;
export function canTransition(from: CompactionLifecycleState, to: CompactionLifecycleState, machine?: 'compaction'): boolean;
export function canTransition(from: RuntimeLifecycleState, to: RuntimeLifecycleState, machine?: RuntimeLifecycleMachine): boolean {
  if (wants(machine, 'plugin') && isPluginState(from) && isPluginState(to)) return canPluginTransition(from, to);
  if (wants(machine, 'mcp') && isMcpState(from) && isMcpState(to)) return canMcpTransition(from, to);
  if (wants(machine, 'compaction') && isCompactionState(from) && isCompactionState(to)) return canCompactionTransition(from, to);
  if (wants(machine, 'task') && isTaskState(from) && isTaskState(to)) return canTaskTransition(from, to);
  return false;
}

export function applyTransition(from: RuntimeLifecycleState, to: RuntimeLifecycleState, machine?: RuntimeLifecycleMachine): RuntimeTransitionResult {
  if (wants(machine, 'plugin') && isPluginState(from) && isPluginState(to)) return applyPluginTransition(from, to);
  if (wants(machine, 'mcp') && isMcpState(from) && isMcpState(to)) {
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
  if (wants(machine, 'compaction') && isCompactionState(from) && isCompactionState(to)) return applyCompactionTransition(from, to);
  if (wants(machine, 'task') && isTaskState(from) && isTaskState(to)) {
    if (canTaskTransition(from, to)) return { ok: true, from, to };
    return {
      ok: false,
      reason: `Invalid task transition: ${from} -> ${to}`,
    };
  }
  return {
    ok: false,
    reason: `No runtime lifecycle state machine${machine ? ` '${machine}'` : ''} accepts transition ${String(from)} -> ${String(to)}`,
  };
}

export function reachableFrom(from: McpServerState, machine?: 'mcp'): ReadonlySet<McpServerState>;
export function reachableFrom(from: CompactionLifecycleState, machine?: 'compaction'): ReadonlySet<CompactionLifecycleState>;
export function reachableFrom(from: TaskLifecycleState, machine?: 'task'): ReadonlySet<TaskLifecycleState>;
export function reachableFrom(from: PluginLifecycleState, machine: 'plugin'): ReadonlySet<PluginLifecycleState>;
export function reachableFrom(from: RuntimeLifecycleState, machine?: RuntimeLifecycleMachine): ReadonlySet<RuntimeLifecycleState> {
  if (wants(machine, 'mcp') && isMcpState(from)) return reachableFromMcpState(from);
  if (wants(machine, 'compaction') && isCompactionState(from)) return reachableFromCompactionState(from);
  if (wants(machine, 'task') && isTaskState(from)) return new Set(getValidTaskTransitions(from));
  if (wants(machine, 'plugin') && isPluginState(from)) {
    return new Set(pluginLifecycle.next(from));
  }
  return new Set();
}

export function isOperational(state: PluginLifecycleState | McpServerState, machine?: 'plugin' | 'mcp'): boolean {
  if (wants(machine, 'plugin') && isPluginState(state)) return isOperationalPluginState(state);
  if (wants(machine, 'mcp') && isMcpState(state)) return isOperationalMcpState(state);
  return false;
}

export function isReloadable(state: PluginLifecycleState): boolean {
  return isReloadablePluginState(state);
}

export function isTerminal(
  state: TaskLifecycleState | PluginLifecycleState | McpServerState | CompactionLifecycleState,
  machine?: RuntimeLifecycleMachine,
): boolean {
  if (wants(machine, 'plugin') && isPluginState(state)) return isTerminalPluginState(state);
  if (wants(machine, 'mcp') && isMcpState(state)) return isTerminalMcpState(state);
  if (wants(machine, 'compaction') && isCompactionState(state)) return isTerminalCompactionState(state);
  if (wants(machine, 'task') && isTaskState(state)) return isTerminalStatus(state);
  return false;
}
