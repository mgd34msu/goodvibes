/**
 * Playbook: Stuck Turn / Task
 *
 * Diagnoses turns or tasks that have stopped progressing.
 * Common causes: a slow or stalled provider, a tool call that never returns,
 * a permission ask nobody answered.
 */
import type { Playbook } from '../types.js';
import { safeCheck } from '../safe-check.js';
import { latencyCheckResult } from '../latency-check.js';
import { SLO_METRICS } from '../../perf/slo-collector.js';
import type { TurnState, ToolExecutionState } from '../../store/domains/conversation.js';

/** Turn states in which a turn is still in flight. A finished turn keeps its id and start time. */
const IN_FLIGHT_TURN_STATES: ReadonlySet<TurnState> = new Set(['preflight', 'streaming', 'tool_dispatch', 'post_hooks']);
/** Tool calls stay in the map after they finish, until the next turn is submitted. */
const FINISHED_TOOL_STATES: ReadonlySet<ToolExecutionState> = new Set(['succeeded', 'failed', 'cancelled']);
/** How long a turn or the event flow may stay quiet before it counts as stuck. */
const STUCK_AFTER_MS = 30_000;

/** Stuck turn / task resolution playbook. */
export const stuckTurnPlaybook: Playbook = {
  id: 'stuck-turn',
  name: 'Stuck Turn / Task',
  description: 'Diagnoses turns or tasks that have stopped progressing: a stalled provider, a tool call that never returns, or an unanswered permission ask.',
  symptoms: [
    'Turn has been running much longer than usual',
    'Spinner or progress indicator frozen',
    'No output and no tool activity for more than 30 seconds',
    'The agent is stuck, hangs, or does not respond',
  ],
  checks: [
    {
      id: 'turn.timeout-elapsed',
      label: 'Turn running too long',
      description: `Whether the turn in flight started more than ${STUCK_AFTER_MS / 1000} s ago.`,
      run: (ctx) => safeCheck(() => {
        const { conversation } = ctx.store.getState();
        if (!conversation.currentTurnId || !conversation.turnStartedAt || !IN_FLIGHT_TURN_STATES.has(conversation.turnState)) {
          return { passed: true, summary: 'No turn is in flight.', severity: 'info' };
        }
        const elapsedMs = ctx.now() - conversation.turnStartedAt;
        const exceeded = elapsedMs > STUCK_AFTER_MS;
        return {
          passed: !exceeded,
          summary: `The turn in flight (${conversation.turnState}) started ${Math.round(elapsedMs / 1000)} s ago.`,
          severity: exceeded ? 'warning' : 'info',
          context: { turnId: conversation.currentTurnId, turnState: conversation.turnState, elapsedMs },
        };
      }),
    },
    {
      id: 'turn.event-bus-inactive',
      label: 'No runtime activity during the turn',
      description: 'Whether a turn is in flight while no runtime event has been seen for 30 s.',
      run: (ctx) => safeCheck(() => {
        const { conversation } = ctx.store.getState();
        if (!IN_FLIGHT_TURN_STATES.has(conversation.turnState)) {
          return { passed: true, summary: 'No turn is in flight, so quiet is normal.', severity: 'info' };
        }
        const last = ctx.lastEventAt();
        const quietMs = ctx.now() - (last ?? conversation.turnStartedAt ?? ctx.now());
        const stalled = quietMs > STUCK_AFTER_MS;
        return {
          passed: !stalled,
          summary: stalled
            ? `Nothing has happened for ${Math.round(quietMs / 1000)} s while a turn is in flight.`
            : `The turn is active (last activity ${Math.round(quietMs / 1000)} s ago).`,
          severity: stalled ? 'error' : 'info',
          context: { quietMs },
        };
      }),
    },
    {
      id: 'turn.pending-tool-calls',
      label: 'Tool calls not finished',
      description: 'Tool calls dispatched in this turn that have not finished.',
      run: (ctx) => safeCheck(() => {
        const { conversation } = ctx.store.getState();
        const pending = [...conversation.activeToolCalls.values()].filter((call) => !FINISHED_TOOL_STATES.has(call.state));
        return {
          passed: pending.length === 0,
          summary: pending.length === 0
            ? 'No tool call is waiting to finish.'
            : `${pending.length} tool call(s) not finished: ${pending.slice(0, 5).map((call) => call.toolName).join(', ')}.`,
          severity: pending.length === 0 ? 'info' : 'warning',
          context: { pendingToolCalls: pending.length },
        };
      }),
    },
    {
      id: 'turn.waiting-on-owner',
      label: 'Waiting on your answer',
      description: 'Approvals waiting on the owner, which hold the calls that asked.',
      run: (ctx) => safeCheck(() => {
        const pending = ctx.pendingApprovals?.();
        if (!pending) {
          const { permissions } = ctx.store.getState();
          return {
            passed: !permissions.awaitingDecision,
            summary: permissions.awaitingDecision ? 'A permission decision is in progress.' : 'No permission decision is in progress.',
            severity: permissions.awaitingDecision ? 'warning' : 'info',
          };
        }
        return {
          passed: pending.length === 0,
          summary: pending.length === 0 ? 'Nothing is waiting on your answer.' : `${pending.length} approval(s) wait on your answer.`,
          severity: pending.length === 0 ? 'info' : 'warning',
          context: { pendingApprovals: pending.length },
        };
      }),
    },
    {
      id: 'turn.start-latency',
      label: 'Time to first output',
      description: 'The p95 time from a submitted turn to its first streamed output in this process.',
      run: (ctx) => safeCheck(() => latencyCheckResult(ctx, SLO_METRICS.TURN_START, 'Time to first output')),
    },
    {
      id: 'turn.cancel-latency',
      label: 'Time to stop after cancel',
      description: 'The p95 time from a cancel request to the turn reporting itself cancelled in this process.',
      run: (ctx) => safeCheck(() => latencyCheckResult(ctx, SLO_METRICS.CANCEL, 'Time to stop after cancel')),
    },
  ],
  steps: [
    { step: 1, title: 'Answer what is waiting on you', action: 'If an approval is waiting, open /questions and answer it; the call that asked continues at once.', kind: 'command', command: '/questions', expectedOutcome: 'The held call runs or is refused and the turn moves on.', automatable: false },
    { step: 2, title: 'Stop the turn', action: 'Press Esc (or Ctrl+C) to cancel the turn in flight; tool calls in flight are cancelled with it.', kind: 'command', command: 'Esc', expectedOutcome: 'The turn ends as cancelled and the composer is free.', automatable: false },
    { step: 3, title: 'Look at the provider', action: 'Run /health provider to see whether the model provider is degraded, and switch with /model if it is.', kind: 'command', command: '/health provider', expectedOutcome: 'A healthy provider is selected.', automatable: false },
    { step: 4, title: 'Retry the turn', action: 'Run /retry to send the last message again.', kind: 'command', command: '/retry', expectedOutcome: 'The turn completes or fails with a clear error.', automatable: false },
  ],
  escalationCriteria: [
    'Several turns in a row stall after cancel and retry',
    'No runtime activity for more than 60 s with a turn in flight',
    'Memory keeps growing while no turn completes (/health memory)',
  ],
  tags: ['turn', 'task', 'stuck', 'timeout', 'hang', 'llm'],
};

/** The stuck-turn playbook (kept as a function for callers that build playbooks). */
export function createStuckTurnPlaybook(): Playbook {
  return stuckTurnPlaybook;
}
