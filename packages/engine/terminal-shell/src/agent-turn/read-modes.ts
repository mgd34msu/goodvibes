/**
 * read-modes.ts, the one table of the Agent's mode policy, applied wherever an
 * Agent turn runs: the Agent's own process (its main and worker registries)
 * and a session the daemon hosts for the Agent.
 *
 * For each tool, the modes that only read. It is set on the tool's definition
 * as `readModes`, so the permission gate (the only place a call is decided)
 * classes a listed mode as a read and decides any other mode as a change:
 * asked of the owner, or decided by Jev, as the permission mode says. Nothing
 * here refuses a call. The same table answers the Agent's policy explanation,
 * so what the Agent says matches what runs.
 */
import type { Tool, ToolReadModes } from '@goodvibes/engine/platform/platform/types';
import type { ToolRegistry } from '@goodvibes/engine/platform/platform/tools';
import { wrapReadToolForAdmittedAgentPolicy, wrapSettingsToolForAdmittedAgentPolicy } from '@goodvibes/engine/platform/platform/gate/policy';

const AGENT_READ_MODES: Readonly<Record<string, ToolReadModes>> = Object.freeze({
  remote: { field: 'mode', values: ['pools', 'contracts', 'artifacts', 'review'] },
  // Resolving a target that would be created is a change, whatever the mode.
  channel: { field: 'mode', values: ['accounts', 'directory', 'resolve_target', 'capabilities', 'tools', 'agent_tools', 'actions'], unless: ['createIfMissing'] },
  mcp: { field: 'mode', values: ['servers', 'tools', 'schema', 'resources', 'security', 'auth'] },
  control: { field: 'mode', values: ['commands', 'panels', 'subscriptions'] },
  task: { field: 'mode', values: ['list', 'show', 'handoffs'] },
  // query is not listed: every mode (ask, show, list, withdraw) acts only on the owner's own inbox, so it keeps the
  // read category it has everywhere (types/tools.ts); a guest's turn is still asked by the gate (gate/classify.ts).
  // The facades over agent_harness: the actions that forward to a read mode of
  // the harness mode catalog (agent_harness declares its own from the catalog).
  models: { field: 'action', values: ['status', 'route', 'local', 'providers', 'provider'] },
  memory: { field: 'action', values: ['status', 'provider', 'refinement', 'curator', 'candidate', 'list', 'search', 'get', 'stale'] },
  settings: { field: 'action', values: ['list', 'get', 'preview_import'] },
  workspace: { field: 'action', values: ['status', 'actions', 'action', 'surfaces', 'surface', 'shortcuts', 'keybindings', 'keybinding', 'commands', 'command', 'cli_commands', 'cli_command'] },
  setup: { field: 'action', values: ['status', 'item', 'repair', 'checkpoint'] },
  personal_ops: { field: 'action', values: ['briefing', 'status', 'queue', 'intake', 'lane'] },
  research: { field: 'action', values: ['briefing', 'status', 'plan', 'runs', 'run', 'sources', 'source', 'reports', 'report_artifact'] },
  computer: { field: 'action', values: ['status', 'plan', 'control', 'browser', 'setup', 'mcp'] },
  device: { field: 'action', values: ['status', 'capability', 'browser', 'control', 'voice', 'provider'] },
});

/**
 * Facades over agent_harness whose every action reads: they declare no side
 * effects, and the gate classes their calls as reads.
 */
const AGENT_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'audit', 'autonomy', 'channels', 'context', 'delegation', 'execution', 'host', 'route', 'security', 'sessions', 'support',
]);

/** The read modes the Agent declares for a tool, when it declares any. */
export function agentReadModesFor(toolName: string): ToolReadModes | undefined {
  return AGENT_READ_MODES[toolName];
}

/**
 * Put the table's declarations on the registered definitions: a tool's read
 * modes, and the read category of a facade that only reads. Idempotent, so a
 * host that registers more tools later declares them by calling it again.
 */
export function declareAgentReadModes(registry: ToolRegistry): void {
  for (const tool of registry.list()) {
    const name = tool.definition.name;
    const readModes = AGENT_READ_MODES[name];
    if (readModes && tool.definition.readModes !== readModes) {
      tool.definition = { ...tool.definition, readModes };
    } else if (AGENT_READ_ONLY_TOOLS.has(name) && tool.definition.category === undefined
      && Array.isArray(tool.definition.sideEffects) && tool.definition.sideEffects.length === 0) {
      tool.definition = { ...tool.definition, category: 'read' };
    }
  }
}

/**
 * The admission policies an Agent registry builds the platform `read` and
 * `goodvibes_settings` tools with, in the Agent's own process (its main and
 * worker registries) and in a session the daemon hosts for the Agent. Each
 * registers that tool's input projector, which `installAgentToolPolicy`'s
 * wrappers then require of every call.
 */
export const AGENT_PLATFORM_TOOL_ADMISSION = Object.freeze({
  readAdmissionPolicy: 'agent-main-conversation',
  settingsAdmissionPolicy: 'agent-main-conversation',
} as const);

/**
 * The Agent's tool policy on one registry built with
 * `AGENT_PLATFORM_TOOL_ADMISSION`: the read-mode table, a `read` that runs
 * only under the admission recorded for its exact files, and a
 * `goodvibes_settings` that writes only what its input projector prepared and
 * the gate judged. `goodvibes_context` inspects and never changes anything,
 * so it is a read here. `wrapContext` is the Agent process's view of it over
 * `agent_harness`; a registry without the harness (a session the daemon
 * hosts) keeps the platform's context tool, declared as the read it is.
 */
export function installAgentToolPolicy(registry: ToolRegistry, wrapContext?: (tool: Tool, registry: ToolRegistry) => void): void {
  declareAgentReadModes(registry);
  for (const tool of registry.list()) {
    const name = tool.definition.name;
    if (AGENT_READ_MODES[name]) continue;
    if (name === 'read') wrapReadToolForAdmittedAgentPolicy(tool);
    else if (name === 'goodvibes_settings') wrapSettingsToolForAdmittedAgentPolicy(tool);
    else if (name === 'goodvibes_context') {
      if (wrapContext) wrapContext(tool, registry);
      else tool.definition = { ...tool.definition, sideEffects: [] };
    }
  }
}

/**
 * The decoration every worker the Agent spawns gets, in the Agent's own
 * process and in a session the daemon hosts for it: the Agent's tool policy
 * on the worker's registry, which is built with `AGENT_PLATFORM_TOOL_ADMISSION`
 * and the Agent's settings routing. A worker's tools are the platform tools,
 * as the Agent process gives its workers; definition compaction only shapes
 * what the main model sees, so it is left out. One pass over the registry
 * when it is built; nothing per call.
 */
export function decorateAgentWorkerRegistry(registry: ToolRegistry, wrapContext?: (tool: Tool, registry: ToolRegistry) => void): void {
  installAgentToolPolicy(registry, wrapContext);
}
