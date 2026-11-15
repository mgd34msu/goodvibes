import { isYoloExecution } from '@goodvibes-jev/engine/platform/platform/gate';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { assertCurrentToolExecution } from '@goodvibes-jev/engine/platform/platform/tools';
import type { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import {
  wrapAgentContextToolForAgentPolicy,
} from './agent-context-policy.ts';
import { AGENT_MCP_CALL_MODE, isAgentMcpCallRouteInstalled } from './agent-mcp-call-route.ts';
import { wrapReadToolForAgentPolicy } from './agent-read-policy.ts';
import {
  READ_ONLY_STATE_ANALYTICS_ACTIONS,
  READ_ONLY_STATE_HOOK_ACTIONS,
  READ_ONLY_STATE_MEMORY_ACTIONS,
  READ_ONLY_STATE_MODE_ACTIONS,
  READ_ONLY_STATE_TOOL_MODES,
  wrapSettingsToolForAdmittedAgentPolicy,
  validateAgentSettingsMechanics,
  type SettingsToolArgs,
} from '@goodvibes-jev/engine/platform/platform/gate/policy';
import type {
  AgentToolArgs,
  AgentToolPolicyGuardOptions,
  AgentToolPolicyInvocationExplanation,
  ExecToolArgs,
  FetchToolArgs,
  InspectToolArgs,
  ModeRestrictedToolPolicy,
  ModeToolArgs,
  StateToolArgs,
} from './agent-tool-policy-guard-types.ts';
export type { AgentToolPolicyInvocationExplanation } from './agent-tool-policy-guard-types.ts';

const BLOCKED_MAIN_CONVERSATION_TOOL_NAMES = [] as const;

const READ_ONLY_AGENT_TOOL_MODES = [
  'spawn',
  'batch-spawn',
  'status',
  'cancel',
  'list',
  'templates',
  'get',
  'budget',
  'plan',
  'wait',
  'message',
  'contracts',
  'contract-history',
  'cohort-status',
  'cohort-report',
] as const;

const READ_ONLY_AGENT_TOOL_MODE_SET = new Set<string>(READ_ONLY_AGENT_TOOL_MODES);
const BLOCKED_MAIN_CONVERSATION_TOOL_NAME_SET = new Set<string>(BLOCKED_MAIN_CONVERSATION_TOOL_NAMES);

const READ_ONLY_REMOTE_TOOL_MODES = ['pools', 'contracts', 'artifacts', 'review'] as const;
const READ_ONLY_CHANNEL_TOOL_MODES = ['accounts', 'directory', 'resolve_target', 'capabilities', 'tools', 'agent_tools', 'actions'] as const;
const READ_ONLY_MCP_TOOL_MODES = ['servers', 'tools', 'schema', 'resources', 'security', 'auth'] as const;
const READ_ONLY_FETCH_METHODS = ['GET', 'HEAD', 'OPTIONS'] as const;
const READ_ONLY_TASK_TOOL_MODES = ['list', 'show', 'handoffs'] as const;
const READ_ONLY_TEAM_TOOL_MODES = ['list', 'show'] as const;
const READ_ONLY_WORKLIST_TOOL_MODES = ['list', 'show'] as const;
const READ_ONLY_PACKET_TOOL_MODES = ['list', 'show'] as const;
const READ_ONLY_QUERY_TOOL_MODES = ['list', 'show'] as const;
const READ_ONLY_CONTROL_TOOL_MODES = ['commands', 'panels', 'subscriptions'] as const;
const READ_ONLY_REMOTE_TOOL_MODE_SET = new Set<string>(READ_ONLY_REMOTE_TOOL_MODES);
const READ_ONLY_CHANNEL_TOOL_MODE_SET = new Set<string>(READ_ONLY_CHANNEL_TOOL_MODES);
const READ_ONLY_MCP_TOOL_MODE_SET = new Set<string>(READ_ONLY_MCP_TOOL_MODES);
const READ_ONLY_FETCH_METHOD_SET = new Set<string>(READ_ONLY_FETCH_METHODS);
const READ_ONLY_STATE_TOOL_MODE_SET = new Set<string>(READ_ONLY_STATE_TOOL_MODES);
const READ_ONLY_STATE_MEMORY_ACTION_SET = new Set<string>(READ_ONLY_STATE_MEMORY_ACTIONS);
const READ_ONLY_STATE_HOOK_ACTION_SET = new Set<string>(READ_ONLY_STATE_HOOK_ACTIONS);
const READ_ONLY_STATE_MODE_ACTION_SET = new Set<string>(READ_ONLY_STATE_MODE_ACTIONS);
const READ_ONLY_STATE_ANALYTICS_ACTION_SET = new Set<string>(READ_ONLY_STATE_ANALYTICS_ACTIONS);
const READ_ONLY_TASK_TOOL_MODE_SET = new Set<string>(READ_ONLY_TASK_TOOL_MODES);
const READ_ONLY_TEAM_TOOL_MODE_SET = new Set<string>(READ_ONLY_TEAM_TOOL_MODES);
const READ_ONLY_WORKLIST_TOOL_MODE_SET = new Set<string>(READ_ONLY_WORKLIST_TOOL_MODES);
const READ_ONLY_PACKET_TOOL_MODE_SET = new Set<string>(READ_ONLY_PACKET_TOOL_MODES);
const READ_ONLY_QUERY_TOOL_MODE_SET = new Set<string>(READ_ONLY_QUERY_TOOL_MODES);
const READ_ONLY_CONTROL_TOOL_MODE_SET = new Set<string>(READ_ONLY_CONTROL_TOOL_MODES);

const LOCAL_AGENT_DENIAL = [
  'GoodVibes Agent creates only visible, tracked Agent jobs.',
  'Use a known agent mode and keep spawned work tied to the user request, visible status, and cancellable follow-up.',
].join(' ');

const LOCAL_CODING_TOOL_DENIAL = [
  'This tool is not exposed directly in GoodVibes Agent.',
  'Use a first-class visible Agent tool or a confirmed GoodVibes daemon operator method for the requested workflow.',
].join(' ');

const BACKGROUND_EXEC_DENIAL = [
  'Invalid command options.',
].join(' ');

const REMOTE_MUTATION_DENIAL = [
  'GoodVibes Agent only inspects remote build-host pools, contracts, artifacts, and review summaries from the main conversation.',
  'Remote pool creation, assignment, unassignment, and artifact import are disabled here.',
  'Use explicit GoodVibes TUI delegation for build/fix/review execution changes.',
].join(' ');

const CHANNEL_ACTION_DENIAL = [
  'GoodVibes Agent only inspects channel accounts, directories, capabilities, tools, and actions from the main conversation.',
  'Channel account actions, tool runs, operator action runs, authorization, and target auto-creation are disabled here.',
  'External channel side effects run only after the owner approves that exact call through the Agent approval flow; ask the owner when one is needed.',
].join(' ');

const MCP_SECURITY_MUTATION_DENIAL = [
  'GoodVibes Agent only inspects MCP servers, tools, schemas, resources, security, and auth state from the main conversation.',
  'MCP quarantine approval, trust changes, and role changes are disabled here.',
  'MCP security mutations require an explicit Agent approval flow before they can run.',
].join(' ');

const FETCH_NETWORK_MUTATION_DENIAL = [
  'GoodVibes Agent only performs unauthenticated, read-only HTTP fetches from the main conversation.',
  'Non-read methods, request bodies, custom auth/header/service credentials, trust overrides, raw unsanitized responses are disabled here.',
  'Network writes or credentialed external calls require an explicit Agent approval flow before they can run.',
].join(' ');

const STATE_MUTATION_DENIAL = [
  'GoodVibes Agent only inspects runtime-owned state from the main conversation.',
  'Arbitrary state set/clear, runtime-owned memory writes, hook mutation, output-mode mutation, and analytics writes are disabled here.',
  'Use Agent-owned memory, skills, personas, routines, and explicit CLI/slash commands for intentional local state changes.',
].join(' ');

// `goodvibes_settings` has no key list here: the engine's admitted settings
// wrapper checks the call's mechanics, and whether a write goes ahead is decided
// by the recorded admission for the exact effect.

const INSPECT_WRITE_DENIAL = [
  'GoodVibes Agent only uses inspect scaffold mode for dry-run planning from the main conversation.',
  'File scaffolding and code creation are disabled in the Agent model tool surface.',
  'Delegate explicit build/implement/fix/review work to GoodVibes TUI instead.',
].join(' ');

const DURABLE_WORKFLOW_MUTATION_DENIAL = [
  'GoodVibes Agent only inspects runtime-owned durable workflow tools from the main conversation.',
  'Task, team, worklist, packet, and query creation or lifecycle mutation is disabled here.',
  'Use explicit Agent CLI/slash commands or GoodVibes TUI delegation for intentional workflow changes.',
].join(' ');

const CONTROL_MUTATION_DENIAL = [
  'GoodVibes Agent only inspects runtime-owned product-control surfaces from the main conversation.',
  'Product-control mutation, connected-host lifecycle, and connected-host posture changes are disabled here.',
  'Use explicit Agent CLI/slash commands for Agent-owned changes, and keep connected-host lifecycle external.',
].join(' ');

/**
 * The only Agent tool guard installer; the engine no longer carries a second copy.
 * The read admission and settings wrappers come from the engine gate; find,
 * web search, analyze and registry carry no Agent restriction (each tool's own
 * schema and scope apply). Under yolo execution every wrapper here passes the
 * call through, by design: yolo is the owner's explicit decision to run
 * without these narrowings.
 */
export function installAgentToolPolicyGuard(registry: ToolRegistry, options: AgentToolPolicyGuardOptions = {}): void {
  const agentTool = registry.list().find((tool) => tool.definition.name === 'agent');
  if (!agentTool) throw new Error('Agent tool policy guard could not find the agent tool.');
  wrapAgentToolForAgentPolicy(agentTool, options);
  for (const tool of registry.list()) {
    if (tool.definition.name === 'exec') {
      wrapExecToolForAgentPolicy(tool);
    } else if (tool.definition.name === 'read') {
      wrapReadToolForAgentPolicy(tool);
    } else if (tool.definition.name === 'remote') {
      wrapModeRestrictedToolForAgentPolicy(tool, {
        allowedModes: READ_ONLY_REMOTE_TOOL_MODES,
        modeSet: READ_ONLY_REMOTE_TOOL_MODE_SET,
        denial: REMOTE_MUTATION_DENIAL,
      });
    } else if (tool.definition.name === 'channel') {
      wrapChannelToolForAgentPolicy(tool);
    } else if (tool.definition.name === 'mcp') {
      wrapModeRestrictedToolForAgentPolicy(tool, {
        allowedModes: READ_ONLY_MCP_TOOL_MODES,
        modeSet: READ_ONLY_MCP_TOOL_MODE_SET,
        denial: MCP_SECURITY_MUTATION_DENIAL,
      });
    } else if (tool.definition.name === 'fetch') {
      wrapFetchToolForAgentPolicy(tool);
    } else if (tool.definition.name === 'state') {
      wrapStateToolForAgentPolicy(tool);
    } else if (tool.definition.name === 'goodvibes_context') {
      wrapAgentContextToolForAgentPolicy(tool, registry);
    } else if (tool.definition.name === 'goodvibes_settings') {
      wrapSettingsToolForAdmittedAgentPolicy(tool);
    } else if (tool.definition.name === 'inspect') {
      wrapInspectToolForAgentPolicy(tool);
    } else if (tool.definition.name === 'control') {
      wrapModeRestrictedToolForAgentPolicy(tool, {
        allowedModes: READ_ONLY_CONTROL_TOOL_MODES,
        modeSet: READ_ONLY_CONTROL_TOOL_MODE_SET,
        denial: CONTROL_MUTATION_DENIAL,
      });
    } else if (tool.definition.name === 'task') {
      wrapModeRestrictedToolForAgentPolicy(tool, {
        allowedModes: READ_ONLY_TASK_TOOL_MODES,
        modeSet: READ_ONLY_TASK_TOOL_MODE_SET,
        denial: DURABLE_WORKFLOW_MUTATION_DENIAL,
      });
    } else if (tool.definition.name === 'team') {
      wrapModeRestrictedToolForAgentPolicy(tool, {
        allowedModes: READ_ONLY_TEAM_TOOL_MODES,
        modeSet: READ_ONLY_TEAM_TOOL_MODE_SET,
        denial: DURABLE_WORKFLOW_MUTATION_DENIAL,
      });
    } else if (tool.definition.name === 'worklist') {
      wrapModeRestrictedToolForAgentPolicy(tool, {
        allowedModes: READ_ONLY_WORKLIST_TOOL_MODES,
        modeSet: READ_ONLY_WORKLIST_TOOL_MODE_SET,
        denial: DURABLE_WORKFLOW_MUTATION_DENIAL,
      });
    } else if (tool.definition.name === 'packet') {
      wrapModeRestrictedToolForAgentPolicy(tool, {
        allowedModes: READ_ONLY_PACKET_TOOL_MODES,
        modeSet: READ_ONLY_PACKET_TOOL_MODE_SET,
        denial: DURABLE_WORKFLOW_MUTATION_DENIAL,
      });
    } else if (tool.definition.name === 'query') {
      wrapModeRestrictedToolForAgentPolicy(tool, {
        allowedModes: READ_ONLY_QUERY_TOOL_MODES,
        modeSet: READ_ONLY_QUERY_TOOL_MODE_SET,
        denial: DURABLE_WORKFLOW_MUTATION_DENIAL,
      });
    } else if (BLOCKED_MAIN_CONVERSATION_TOOL_NAME_SET.has(tool.definition.name)) {
      wrapBlockedMainConversationToolForAgentPolicy(tool);
    }
    const advertised = ADVERTISED_MODES[tool.definition.name];
    if (advertised) describeAvailableModes(tool, advertised);
  }
}

const ADVERTISED_MODES: Readonly<Record<string, readonly string[]>> = {
  remote: READ_ONLY_REMOTE_TOOL_MODES,
  channel: READ_ONLY_CHANNEL_TOOL_MODES,
  mcp: READ_ONLY_MCP_TOOL_MODES,
  state: READ_ONLY_STATE_TOOL_MODES,
  control: READ_ONLY_CONTROL_TOOL_MODES,
  task: READ_ONLY_TASK_TOOL_MODES,
  team: READ_ONLY_TEAM_TOOL_MODES,
  worklist: READ_ONLY_WORKLIST_TOOL_MODES,
  packet: READ_ONLY_PACKET_TOOL_MODES,
  query: READ_ONLY_QUERY_TOOL_MODES,
};

export function wrapAgentToolForAgentPolicy(tool: Tool, _options: AgentToolPolicyGuardOptions = {}): void {
  const originalExecute = tool.execute.bind(tool);
  tool.execute = async (args, options) => {
    if (assertCurrentToolExecution(args, options) || isYoloExecution()) return originalExecute(args, options);
    const denial = validateAgentToolInvocationForAgentPolicy(args as AgentToolArgs);
    if (denial) return { success: false, error: denial };
    return originalExecute(normalizeAgentToolInvocationForAgentPolicy(args as AgentToolArgs) as Parameters<Tool['execute']>[0], options);
  };
}

export function validateAgentToolInvocationForAgentPolicy(args: AgentToolArgs): string | null {
  if (isYoloExecution()) return null;
  if (typeof args.mode === 'string' && !READ_ONLY_AGENT_TOOL_MODE_SET.has(args.mode)) return modeDenial(LOCAL_AGENT_DENIAL, args.mode, READ_ONLY_AGENT_TOOL_MODES);
  return null;
}

export function normalizeAgentToolInvocationForAgentPolicy(args: AgentToolArgs): AgentToolArgs {
  return args;
}

export function wrapBlockedMainConversationToolForAgentPolicy(tool: Tool): void {
  const originalExecute = tool.execute.bind(tool);
  tool.execute = async (args, options) => assertCurrentToolExecution(args, options) || isYoloExecution()
    ? originalExecute(args, options) : { success: false, error: LOCAL_CODING_TOOL_DENIAL };
}

export function wrapExecToolForAgentPolicy(tool: Tool): void {
  const originalExecute = tool.execute.bind(tool);
  // The second argument carries the call's abort signal: forwarding it is
  // what lets a cancelled call stop the running command.
  tool.execute = async (args, options) => {
    if (assertCurrentToolExecution(args, options) || isYoloExecution()) return originalExecute(args, options);
    const denial = validateExecToolInvocationForAgentPolicy(args as ExecToolArgs);
    if (denial) return { success: false, error: denial };
    return originalExecute(args, options);
  };
}

export function wrapFetchToolForAgentPolicy(tool: Tool): void {
  const originalExecute = tool.execute.bind(tool);
  tool.execute = async (args, options) => {
    if (assertCurrentToolExecution(args, options) || isYoloExecution()) return originalExecute(args, options);
    const denial = validateFetchToolInvocationForAgentPolicy(args as FetchToolArgs);
    if (denial) return { success: false, error: denial };
    return originalExecute(normalizeFetchToolInvocationForAgentPolicy(args as FetchToolArgs) as Parameters<Tool['execute']>[0], options);
  };
}

export function wrapStateToolForAgentPolicy(tool: Tool): void {
  const originalExecute = tool.execute.bind(tool);
  tool.execute = async (args, options) => {
    if (assertCurrentToolExecution(args, options) || isYoloExecution()) return originalExecute(args, options);
    const denial = validateStateToolInvocationForAgentPolicy(args as StateToolArgs);
    if (denial) return { success: false, error: denial };
    return originalExecute(args, options);
  };
}

export function wrapInspectToolForAgentPolicy(tool: Tool): void {
  const originalExecute = tool.execute.bind(tool);
  tool.execute = async (args, options) => {
    if (assertCurrentToolExecution(args, options) || isYoloExecution()) return originalExecute(args, options);
    const inspectArgs = args as InspectToolArgs;
    const denial = validateInspectToolInvocationForAgentPolicy(inspectArgs);
    if (denial) return { success: false, error: denial };
    return originalExecute(normalizeInspectToolInvocationForAgentPolicy(inspectArgs) as Parameters<Tool['execute']>[0], options);
  };
}

export function validateExecToolInvocationForAgentPolicy(_args: ExecToolArgs): string | null {
  if (isYoloExecution()) return null;
  // Background lifecycle, file operations and concurrency are owned by exec.
  // The ordinary permission and publication checks still apply to every call.
  return null;
}

export function validateFetchToolInvocationForAgentPolicy(args: FetchToolArgs): string | null {
  if (isYoloExecution()) return null;
  if (args.sanitize_mode === 'none') return FETCH_NETWORK_MUTATION_DENIAL;
  if (isPresent(args.trusted_hosts)) return FETCH_NETWORK_MUTATION_DENIAL;
  if (!Array.isArray(args.urls)) return null;

  for (const urlArgs of args.urls) {
    if (!isRecord(urlArgs)) continue;
    const method = typeof urlArgs.method === 'string' ? urlArgs.method.toUpperCase() : 'GET';
    if (!READ_ONLY_FETCH_METHOD_SET.has(method)) return FETCH_NETWORK_MUTATION_DENIAL;
    if (isPresent(urlArgs.body) || isPresent(urlArgs.body_base64) || isPresent(urlArgs.body_type) || isPresent(urlArgs.body_data)) {
      return FETCH_NETWORK_MUTATION_DENIAL;
    }
    if (isPresent(urlArgs.headers) || isPresent(urlArgs.auth) || isPresent(urlArgs.service) || isPresent(urlArgs.retry_on_auth)) {
      return FETCH_NETWORK_MUTATION_DENIAL;
    }
  }

  return null;
}

export function normalizeFetchToolInvocationForAgentPolicy(args: FetchToolArgs): FetchToolArgs {
  return args;
}

export function validateStateToolInvocationForAgentPolicy(args: StateToolArgs): string | null {
  if (isYoloExecution()) return null;
  if (isPresent(args.values) || isPresent(args.clearKeys)) return STATE_MUTATION_DENIAL;
  if (typeof args.mode === 'string' && !READ_ONLY_STATE_TOOL_MODE_SET.has(args.mode)) return modeDenial(STATE_MUTATION_DENIAL, args.mode, READ_ONLY_STATE_TOOL_MODES);

  if (args.mode === 'memory') {
    const action = typeof args.memoryAction === 'string' ? args.memoryAction : 'list';
    if (!READ_ONLY_STATE_MEMORY_ACTION_SET.has(action) || isPresent(args.memoryValue)) return STATE_MUTATION_DENIAL;
  }

  if (args.mode === 'hooks') {
    const action = typeof args.hookAction === 'string' ? args.hookAction : 'list';
    if (!READ_ONLY_STATE_HOOK_ACTION_SET.has(action) || isPresent(args.hookDefinition)) return STATE_MUTATION_DENIAL;
  }

  if (args.mode === 'mode') {
    const action = typeof args.modeAction === 'string' ? args.modeAction : 'get';
    if (!READ_ONLY_STATE_MODE_ACTION_SET.has(action) || isPresent(args.modeName)) return STATE_MUTATION_DENIAL;
  }

  if (args.mode === 'analytics') {
    const action = typeof args.analyticsAction === 'string' ? args.analyticsAction : 'summary';
    if (!READ_ONLY_STATE_ANALYTICS_ACTION_SET.has(action)) return STATE_MUTATION_DENIAL;
    if (
      isPresent(args.analyticsTool)
      || isPresent(args.analyticsArgs)
      || isPresent(args.analyticsResult)
      || isPresent(args.analyticsDuration)
      || isPresent(args.analyticsTokens)
      || isPresent(args.analyticsFormat)
    ) {
      return STATE_MUTATION_DENIAL;
    }
  }

  return null;
}

export function validateInspectToolInvocationForAgentPolicy(args: InspectToolArgs): string | null {
  if (isYoloExecution()) return null;
  if (args.mode === 'scaffold' && args.dryRun === false) return INSPECT_WRITE_DENIAL;
  return null;
}

export function normalizeInspectToolInvocationForAgentPolicy(args: InspectToolArgs): InspectToolArgs {
  if (args.mode !== 'scaffold') return args;
  return { ...args, dryRun: true };
}

/**
 * Tell the model which modes this surface allows, in the `mode` description.
 * The enum itself is NOT narrowed: the registry checks a call against the
 * advertised schema before any guard runs, and YOLO (decided per call) skips
 * this guard, so a narrowed enum would refuse in YOLO what the guard allows.
 * A refused mode still gets the guard's own message naming the allowed modes.
 */
export function describeAvailableModes(tool: Tool, modes: readonly string[]): void {
  const parameters = structuredClone(tool.definition.parameters) as Record<string, unknown>;
  const properties = parameters.properties;
  const mode = isRecord(properties) ? properties['mode'] : undefined;
  if (!isRecord(mode)) return;
  mode['description'] = `Operation. Available here: ${modes.join(', ')}.`;
  tool.definition = { ...tool.definition, parameters: parameters as Tool['definition']['parameters'] };
}

export function wrapModeRestrictedToolForAgentPolicy(tool: Tool, policy: ModeRestrictedToolPolicy): void {
  const originalExecute = tool.execute.bind(tool);
  tool.execute = async (args, options) => {
    if (assertCurrentToolExecution(args, options) || isYoloExecution()) return originalExecute(args, options);
    const denial = validateModeRestrictedToolInvocationForAgentPolicy(args as ModeToolArgs, policy.modeSet, policy.denial,
      availableModesFor(tool.definition.name, policy.allowedModes));
    if (denial) return { success: false, error: denial };
    return originalExecute(args, options);
  };
}

/** The modes a call can really use here; the MCP call route is layered on after this guard. */
function availableModesFor(toolName: string, allowedModes: readonly string[]): readonly string[] {
  return toolName === 'mcp' && isAgentMcpCallRouteInstalled() ? [...allowedModes, AGENT_MCP_CALL_MODE] : allowedModes;
}

/** A mode refusal names the refused mode and the ones this surface does allow. */
function modeDenial(denial: string, mode: string, available: Iterable<string>): string {
  // A call the owner has approved carries its own recorded admission and is not
  // held to this list, so the refusal is "not without approval", not "never".
  return `${denial} mode "${mode}" is not available here; available: ${[...available].join(', ')}. A call the owner has approved through the Agent approval flow is not limited to this list.`;
}

export function wrapChannelToolForAgentPolicy(tool: Tool): void {
  const originalExecute = tool.execute.bind(tool);
  tool.execute = async (args, options) => {
    if (assertCurrentToolExecution(args, options) || isYoloExecution()) return originalExecute(args, options);
    const denial = validateModeRestrictedToolInvocationForAgentPolicy(args as ModeToolArgs, READ_ONLY_CHANNEL_TOOL_MODE_SET, CHANNEL_ACTION_DENIAL, READ_ONLY_CHANNEL_TOOL_MODES)
      ?? validateChannelToolInvocationForAgentPolicy(args as ModeToolArgs);
    if (denial) return { success: false, error: denial };
    return originalExecute(args, options);
  };
}

export function validateModeRestrictedToolInvocationForAgentPolicy(
  args: ModeToolArgs,
  modeSet: ReadonlySet<string>,
  denial: string,
  available: Iterable<string> = modeSet,
): string | null {
  if (isYoloExecution()) return null;
  if (typeof args.mode === 'string' && !modeSet.has(args.mode)) return modeDenial(denial, args.mode, available);
  return null;
}

export function validateChannelToolInvocationForAgentPolicy(args: ModeToolArgs): string | null {
  if (isYoloExecution()) return null;
  if (args.mode === 'resolve_target' && args.createIfMissing === true) return CHANNEL_ACTION_DENIAL;
  return null;
}

function allowedByAgentPolicy(reason: string, allowedModes?: readonly string[]): AgentToolPolicyInvocationExplanation {
  return {
    status: 'allowed',
    layer: 'agent_tool_policy',
    reason,
    ...(allowedModes ? { allowedModes } : {}),
  };
}

function deniedByAgentPolicy(reason: string, allowedModes?: readonly string[]): AgentToolPolicyInvocationExplanation {
  return {
    status: 'denied',
    layer: 'agent_tool_policy',
    reason,
    ...(allowedModes ? { allowedModes } : {}),
  };
}

function explainModeRestrictedAgentPolicy(
  args: ModeToolArgs,
  allowedModes: readonly string[],
  modeSet: ReadonlySet<string>,
  denial: string,
): AgentToolPolicyInvocationExplanation {
  const denied = validateModeRestrictedToolInvocationForAgentPolicy(args, modeSet, denial, allowedModes);
  if (denied) return deniedByAgentPolicy(denied, allowedModes);
  const mode = typeof args.mode === 'string' && args.mode.trim() ? args.mode.trim() : '(default)';
  return allowedByAgentPolicy(`Agent policy allows ${mode} for read-only inspection on this tool.`, allowedModes);
}

export function explainAgentToolPolicyInvocation(
  toolName: string,
  args: Record<string, unknown> = {},
): AgentToolPolicyInvocationExplanation {
  if (BLOCKED_MAIN_CONVERSATION_TOOL_NAME_SET.has(toolName)) return deniedByAgentPolicy(LOCAL_CODING_TOOL_DENIAL);
  if (toolName === 'agent') {
    const denied = validateAgentToolInvocationForAgentPolicy(args as AgentToolArgs);
    return denied ? deniedByAgentPolicy(denied, READ_ONLY_AGENT_TOOL_MODES) : allowedByAgentPolicy('Agent policy allows visible tracked Agent modes.', READ_ONLY_AGENT_TOOL_MODES);
  }
  if (toolName === 'exec') {
    const denied = validateExecToolInvocationForAgentPolicy(args as ExecToolArgs);
    return denied ? deniedByAgentPolicy(denied) : allowedByAgentPolicy('Agent policy preserves the shared shell execution options.');
  }
  if (toolName === 'read') {
    return allowedByAgentPolicy('Read requires a current bound admission for its actual non-secret, requested subjects. This explanation grants no execution authority.');
  }
  if (toolName === 'remote') return explainModeRestrictedAgentPolicy(args as ModeToolArgs, READ_ONLY_REMOTE_TOOL_MODES, READ_ONLY_REMOTE_TOOL_MODE_SET, REMOTE_MUTATION_DENIAL);
  if (toolName === 'channel') {
    const modeDenied = validateModeRestrictedToolInvocationForAgentPolicy(args as ModeToolArgs, READ_ONLY_CHANNEL_TOOL_MODE_SET, CHANNEL_ACTION_DENIAL);
    const channelDenied = modeDenied ?? validateChannelToolInvocationForAgentPolicy(args as ModeToolArgs);
    return channelDenied
      ? deniedByAgentPolicy(channelDenied, READ_ONLY_CHANNEL_TOOL_MODES)
      : allowedByAgentPolicy('Agent policy allows read-only channel inspection.', READ_ONLY_CHANNEL_TOOL_MODES);
  }
  if (toolName === 'mcp') {
    // The call route is layered on after this guard, so the modes this tool
    // really accepts depend on whether it was installed. Reporting the
    // inspection-only list once calling is wired would be the same kind of
    // stale claim that made browser control look available when it was not.
    const mcpModes = isAgentMcpCallRouteInstalled()
      ? [...READ_ONLY_MCP_TOOL_MODES, AGENT_MCP_CALL_MODE]
      : READ_ONLY_MCP_TOOL_MODES;
    return explainModeRestrictedAgentPolicy(args as ModeToolArgs, mcpModes, new Set(mcpModes), MCP_SECURITY_MUTATION_DENIAL);
  }
  if (toolName === 'fetch') {
    const denied = validateFetchToolInvocationForAgentPolicy(args as FetchToolArgs);
    return denied ? deniedByAgentPolicy(denied, READ_ONLY_FETCH_METHODS) : allowedByAgentPolicy('Agent policy allows sanitized read-only HTTP fetches.', READ_ONLY_FETCH_METHODS);
  }
  if (toolName === 'state') {
    const denied = validateStateToolInvocationForAgentPolicy(args as StateToolArgs);
    return denied ? deniedByAgentPolicy(denied, READ_ONLY_STATE_TOOL_MODES) : allowedByAgentPolicy('Agent policy allows read-only runtime state inspection.', READ_ONLY_STATE_TOOL_MODES);
  }
  if (toolName === 'goodvibes_settings') {
    const denied = validateAgentSettingsMechanics(args as SettingsToolArgs);
    return denied
      ? deniedByAgentPolicy(denied)
      : allowedByAgentPolicy('Mechanical settings checks pass; the original host source and resolved effect still require current recorded admission. This explanation grants no authority.');
  }
  if (toolName === 'analyze' || toolName === 'registry' || toolName === 'find' || toolName === 'web_search') {
    return allowedByAgentPolicy('No Agent restriction; the tool\'s own schema and scope apply.');
  }
  if (toolName === 'inspect') {
    const denied = validateInspectToolInvocationForAgentPolicy(args as InspectToolArgs);
    return denied ? deniedByAgentPolicy(denied) : allowedByAgentPolicy('Agent policy allows inspection and dry-run scaffolding only.');
  }
  if (toolName === 'control') return explainModeRestrictedAgentPolicy(args as ModeToolArgs, READ_ONLY_CONTROL_TOOL_MODES, READ_ONLY_CONTROL_TOOL_MODE_SET, CONTROL_MUTATION_DENIAL);
  if (toolName === 'task') return explainModeRestrictedAgentPolicy(args as ModeToolArgs, READ_ONLY_TASK_TOOL_MODES, READ_ONLY_TASK_TOOL_MODE_SET, DURABLE_WORKFLOW_MUTATION_DENIAL);
  if (toolName === 'team') return explainModeRestrictedAgentPolicy(args as ModeToolArgs, READ_ONLY_TEAM_TOOL_MODES, READ_ONLY_TEAM_TOOL_MODE_SET, DURABLE_WORKFLOW_MUTATION_DENIAL);
  if (toolName === 'worklist') return explainModeRestrictedAgentPolicy(args as ModeToolArgs, READ_ONLY_WORKLIST_TOOL_MODES, READ_ONLY_WORKLIST_TOOL_MODE_SET, DURABLE_WORKFLOW_MUTATION_DENIAL);
  if (toolName === 'packet') return explainModeRestrictedAgentPolicy(args as ModeToolArgs, READ_ONLY_PACKET_TOOL_MODES, READ_ONLY_PACKET_TOOL_MODE_SET, DURABLE_WORKFLOW_MUTATION_DENIAL);
  if (toolName === 'query') return explainModeRestrictedAgentPolicy(args as ModeToolArgs, READ_ONLY_QUERY_TOOL_MODES, READ_ONLY_QUERY_TOOL_MODE_SET, DURABLE_WORKFLOW_MUTATION_DENIAL);
  return allowedByAgentPolicy('No Agent-specific route guard blocks this invocation.');
}

export const AGENT_LOCAL_SPAWN_DENIAL_MESSAGE = LOCAL_AGENT_DENIAL;
export const AGENT_READ_ONLY_TOOL_MODES = READ_ONLY_AGENT_TOOL_MODES;
export const AGENT_BLOCKED_MAIN_CONVERSATION_TOOL_NAMES = BLOCKED_MAIN_CONVERSATION_TOOL_NAMES;
export const AGENT_MAIN_CONVERSATION_TOOL_DENIAL_MESSAGE = LOCAL_CODING_TOOL_DENIAL;
export const AGENT_EXEC_BACKGROUND_DENIAL_MESSAGE = BACKGROUND_EXEC_DENIAL;
export const AGENT_READ_ONLY_REMOTE_TOOL_MODES = READ_ONLY_REMOTE_TOOL_MODES;
export const AGENT_READ_ONLY_CHANNEL_TOOL_MODES = READ_ONLY_CHANNEL_TOOL_MODES;
export const AGENT_READ_ONLY_MCP_TOOL_MODES = READ_ONLY_MCP_TOOL_MODES;
export const AGENT_READ_ONLY_FETCH_METHODS = READ_ONLY_FETCH_METHODS;
export const AGENT_READ_ONLY_STATE_TOOL_MODES = READ_ONLY_STATE_TOOL_MODES;
export const AGENT_READ_ONLY_STATE_MEMORY_ACTIONS = READ_ONLY_STATE_MEMORY_ACTIONS;
export const AGENT_READ_ONLY_STATE_HOOK_ACTIONS = READ_ONLY_STATE_HOOK_ACTIONS;
export const AGENT_READ_ONLY_STATE_MODE_ACTIONS = READ_ONLY_STATE_MODE_ACTIONS;
export const AGENT_READ_ONLY_STATE_ANALYTICS_ACTIONS = READ_ONLY_STATE_ANALYTICS_ACTIONS;
export const AGENT_READ_ONLY_TASK_TOOL_MODES = READ_ONLY_TASK_TOOL_MODES;
export const AGENT_READ_ONLY_TEAM_TOOL_MODES = READ_ONLY_TEAM_TOOL_MODES;
export const AGENT_READ_ONLY_WORKLIST_TOOL_MODES = READ_ONLY_WORKLIST_TOOL_MODES;
export const AGENT_READ_ONLY_PACKET_TOOL_MODES = READ_ONLY_PACKET_TOOL_MODES;
export const AGENT_READ_ONLY_QUERY_TOOL_MODES = READ_ONLY_QUERY_TOOL_MODES;
export const AGENT_READ_ONLY_CONTROL_TOOL_MODES = READ_ONLY_CONTROL_TOOL_MODES;
export const AGENT_REMOTE_MUTATION_DENIAL_MESSAGE = REMOTE_MUTATION_DENIAL;
export const AGENT_CHANNEL_ACTION_DENIAL_MESSAGE = CHANNEL_ACTION_DENIAL;
export const AGENT_MCP_SECURITY_MUTATION_DENIAL_MESSAGE = MCP_SECURITY_MUTATION_DENIAL;
export const AGENT_FETCH_NETWORK_MUTATION_DENIAL_MESSAGE = FETCH_NETWORK_MUTATION_DENIAL;
export const AGENT_STATE_MUTATION_DENIAL_MESSAGE = STATE_MUTATION_DENIAL;
export { wrapSettingsToolForAdmittedAgentPolicy };
export const AGENT_INSPECT_WRITE_DENIAL_MESSAGE = INSPECT_WRITE_DENIAL;
export const AGENT_DURABLE_WORKFLOW_MUTATION_DENIAL_MESSAGE = DURABLE_WORKFLOW_MUTATION_DENIAL;
export const AGENT_CONTROL_MUTATION_DENIAL_MESSAGE = CONTROL_MUTATION_DENIAL;

export {
  AGENT_CONTEXT_TOOL_COMPATIBILITY_MODES,
  wrapAgentContextToolForAgentPolicy,
} from './agent-context-policy.ts';

export { AGENT_READ_ADMISSION_DENIAL_MESSAGE, wrapReadToolForAgentPolicy } from './agent-read-policy.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}
