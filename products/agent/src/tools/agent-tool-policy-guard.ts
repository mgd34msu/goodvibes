import { readModeCategory, type ToolReadModes } from '@goodvibes-jev/engine/platform/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import { wrapAgentContextToolForAgentPolicy } from './agent-context-policy.ts';
import { wrapReadToolForAgentPolicy } from './agent-read-policy.ts';
import {
  wrapSettingsToolForAdmittedAgentPolicy,
  validateAgentSettingsMechanics,
  type SettingsToolArgs,
} from '@goodvibes-jev/engine/platform/platform/gate/policy';
import type { AgentToolPolicyInvocationExplanation } from './agent-tool-policy-guard-types.ts';
export type { AgentToolPolicyInvocationExplanation } from './agent-tool-policy-guard-types.ts';

/**
 * The one table of the Agent's mode policy: for each tool, the modes that only
 * read. It is set on the tool's definition as `readModes`, so the permission
 * gate (the only place a call is decided) classes a listed mode as a read and
 * decides any other mode as a change: asked of the owner, or decided by Jev,
 * as the permission mode says. Nothing here refuses a call. The same table
 * answers the policy explanation, so what the Agent says matches what runs.
 */
const AGENT_READ_MODES: Readonly<Record<string, ToolReadModes>> = Object.freeze({
  remote: { field: 'mode', values: ['pools', 'contracts', 'artifacts', 'review'] },
  // Resolving a target that would be created is a change, whatever the mode.
  channel: { field: 'mode', values: ['accounts', 'directory', 'resolve_target', 'capabilities', 'tools', 'agent_tools', 'actions'], unless: ['createIfMissing'] },
  mcp: { field: 'mode', values: ['servers', 'tools', 'schema', 'resources', 'security', 'auth'] },
  control: { field: 'mode', values: ['commands', 'panels', 'subscriptions'] },
  task: { field: 'mode', values: ['list', 'show', 'handoffs'] },
  query: { field: 'mode', values: ['list', 'show'] },
});

/** The read modes the Agent declares for a tool, when it declares any. */
export function agentReadModesFor(toolName: string): ToolReadModes | undefined {
  return AGENT_READ_MODES[toolName];
}

/**
 * The Agent's tool policy, installed on the main registry and on every
 * worker's registry: each tool in the table gets its read modes on its
 * definition, and read, settings and goodvibes_context get the engine's
 * admission readers. A call is decided by the permission gate alone.
 */
export function installAgentToolPolicyGuard(registry: ToolRegistry): void {
  for (const tool of registry.list()) {
    const readModes = AGENT_READ_MODES[tool.definition.name];
    if (readModes) {
      tool.definition = { ...tool.definition, readModes };
    } else if (tool.definition.name === 'read') {
      wrapReadToolForAgentPolicy(tool);
    } else if (tool.definition.name === 'goodvibes_context') {
      wrapAgentContextToolForAgentPolicy(tool, registry);
    } else if (tool.definition.name === 'goodvibes_settings') {
      wrapSettingsToolForAdmittedAgentPolicy(tool);
    }
  }
}

export function explainAgentToolPolicyInvocation(
  toolName: string,
  args: Record<string, unknown> = {},
): AgentToolPolicyInvocationExplanation {
  const readModes = AGENT_READ_MODES[toolName];
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
