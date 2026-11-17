import type { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { ToolDefinition } from '@goodvibes-jev/engine/platform/platform/types';
import { captureCatalogData } from './agent-harness-catalog-ranking.ts';

const ownedDefinitions = new WeakSet<ToolDefinition>();

export function captureAgentToolDefinition(definition: ToolDefinition): ToolDefinition {
  const owned = captureCatalogData(definition);
  ownedDefinitions.add(owned);
  return owned;
}

const DEFAULT_TOOL_DESCRIPTION_LIMIT = 56;

// Summaries for tools that are not core (a core tool keeps its own
// description). A tool with read modes (agent-tool-policy-guard.ts) is summarised
// by what it mostly does; its other modes are decided by the permission gate.
const TOOL_DESCRIPTION_OVERRIDES: Readonly<Record<string, string>> = {
  audit: 'Inspect release readiness and evidence.',
  analyze: 'Analyze code impact, symbols, and project risk.',
  autonomy: 'Route ongoing work and inspect visible autonomy.',
  channel: 'Inspect channel accounts, directories, and actions.',
  browser: 'Open, read, and act on real web pages.',
  channels: 'Inspect channel readiness, setup, triage, and receipts.',
  computer: 'Inspect/open browser, desktop, and computer routes.',
  context: 'Inspect project instructions and prompt context.',
  delegation: 'Inspect build delegation routes and policy.',
  context_accounting: 'Report live session context: usage and compaction.',
  contract_self_check: 'Read your unit\'s criteria as the last check read them.',
  control: 'Inspect commands, panels, and runtime posture.',
  device: 'Inspect/open device, voice, and browser routes.',
  execution: 'Inspect local work routes, history, and recovery.',
  goodvibes_context: 'Inspect current GoodVibes runtime and host harness.',
  google: 'Read/send Gmail; read/write Google Calendar.',
  goodvibes_settings: 'Set or reset one GoodVibes setting on request.',
  host: 'Inspect GoodVibes host status, services, and methods.',
  import_goodvibes_settings: 'Preview/apply shared GoodVibes settings import.',
  inspect: 'Inspect project structure, APIs, routes, and deps.',
  mcp: 'Inspect MCP servers, tools, schemas, and trust state.',
  memory: 'Inspect memory posture, providers, curator, records.',
  models: 'Inspect model routes, providers, cookbook, and checks.',
  personal_ops: 'Brief, route, inspect, and read Personal Ops.',
  profile: 'Read/record what GoodVibes knows about the owner.',
  query: 'Leave the owner a question; read the answer later.',
  research: 'Plan, track, source, and save research.',
  registry: 'Discover local skills, agents, tools, and templates.',
  remote: 'Inspect remote runner pools and artifacts.',
  repo_map: 'Return a token-budgeted map of the repository.',
  route: 'Choose the best visible route for a user task.',
  schedule: 'List, create, edit, run, pause, resume schedules.',
  security: 'Read security posture, findings, and policy decisions.',
  sessions: 'Search and inspect saved sessions/bookmarks.',
  settings: 'List, inspect, change, reset, or import settings.',
  setup: 'Inspect and complete first-run Agent setup.',
  support: 'Inspect support bundle routes and redacted bundles.',
  terminal: 'Start visible tracked background shell commands.',
  vibe: 'Inspect/create/import VIBE.md personality.',
  workspace: 'Inspect or run workspace actions, commands, keys.',
  workflow: 'Inspect/control configured workflow automation.',
  work_plan: 'Keep the project work plan: items, status, owners.',
  process: 'List, poll, log, wait, stop tracked processes.',
  agent_harness: 'Harness catalog: modes, settings, commands, UI, tools.',
  agent_artifacts: 'Browse, preview, export, package, and archive artifacts.',
  agent_documents: 'Draft, comment, suggest, attach artifacts, and export.',
  agent_knowledge: 'Read isolated Agent Knowledge.',
  agent_knowledge_ingest: 'Ingest an admitted source into Agent Knowledge.',
  agent_learning_consolidation: 'Apply admitted local duplicate learning phases.',
  agent_local_registry: 'Inspect/update Agent memory, notes, skills, routines.',
  agent_work_plan: 'Inspect/update the visible Agent-local work plan.',
  agent_operator_briefing: 'Read connected Agent operator state.',
  agent_operator_action: 'Run one admitted allowlisted operator action.',
  agent_autonomy_schedule: 'Schedule one admitted autonomous Agent task.',
  agent_schedule_edit: 'Edit one admitted connected schedule.',
  agent_research_runs: 'Track visible local research run checkpoints.',
  agent_research_sources: 'Manage local research source review queue.',
  agent_research_report: 'Save one admitted sourced research report artifact.',
  agent_reminder_schedule: 'Schedule one admitted Agent reminder.',
  agent_channel_send: 'Send an admitted message to a configured Agent target.',
  agent_notify: 'Send one admitted plain-text notification.',
  agent_media_generate: 'Generate one admitted image or video artifact.',
  agent_review_packet_presets: 'Save/list/refresh Document Ops packet presets.',
  agent_review_packet_share: 'Share an admitted review packet archive reference.',
  agent_model_compare_candidate: 'Run one metered blind-comparison candidate.',
  agent_operator_method: 'Invoke one admitted GoodVibes operator method.',
  agent_model_compare: 'Blind-compare prompts/artifacts; review, hand off, diff.',
};

function compactText(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) return normalized;
  if (limit <= 3) return normalized.slice(0, limit);
  return `${normalized.slice(0, limit - 3).trimEnd()}...`;
}

