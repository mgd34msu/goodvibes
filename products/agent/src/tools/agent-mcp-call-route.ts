import type { ToolRegistry } from '@goodvibes/engine/platform/platform/tools';

/**
 * The engine's `mcp` tool carries the call mode itself (`mode: "call"`, run
 * through the MCP registry and its gates), in every product and every spawned
 * agent's registry. This module only records whether this process's registry
 * offers it, so the Agent's capability and policy explanations say the same
 * thing the tool accepts.
 */
export const AGENT_MCP_CALL_MODE = 'call';

let callRouteInstalled = false;

export function isAgentMcpCallRouteInstalled(): boolean {
  return callRouteInstalled;
}

/** Test seam: restores the unread state between cases. */
export function resetAgentMcpCallRouteForTests(): void {
  callRouteInstalled = false;
}

function offersCallMode(parameters: Record<string, unknown>): boolean {
  const properties = parameters.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return false;
  const mode = (properties as Record<string, unknown>).mode;
  if (!mode || typeof mode !== 'object' || Array.isArray(mode)) return false;
  const values = (mode as { enum?: unknown }).enum;
  return Array.isArray(values) && values.includes(AGENT_MCP_CALL_MODE);
}

/**
 * Reads whether the registered `mcp` tool offers the call mode. Nothing is
 * patched: the call path, its schema and its gates live in the engine tool.
 * The context argument is accepted for callers that still pass it.
 */
export function installAgentMcpCallRoute(registry: ToolRegistry, _context?: unknown): boolean {
  const tool = registry.list().find((candidate) => candidate.definition.name === 'mcp');
  callRouteInstalled = tool !== undefined && offersCallMode(tool.definition.parameters);
  return callRouteInstalled;
}
