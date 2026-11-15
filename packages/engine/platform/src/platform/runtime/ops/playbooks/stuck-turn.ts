/**
 * Playbook: Stuck Turn / Task
 *
 * Diagnoses and resolves turns or tasks that have stopped progressing.
 * Common causes: LLM timeout, tool deadlock, event loop stall.
 */
import type { Playbook, DiagnosticCheckResult } from '../types.js';
import { safeCheck } from '../safe-check.js';
import { getOpsRuntimeContext } from '../runtime-context.js';
import type { OpsRuntimeContextState } from '../runtime-context.js';
import type { TurnState, ToolExecutionState } from '../../store/domains/conversation.js';

/** Turn states in which a turn is still in flight. A finished turn keeps its id and start time. */
const IN_FLIGHT_TURN_STATES: ReadonlySet<TurnState> = new Set(['preflight', 'streaming', 'tool_dispatch', 'post_hooks']);
/** Tool calls stay in the map after they finish, until the next turn is submitted. */
const FINISHED_TOOL_STATES: ReadonlySet<ToolExecutionState> = new Set(['succeeded', 'failed', 'cancelled']);

export function createStuckTurnPlaybook(
  getRuntimeContext: () => OpsRuntimeContextState | null = () => null,
): Playbook {
  return {
  id: 'stuck-turn',
  name: 'Stuck Turn / Task',
  description:
    'Diagnoses turns or tasks that have stopped progressing. ' +
    'Covers LLM timeout, tool deadlock, and event-loop stall scenarios.',
  symptoms: [
    'Turn has been in-flight longer than the configured timeout',
    'No new events emitted on the task event bus for > 30 s',
    'Spinner/progress indicator frozen in TUI',
    'CPU near 0% with pending async operations',
    'Health check reports degraded turn throughput',
  ],
  checks: [
    {
      id: 'turn.timeout-elapsed',
      label: 'Turn timeout elapsed',
      description: 'Checks whether the active turn has exceeded its configured timeout.',
      run: async (): Promise<DiagnosticCheckResult> =>
        safeCheck(async () => {
          const runtime = getRuntimeContext();
          if (!runtime) {
            return {
              passed: false,
              evaluated: false,
              summary: 'Ops runtime context is not configured, so this check was not evaluated.',
              severity: 'info',
            };
          }
          const { conversation } = runtime.store.getState();
          if (!conversation.currentTurnId || !conversation.turnStartedAt || !IN_FLIGHT_TURN_STATES.has(conversation.turnState)) {
            return {
              passed: true,
              summary: conversation.currentTurnId && conversation.turnState !== 'idle'
                ? `No turn is in flight; the last turn ${conversation.currentTurnId} is ${conversation.turnState}.`
                : 'No active turn is currently in flight.',
              severity: 'info',
            };
          }
          const elapsedMs = runtime.now() - conversation.turnStartedAt;
          const thresholdMs = 30_000;
          const exceeded = elapsedMs > thresholdMs;
          return {
            passed: !exceeded,
            summary: exceeded
              ? `Active turn ${conversation.currentTurnId} has exceeded ${thresholdMs}ms (${elapsedMs}ms elapsed).`
              : `Active turn ${conversation.currentTurnId} is still within the ${thresholdMs}ms threshold.`,
            severity: exceeded ? 'error' : 'info',
            context: {
              turnId: conversation.currentTurnId,
              turnState: conversation.turnState,
              elapsedMs,
              thresholdMs,
            },
          };
        }),
    },
    {
      id: 'turn.event-bus-inactive',
      label: 'Event bus inactive',
      description: 'Checks whether the RuntimeEventBus has emitted any events recently.',
      run: async (): Promise<DiagnosticCheckResult> =>
        safeCheck(async () => {
          const runtime = getRuntimeContext();
          if (!runtime) {
            return {
              passed: false,
              evaluated: false,
              summary: 'Ops runtime context is not configured, so this check was not evaluated.',
              severity: 'info',
            };
          }
          const inactiveMs = runtime.now() - runtime.lastEventAt;
          const thresholdMs = 30_000;
          const inactive = inactiveMs > thresholdMs;
          return {
            passed: !inactive,
            summary: inactive
              ? `No runtime events have been observed for ${inactiveMs}ms.`
              : `Runtime event flow is active (${inactiveMs}ms since the last event).`,
            severity: inactive ? 'warning' : 'info',
            context: {
              inactiveMs,
              thresholdMs,
              lastEventAt: runtime.lastEventAt,
            },
          };
        }),
    },
    {
      id: 'turn.pending-tool-calls',
      label: 'Pending tool calls',
      description: 'Checks for tool calls that have been dispatched but not yet resolved.',
      run: async (): Promise<DiagnosticCheckResult> =>
        safeCheck(async () => {
          const runtime = getRuntimeContext();
          if (!runtime) {
            return {
              passed: false,
              evaluated: false,
              summary: 'Ops runtime context is not configured, so this check was not evaluated.',
              severity: 'info',
            };
          }
          const { conversation } = runtime.store.getState();
          const pendingToolCalls = [...conversation.activeToolCalls.values()]
            .filter((call) => !FINISHED_TOOL_STATES.has(call.state)).length;
          const blocked = pendingToolCalls > 0;
          // Pending permission prompts are not visible here: the gate reports a
          // request only after its decision. They are listed by the approval
          // broker, so the summary points there instead of claiming none exist.
          return {
            passed: !blocked,
            summary: blocked
              ? `Detected ${pendingToolCalls} unfinished tool call(s). Pending permission prompts are listed under approvals.`
              : 'No unfinished tool calls recorded. Pending permission prompts are listed under approvals.',
            severity: blocked ? 'warning' : 'info',
            context: {
              pendingToolCalls,
            },
          };
        }),
    },
  ],
  steps: [
    {
      step: 1,
      title: 'Identify stuck span',
      action:
        'Query the active span list from the RuntimeTracer. ' +
        'Look for spans with durationMs > turnTimeoutMs and status UNSET.',
      kind: 'observe',
      expectedOutcome: 'One or more spans identified as candidates.',
      automatable: false,
    },
    {
      step: 2,
      title: 'Check for tool deadlock',
      action:
        'Inspect the PhasedToolExecutor queue for tools awaiting permissions or locks. ' +
        'Cross-reference with PermissionManager.pendingRequests().',
      kind: 'observe',
      expectedOutcome: 'Tool queue is empty or shows a specific blocked tool.',
      automatable: false,
    },
    {
      step: 3,
      title: 'Cancel the stuck turn',
      action:
        'Emit a task.cancel event on the RuntimeEventBus with the stuck taskId. ' +
        'The TaskStateMachine should transition to CANCELLED within 1 s.',
      kind: 'command',
      expectedOutcome: 'Turn transitions to CANCELLED; health check recovers.',
      automatable: false,
    },
    {
      step: 4,
      title: 'Restart turn with reduced timeout',
      action:
        'Re-submit the failed turn with a shorter LLM timeout (e.g. 30 s) and ' +
        'tool-use disabled to isolate whether the model or a tool is the root cause.',
      kind: 'command',
      expectedOutcome: 'Turn completes or fails fast with a clear error.',
      automatable: false,
    },
    {
      step: 5,
      title: 'Review LLM provider health',
      action:
        'Check the provider health dashboard or call the provider status endpoint. ' +
        'Consider switching to a fallback provider if degraded.',
      kind: 'observe',
      expectedOutcome: 'Provider status confirmed healthy or fallback selected.',
      automatable: false,
    },
  ],
  escalationCriteria: [
    'Multiple consecutive turns stuck after attempting cancel+restart',
    'Event loop stall confirmed by > 60 s with zero runtime events',
    'Memory usage growing continuously without turns completing',
    'Core health check reports CRITICAL for > 5 minutes',
  ],
  tags: ['turn', 'task', 'timeout', 'deadlock', 'llm'],
  };
}

/** Stuck turn / task resolution playbook. */
export const stuckTurnPlaybook: Playbook = createStuckTurnPlaybook(getOpsRuntimeContext);
