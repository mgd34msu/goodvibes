import { readModeCategory } from '@goodvibes/engine/platform/platform/types';
import type { ToolRegistry } from '@goodvibes/engine/platform/platform/tools';
import { wrapAgentContextToolForAgentPolicy } from './agent-context-policy.ts';
import { validateAgentSettingsMechanics, type SettingsToolArgs } from '@goodvibes/engine/platform/platform/gate/policy';
import type { AgentToolPolicyInvocationExplanation } from './agent-tool-policy-guard-types.ts';
import { agentReadModesFor, installAgentToolPolicy } from '@goodvibes/engine/terminal-shell/agent-turn/read-modes';
export type { AgentToolPolicyInvocationExplanation } from './agent-tool-policy-guard-types.ts';

/**
 * The Agent's tool policy, installed on the main registry and on every
 * worker's registry: the one policy a session the daemon hosts for the Agent
 * gets too (agent-turn's installAgentToolPolicy), with goodvibes_context as
 * this process's view over agent_harness. A call is decided by the permission
 * gate alone.
 */
export function installAgentToolPolicyGuard(registry: ToolRegistry): void {
  installAgentToolPolicy(registry, wrapAgentContextToolForAgentPolicy);
}

export function explainAgentToolPolicyInvocation(
  toolName: string,
  args: Record<string, unknown> = {},
): AgentToolPolicyInvocationExplanation {
  const readModes = agentReadModesFor(toolName);
  if (readModes) {
    const mode = typeof args[readModes.field] === 'string' ? String(args[readModes.field]) : '(none)';
    // The gate's own rule: a listed mode is a read, anything else is a change.
    return readModeCategory(readModes, args, 'write') === 'read'
      ? { status: 'allowed', layer: 'agent_tool_policy', reason: `${toolName} ${readModes.field} "${mode}" only reads; it runs as a read.`, allowedModes: readModes.values }
      : {
        status: 'needs_approval', layer: 'agent_tool_policy', allowedModes: readModes.values,
        reason: `${toolName} ${readModes.field} "${mode}" changes something, so the permission gate decides it like any change (it asks the owner, or Jev decides, as the permission mode says). Modes that only read: ${readModes.values.join(', ')}.`,
      };
  }
  if (toolName === 'goodvibes_settings') {
    const denied = validateAgentSettingsMechanics(args as SettingsToolArgs);
    return denied
      ? { status: 'denied', layer: 'agent_tool_policy', reason: denied }
      : { status: 'allowed', layer: 'agent_tool_policy', reason: 'Mechanical settings checks pass; the original host source and resolved effect still require current recorded admission. This explanation grants no authority.' };
  }
  if (toolName === 'read') {
    return { status: 'allowed', layer: 'agent_tool_policy', reason: 'Read requires a current bound admission for its actual non-secret, requested subjects. This explanation grants no execution authority.' };
  }
  return { status: 'allowed', layer: 'agent_tool_policy', reason: 'No Agent rule applies; the permission gate decides this call.' };
}
