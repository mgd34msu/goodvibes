import type { Tool, ToolDefinition, ToolResult } from '../types/tools.js';

/** The tool that loads a full definition on demand. */
export const TOOL_SCHEMA_TOOL_NAME = 'tool_schema';

/** Marks a one-line entry, so the model knows to load the definition before the first call. */
const DEFERRED_MARK = '[parameters: tool_schema]';
/** A one-line entry's summary is cut to whole words at this length. */
const ONE_LINE_LIMIT = 120;

/** The first sentence of a description, cut to whole words at the one-line limit. */
export function oneLineSummary(description: string): string {
  const text = description.replace(/\s+/g, ' ').trim();
  const sentence = /^[^.!?]*[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
  if (sentence.length <= ONE_LINE_LIMIT) return sentence;
  const cut = sentence.slice(0, ONE_LINE_LIMIT - 3);
  const space = cut.lastIndexOf(' ');
  return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}...`;
}

// One one-line entry per definition object, so every request of a session
// sends byte-identical entries (the provider's prompt cache holds) and the
// summary is computed once.
const oneLineEntries = new WeakMap<ToolDefinition, ToolDefinition>();

/**
 * A tool as a one-line entry in a model request: its name, a one-line summary
 * and open parameters. The registry still validates every call against the
 * full schema, and `tool_schema` returns that schema.
 */
export function oneLineDefinition(definition: ToolDefinition): ToolDefinition {
  const known = oneLineEntries.get(definition);
  if (known) return known;
  const entry: ToolDefinition = Object.freeze({
    name: definition.name,
    description: `${oneLineSummary(definition.description)} ${DEFERRED_MARK}`,
    parameters: { type: 'object', additionalProperties: true },
  });
  oneLineEntries.set(definition, entry);
  return entry;
}

/** The model-facing view of a full definition. */
function fullView(definition: ToolDefinition): { name: string; description: string; parameters: Record<string, unknown> } {
  return { name: definition.name, description: definition.description, parameters: definition.parameters };
}

/**
 * The answer to a call of a tool that was listed in one line and not loaded,
 * whose arguments do not fit its parameters: nothing ran; the result carries
 * the tool's full definition, what did not fit (`misfit`, when known) and says
 * to send the call again with those parameters. The tool goes in full from the
 * next request on. It is held to load, not refused (`heldToLoad`): the retry
 * runs, whatever it carries.
 */
export function deferredToolRefusal(callId: string, definition: ToolDefinition, misfit?: string): ToolResult {
  const reason = `${definition.name} was listed in one line and its parameters had not been loaded, so the call was not run${misfit ? `: ${misfit}` : ''}.`;
  const next = `Send the ${definition.name} call again with the parameters in this result; ${definition.name} is sent in full from now on.`;
  return {
    callId,
    success: false,
    heldToLoad: true,
    error: `${reason} ${next}`,
    output: JSON.stringify({ tools: [fullView(definition)] }),
    decision: { state: 'refused', decidedBy: 'code', reason, next: [next] },
  };
}

/** What `tool_schema` reads and records. */
export interface ToolSchemaSource {
  definitionOf(name: string): ToolDefinition | undefined;
  /** The uncompacted form of a definition when a product shortened it. */
  fullDefinition(name: string): ToolDefinition | undefined;
  /** The tools whose full definitions were returned: requests carry them in full from now on. */
  loaded(names: readonly string[]): void;
}

/**
 * `tool_schema`: the full definitions (description and parameters) of the
 * tools a request lists in one line, which are sent in full from the next
 * request on. A lookup in the registry, no model request and no file access,
 * so the gate allows it as a read by code.
 */
export function createToolSchemaTool(source: ToolSchemaSource): Tool {
  return {
    definition: {
      name: TOOL_SCHEMA_TOOL_NAME,
      description: `Returns the full definition (description and parameters) of tools listed with ${DEFERRED_MARK}, and makes them callable with those parameters from the next step on. Call it before the first use of such a tool; name several in one call.`,
      parameters: {
        type: 'object',
        properties: {
          names: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Tool names, exactly as listed.' },
        },
        required: ['names'],
        additionalProperties: false,
      },
      category: 'read',
      sideEffects: [],
      subjects: { paths: [] },
      concurrency: 'parallel',
    },
    async execute(args) {
      const names = Array.isArray(args.names) ? args.names.filter((name): name is string => typeof name === 'string') : [];
      if (names.length === 0) return { success: false, error: 'names must list at least one tool name, for example { "names": ["inspect"] }.' };
      const tools: ReturnType<typeof fullView>[] = [];
      const unknown: string[] = [];
      for (const name of [...new Set(names)]) {
        const definition = source.fullDefinition(name) ?? source.definitionOf(name);
        if (!definition || name === TOOL_SCHEMA_TOOL_NAME) { unknown.push(name); continue; }
        tools.push(fullView(definition));
      }
      source.loaded(tools.map((tool) => tool.name));
      return {
        success: tools.length > 0,
        output: JSON.stringify({ tools, ...(unknown.length > 0 ? { unknown, note: 'No tool of these names is registered here.' } : {}) }),
        ...(tools.length === 0 ? { error: `No tool named ${unknown.join(', ')} is registered here.` } : {}),
      };
    },
  };
}
