import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import type { ToolExecuteOptions, ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import { forwardHarnessCatalogCall } from '@goodvibes-jev/engine/terminal-shell/agent-turn/catalog-ingress';

const AGENT_CONTEXT_TOOL_MODES = [
  'summary',
  'capabilities',
  'modes',
  'tools',
  'tool',
  'settings',
  'setting',
  'commands',
  'command',
  'workspace',
  'status',
] as const;

type AgentContextMode = typeof AGENT_CONTEXT_TOOL_MODES[number];

type AgentContextArgs = {
  readonly mode?: unknown;
  readonly query?: unknown;
  readonly target?: unknown;
  readonly toolName?: unknown;
  readonly command?: unknown;
  readonly commandName?: unknown;
  readonly key?: unknown;
  readonly category?: unknown;
  readonly prefix?: unknown;
  readonly includeHidden?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
};

const CONTEXT_TOOL_FALLBACK = {
  runtime: 'GoodVibes Agent',
  preferredTool: 'agent_harness',
  routes: {
    summary: 'agent_harness mode:"summary"',
    capabilities: 'goodvibes_context mode:"capabilities"',
    tools: 'agent_harness mode:"tools"',
    tool: 'agent_harness mode:"tool"',
    settings: 'settings action:"list"',
    commands: 'workspace action:"commands"',
    workspace: 'workspace action:"status"',
    status: 'host action:"status"',
  },
};

export function wrapAgentContextToolForAgentPolicy(tool: Tool, registry?: ToolRegistry): void {
  tool.definition.description = 'Inspect GoodVibes Agent harness capabilities.';
  tool.definition.sideEffects = [];
  tool.definition.parameters = {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: [...AGENT_CONTEXT_TOOL_MODES] },
      query: { type: 'string' },
      target: { type: 'string' },
      toolName: { type: 'string' },
      command: { type: 'string' },
      commandName: { type: 'string' },
      key: { type: 'string' },
      category: { type: 'string' },
      prefix: { type: 'string' },
      includeHidden: { type: 'boolean' },
      includeParameters: { type: 'boolean' },
      limit: { type: 'number' },
    },
    additionalProperties: false,
  };
  tool.execute = async (rawArgs, options) => {
    const args = rawArgs as AgentContextArgs;
    const mode = readAgentContextMode(args.mode);
    if (mode === 'capabilities') return ok(await buildAgentCapabilities(registry, options));

    const harnessMode = agentContextModeToHarnessMode(mode);
    const harnessTool = registry?.list().find((entry) => entry.definition.name === 'agent_harness');
    if (!harnessTool) {
      return ok({
        ...CONTEXT_TOOL_FALLBACK,
        status: 'agent_harness_not_registered_yet',
        requestedMode: mode,
        route: `agent_harness mode:"${harnessMode}"`,
      });
    }

    const harnessArgs = {
      mode: harnessMode,
      query: args.query,
      target: args.target,
      toolName: args.toolName,
      command: args.command,
      commandName: args.commandName,
      key: args.key,
      category: args.category,
      prefix: args.prefix,
      includeHidden: args.includeHidden,
      includeParameters: args.includeParameters,
      limit: args.limit,
    };
    // The harness binds an invocation to the args object it was admitted with, so the
    // forward goes through the same guarded path as the sibling tools.
    const result = await forwardHarnessCatalogCall(harnessTool, rawArgs as Record<string, unknown>, dropUndefined(harnessArgs), options);
    if (!result.success) return result;
    return ok({
      source: 'agent_harness',
      requestedMode: mode,
      route: `agent_harness mode:"${harnessMode}"`,
      result: parseToolOutput(result.output),
    });
  };
}

export const AGENT_CONTEXT_TOOL_COMPATIBILITY_MODES = AGENT_CONTEXT_TOOL_MODES;

function readAgentContextMode(value: unknown): AgentContextMode {
  return typeof value === 'string' && AGENT_CONTEXT_TOOL_MODES.includes(value as AgentContextMode)
    ? value as AgentContextMode
    : 'summary';
}

function agentContextModeToHarnessMode(mode: AgentContextMode): string {
  if (mode === 'modes') return 'modes';
  if (mode === 'tools') return 'tools';
  if (mode === 'tool') return 'tool';
  if (mode === 'settings') return 'settings';
  if (mode === 'setting') return 'get_setting';
  if (mode === 'commands') return 'commands';
  if (mode === 'command') return 'command';
  if (mode === 'workspace') return 'workspace';
  if (mode === 'status') return 'connected_host_status';
  return 'summary';
}

/**
 * What this build can do, from the running process: the live capability index
 * (`capability_status`, re-resolved on every call) and the registered tool
 * names. Nothing here is written by hand, so it cannot claim a tool the build
 * does not register.
 */
async function buildAgentCapabilities(registry: ToolRegistry | undefined, options: ToolExecuteOptions | undefined): Promise<Record<string, unknown>> {
  const registeredTools = safeToolNames(registry);
  const capabilityTool = registry?.list().find((entry) => entry.definition.name === 'capability_status');
  if (!capabilityTool) {
    return { runtime: 'GoodVibes Agent', capabilityIndex: 'capability_status is not registered in this build, so only the registered tool names are known.', registeredTools };
  }
  const status = await capabilityTool.execute({ subject: 'all' }, options);
  return {
    runtime: 'GoodVibes Agent',
    capabilityIndex: status.success ? status.output : `The live capability index could not be read: ${status.error ?? 'unknown error'}`,
    registeredTools,
    findCapability: 'agent_harness mode:"modes" query:"<task>"',
  };
}

function safeToolNames(registry?: ToolRegistry): readonly string[] {
  try {
    return registry?.getToolDefinitions().map((tool) => tool.name).sort((a, b) => a.localeCompare(b)) ?? [];
  } catch {
    return [];
  }
}

function dropUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function parseToolOutput(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function ok(value: unknown): { readonly success: true; readonly output: string } {
  return { success: true, output: JSON.stringify(value, null, 2) };
}
