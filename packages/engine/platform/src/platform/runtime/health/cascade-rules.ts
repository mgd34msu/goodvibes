/**
 * Declarative cascade rules table for the goodvibes-platform runtime.
 *
 * A cascade REPORTS what a failing domain affects; it does not cancel, block
 * or deregister anything, and it never changes another domain's status (each
 * domain's status comes from its own entities, see domain-events.ts). Each
 * firing is published as a CASCADE_APPLIED event with `enforced: false`, and
 * names the remediation playbooks for that failure mode.
 *
 * Each entry is pure data: adding a rule means adding one object here; the
 * playbook map and the list of rule ids are derived from this table.
 */

import type { CascadeRule } from './types.js';

/**
 * All cascade rules that govern cross-domain health reporting.
 * Rules are evaluated by the CascadeEngine whenever a domain health changes.
 */
export const CASCADE_RULES: CascadeRule[] = [
  {
    id: 'turn-failed-cancels-tools',
    source: 'turn',
    sourceState: 'failed',
    target: 'toolExecution',
    effect: { type: 'CANCEL_INFLIGHT', scope: 'all-tools' },
    description: 'Reports that tool calls of a failed turn are affected; the turn itself ends its tool calls.',
    recoveryFirst: false,
    playbooks: ['stuck-turn'],
  },
  {
    id: 'tool-failed-errors-turn',
    source: 'toolExecution',
    sourceState: 'failed',
    target: 'turn',
    effect: { type: 'EMIT_EVENT', eventType: 'TOOL_DISPATCH_ERROR' },
    description: 'Reports that a failing tool path affects the turns that call it.',
    recoveryFirst: true,
    playbooks: ['stuck-turn'],
  },
  {
    id: 'mcp-disconnected-blocks-mcp-tools',
    source: 'mcp',
    sourceState: 'failed',
    target: 'toolExecution',
    effect: { type: 'BLOCK_DISPATCH', scope: 'mcp-tools', queueable: true },
    description: 'Reports that calls to the tools of a disconnected MCP server will fail until it reconnects.',
    recoveryFirst: true,
    playbooks: ['reconnect-failure'],
  },
  {
    id: 'agent-failed-marks-child-tasks',
    source: 'agents',
    sourceState: 'failed',
    target: 'tasks',
    effect: { type: 'MARK_CHILDREN', status: 'failed', notifyParent: true },
    description: 'Reports that the tasks a failed agent owned are affected; each task reports its own outcome.',
    recoveryFirst: false,
    playbooks: ['stuck-turn'],
  },
  {
    id: 'plugin-error-deregisters-tools',
    source: 'plugins',
    sourceState: 'failed',
    target: 'toolExecution',
    // To name only the failing plugin's tools, pass sourceContext: { pluginId } to evaluate().
    effect: { type: 'DEREGISTER_TOOLS' },
    description: 'Reports that the tools of a plugin in error state are affected.',
    recoveryFirst: false,
    playbooks: ['plugin-degradation'],
  },
  {
    id: 'transport-disconnected-blocks-remote-tasks',
    source: 'transport',
    sourceState: 'failed',
    target: 'tasks',
    effect: { type: 'BLOCK_DISPATCH', scope: 'remote-tasks', queueable: false },
    description: 'Reports that remote tasks cannot be reached while their transport is disconnected.',
    recoveryFirst: true,
    playbooks: ['reconnect-failure', 'stuck-turn'],
  },
  {
    id: 'session-recovery-failed-unrecoverable',
    source: 'session',
    sourceState: 'failed',
    target: 'ALL',
    effect: { type: 'EMIT_EVENT', eventType: 'SESSION_UNRECOVERABLE' },
    description: 'Reports SESSION_UNRECOVERABLE when session recovery fails.',
    recoveryFirst: false,
    playbooks: ['session-unrecoverable'],
  },
  {
    id: 'compaction-failed-blocks-new-turns',
    source: 'compaction',
    sourceState: 'failed',
    target: 'turn',
    effect: { type: 'BLOCK_NEW', scope: 'new-turns' },
    description: 'Reports that new turns in a session whose compaction failed may run out of context.',
    recoveryFirst: true,
    playbooks: ['compaction-failure'],
  },
];
