/**
 * Playbook: Permission Deadlock
 *
 * Tool calls held by permission asks nobody answers.
 */
import type { Playbook } from '../types.js';
import { safeCheck } from '../safe-check.js';

/** An approval older than this has been waiting long enough to hold up work. */
const LONG_WAIT_MS = 30_000;

/** Permission deadlock resolution playbook. */
export const permissionDeadlockPlaybook: Playbook = {
  id: 'permission-deadlock',
  name: 'Permission Deadlock',
  description: 'Diagnoses tool calls held by permission asks that nobody answers.',
  symptoms: [
    'A tool call waits for permission for a long time',
    'A permission prompt does not respond or never appears',
    'Several tool calls queued behind one approval',
    'Approval asked on another device that nobody sees',
  ],
  checks: [
    {
      id: 'permission.pending-requests',
      label: 'Approvals waiting on you',
      description: 'Approvals waiting on the owner, and how long the oldest has waited.',
      run: (ctx) => safeCheck(() => {
        const pending = ctx.pendingApprovals?.();
        if (!pending) {
          const { permissions } = ctx.store.getState();
          return {
            passed: !permissions.awaitingDecision,
            summary: permissions.awaitingDecision
              ? `A permission decision is in progress (${permissions.decisionMachineState ?? 'deciding'}).`
              : 'No permission decision is in progress.',
            severity: permissions.awaitingDecision ? 'warning' : 'info',
          };
        }
        if (pending.length === 0) return { passed: true, summary: 'Nothing is waiting on your answer.', severity: 'info' };
        const oldest = pending[0]!;
        const waitedMs = ctx.now() - oldest.createdAt;
        return {
          passed: waitedMs <= LONG_WAIT_MS,
          summary: `${pending.length} approval(s) wait on your answer; the oldest (${oldest.tool}) has waited ${Math.round(waitedMs / 1000)} s.`,
          severity: waitedMs > LONG_WAIT_MS ? 'error' : 'warning',
          context: { pendingApprovals: pending.length, oldestTool: oldest.tool, oldestWaitedMs: waitedMs },
        };
      }),
    },
    {
      id: 'permission.gate-in-flight',
      label: 'Calls held at the gate',
      description: 'Tool calls whose permission decision has started and not ended.',
      run: (ctx) => safeCheck(() => {
        const { permissions } = ctx.store.getState();
        const held = permissions.inFlightCallIds?.length ?? (permissions.awaitingDecision ? 1 : 0);
        return {
          passed: held === 0,
          summary: held === 0 ? 'No tool call is held at the gate.' : `${held} tool call(s) are held at the gate.`,
          severity: held === 0 ? 'info' : 'warning',
          context: { heldCalls: held, mode: permissions.mode },
        };
      }),
    },
  ],
  steps: [
    { step: 1, title: 'Answer the waiting approvals', action: 'Open /questions and answer what is waiting; an answer from any surface releases the call.', kind: 'command', command: '/questions', expectedOutcome: 'The held calls run or are refused.', automatable: false },
    { step: 2, title: 'Remember the answer', action: 'Answer with "always" for a call you want to stop being asked about; review remembered answers with /decisions.', kind: 'command', command: '/decisions', expectedOutcome: 'The same call no longer asks.', automatable: false },
    { step: 3, title: 'Stop the turn', action: 'If you do not want the held calls to run, press Esc to cancel the turn.', kind: 'command', command: 'Esc', expectedOutcome: 'The turn ends and the asks are withdrawn.', automatable: false },
  ],
  escalationCriteria: [
    'An approval stays waiting after it was answered',
    'Approvals keep arriving for calls a remembered rule should cover',
  ],
  tags: ['permission', 'approval', 'deadlock', 'blocked', 'gate'],
};
