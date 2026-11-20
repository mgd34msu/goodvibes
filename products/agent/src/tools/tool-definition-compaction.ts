import type { ToolRegistry } from '@goodvibes/engine/platform/platform/tools';
import type { ToolDefinition } from '@goodvibes/engine/platform/platform/types';
import { captureCatalogData } from '@goodvibes/engine/terminal-shell/agent-turn/catalog-data';

const ownedDefinitions = new WeakSet<ToolDefinition>();

export function captureAgentToolDefinition(definition: ToolDefinition): ToolDefinition {
  const owned = captureCatalogData(definition);
  ownedDefinitions.add(owned);
  return owned;
}

/** A deferred tool's one-line entry: the first sentence of its own description, cut at this length. */
const SUMMARY_LIMIT = 120;

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
/** The top-level parameter that names the tool's operation (`action`, or `mode` where that is the operation). */
const OPERATION_PARAMETER_NAMES: ReadonlySet<string> = new Set(['action', 'mode']);
const OPERATION_DESCRIPTION_LIMIT = 160;

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
    // The operation parameter's description is where a tool says which operations exist and which ones change state.
    if (path.length === 2 && path[0] === 'properties' && OPERATION_PARAMETER_NAMES.has(path[1]!)) return OPERATION_DESCRIPTION_LIMIT;
    if (path.length === 2 && path[0] === 'properties' && DESTRUCTIVE_PARAMETER_NAMES.has(path[1]!)) return DESTRUCTIVE_PARAMETER_DESCRIPTION_LIMIT;
    return undefined;
  }) as ToolDefinition['parameters'];
}

function compactDescription(definition: ToolDefinition): string {
  if (definition.core === true) return compactSentences(definition.description, CORE_TOOL_DESCRIPTION_LIMIT);
  // One description per tool: a deferred tool's line is the first sentence of its own.
  const normalized = definition.description.replace(/\s+/g, ' ').trim();
  const first = normalized.match(/^[^.!?]+(?:[.!?]+(?=\s|$)|$)/)?.[0] ?? normalized;
  return compactText(first, SUMMARY_LIMIT);
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