/** Whole sentences up to `limit` characters, so a kept description never stops mid-thought. */
function compactSentences(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) return normalized;
  const sentences = normalized.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) ?? [normalized];
  let kept = '';
  for (const sentence of sentences) {
    const next = `${kept}${kept ? ' ' : ''}${sentence.trim()}`;
    if (next.length > limit) break;
    kept = next;
  }
  return kept.length > 0 ? kept : compactText(normalized, limit);
}

/**
 * Core tools (`core: true` on the definition: the ones a model reaches for on
 * nearly every task) keep their full description and every parameter
 * description (each cut to whole sentences), because a wrong first call on
 * these costs a turn each time. Every other tool goes to the model as a
 * one-line entry (its short summary); its full, uncompacted definition is
 * returned by `tool_schema` and by `agent_harness mode:"tool"` (see
 * {@link fullToolDefinition}), so nothing is lost, only deferred.
 */
const CORE_TOOL_DESCRIPTION_LIMIT = 240;
// Long enough to keep exec's background-process protocol (bg_list, bg_status,
// bg_output, bg_stop), which sits in the second sentence of two parameters.
const CORE_PARAMETER_DESCRIPTION_LIMIT = 240;
const DESTRUCTIVE_PARAMETER_DESCRIPTION_LIMIT = 120;
/**
 * Parameters whose meaning is a side effect or a limit (what gets overwritten,
 * killed or run on the owner's say-so). They keep a short description even on
 * a deferred-detail tool, because a bare name does not say what it does.
 */
const DESTRUCTIVE_PARAMETER_NAMES: ReadonlySet<string> = new Set([
  'force', 'killOnTimeout', 'processClass',
]);
const MODE_DESCRIPTION_LIMIT = 160;

/** What each compacted tool looked like before, and the compacted form that replaced it, per registry. */
const fullDefinitions = new WeakMap<ToolRegistry, Map<string, { readonly full: ToolDefinition; readonly compactedJson: string }>>();

/** The uncompacted definition of a tool registered in `registry`, when compaction shortened it. */
export function fullToolDefinition(registry: ToolRegistry, name: string): ToolDefinition | undefined {
  return fullDefinitions.get(registry)?.get(name)?.full;
}

/** A second pass sees the compacted form; it must not be recorded as the full one. */
function rememberFullDefinition(registry: ToolRegistry, definition: ToolDefinition, compacted: ToolDefinition): void {
  let known = fullDefinitions.get(registry);
  if (!known) { known = new Map(); fullDefinitions.set(registry, known); }
  if (known.get(definition.name)?.compactedJson === JSON.stringify(definition)) return;
  known.set(definition.name, {
    full: JSON.parse(JSON.stringify(definition)) as ToolDefinition,
    compactedJson: JSON.stringify(compacted),
  });
}

/**
 * Walk a schema, rewriting every string `description`. `limitFor` decides, per
 * description path, whether it is dropped (undefined) or cut to a limit. Only
 * string values are touched: a parameter that is itself NAMED "description" is
 * an object under `properties` and must survive.
 */
function mapSchemaDescriptions(value: unknown, path: readonly string[], limitFor: (path: readonly string[]) => number | undefined): unknown {
  if (Array.isArray(value)) return value.map((entry) => mapSchemaDescriptions(entry, path, limitFor));
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'description' && typeof entry === 'string') {
      const limit = limitFor(path);
      if (limit !== undefined) result[key] = compactSentences(entry, limit);
      continue;
    }
    result[key] = mapSchemaDescriptions(entry, [...path, key], limitFor);
  }
  return result;
}

function compactParameters(definition: ToolDefinition): ToolDefinition['parameters'] {
  const core = definition.core === true;
  const parameters = definition.parameters;
  return mapSchemaDescriptions(parameters, [], (path) => {
    if (core) return CORE_PARAMETER_DESCRIPTION_LIMIT;
    // The top-level `mode` description is where a tool says which modes exist here.
    if (path.length === 2 && path[0] === 'properties' && path[1] === 'mode') return MODE_DESCRIPTION_LIMIT;
    if (path.length === 2 && path[0] === 'properties' && DESTRUCTIVE_PARAMETER_NAMES.has(path[1]!)) return DESTRUCTIVE_PARAMETER_DESCRIPTION_LIMIT;
    return undefined;
  }) as ToolDefinition['parameters'];
}

function compactDescription(definition: ToolDefinition): string {
  if (definition.core === true) return compactSentences(definition.description, CORE_TOOL_DESCRIPTION_LIMIT);
  return compactText(TOOL_DESCRIPTION_OVERRIDES[definition.name] ?? definition.description, DEFAULT_TOOL_DESCRIPTION_LIMIT);
}

export function compactRegisteredToolDefinitions(toolRegistry: ToolRegistry): void {
  for (const tool of toolRegistry.list()) {
    const definition = tool.definition;
    if (!ownedDefinitions.has(definition)) {
      const compacted = { ...definition, description: compactDescription(definition), parameters: compactParameters(definition) };
      rememberFullDefinition(toolRegistry, definition, compacted);
      tool.definition = compacted;
      continue;
    }
    const descriptors = Object.getOwnPropertyDescriptors(definition);
    descriptors.description = { ...descriptors.description, value: compactDescription(definition) };
    descriptors.parameters = { ...descriptors.parameters, value: compactParameters(definition) };
    const compacted: ToolDefinition = Object.create(null, descriptors);
    rememberFullDefinition(toolRegistry, definition, compacted);
    tool.definition = captureAgentToolDefinition(compacted);
  }
  toolRegistry.setFullDefinitionSource((name) => fullToolDefinition(toolRegistry, name));
}
