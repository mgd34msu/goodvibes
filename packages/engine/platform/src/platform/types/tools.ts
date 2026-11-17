import type { DecisionModelPolicyState } from '@goodvibes-jev/engine/errors';
import type { ToolActivity } from '@goodvibes-jev/engine/contracts';

/** Represents a tool the LLM can invoke. Parameters follow JSON Schema. */
export type ToolSideEffect =
  | 'read_fs'
  | 'write_fs'
  | 'network'
  | 'exec'
  | 'agent'
  | 'workflow'
  | 'state';

export type ToolConcurrencyMode = 'serial' | 'parallel' | 'singleton';

/** What a call does, as the gate classes it. */
export const PERMISSION_CATEGORIES = ['read', 'write', 'execute', 'delegate'] as const;
export type PermissionCategory = (typeof PERMISSION_CATEGORIES)[number];

/**
 * The category of each engine tool, stated once. Each engine tool's definition
 * carries its entry as `category`; the gate reads the definition, and this
 * table only for a check made by name without one.
 */
export const ENGINE_TOOL_CATEGORIES: Readonly<Record<string, PermissionCategory>> = Object.freeze({
  read: 'read', find: 'read', fetch: 'read', analyze: 'read', inspect: 'read', state: 'read', registry: 'read',
  goodvibes_context: 'read', repo_map: 'read', context_accounting: 'read',
  write: 'write', edit: 'write', goodvibes_settings: 'write',
  exec: 'execute',
  agent: 'delegate', delegate: 'delegate', workflow: 'delegate', mcp: 'delegate',
});

/**
 * Where a value sits in a call's arguments: keys joined by dots, `[]` for
 * every entry of a list. `files[].path` is the `path` of each entry of `files`.
 */
export type ToolArgumentPath = string;

/**
 * Where one call's subjects sit in its arguments, declared by the tool that
 * knows them. A declared list is complete: the gate reads the call's paths,
 * commands, hosts and recipients from it without guessing argument names.
 * Data, not code, so a registered definition stays plain JSON.
 */
export interface ToolSubjectDeclaration {
  readonly paths?: readonly ToolArgumentPath[] | undefined;
  readonly commands?: readonly ToolArgumentPath[] | undefined;
  readonly hosts?: readonly ToolArgumentPath[] | undefined;
  readonly recipients?: readonly ToolArgumentPath[] | undefined;
}

/**
 * The values of one argument (usually `mode`) with which a call only reads.
 * A call naming one of `values`, or omitting the argument when `defaultValue`
 * is one of them, and carrying none of `unless`, is classed 'read'; any other
 * call is classed as a change (the tool's own category, or 'write' when that
 * is 'read'), so the gate decides it like any change.
 *
 * `field` is an argument path: `urls[].method` reads the `method` of every
 * entry of `urls`, and the call reads only when every entry does (an entry
 * without one takes `defaultValue`; a missing or empty list is a change).
 */
export interface ToolReadModes {
  readonly field: ToolArgumentPath;
  readonly values: readonly string[];
  readonly defaultValue?: string | undefined;
  readonly unless?: readonly ToolArgumentPath[] | undefined;
}

/** The values a call gives a read-mode field, `defaultValue` where it gives none; undefined when the call cannot be read by it. */
function readModeValues(args: Record<string, unknown>, field: ToolArgumentPath, defaultValue: string | undefined): unknown[] | undefined {
  let level: unknown[] = [args];
  for (const segment of field.split('.')) {
    const each = segment.endsWith('[]');
    const key = each ? segment.slice(0, -2) : segment;
    const next: unknown[] = [];
    for (const value of level) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
      const child = Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
      if (!each) { next.push(child); continue; }
      if (!Array.isArray(child) || child.length === 0) return undefined;
      next.push(...child);
    }
    level = next;
  }
  return level.map((value) => value === undefined ? defaultValue : value);
}

/** The category a call of a tool with {@link ToolReadModes} is classed under. */
export function readModeCategory(readModes: ToolReadModes, args: Record<string, unknown>, own: PermissionCategory): PermissionCategory {
  const values = readModeValues(args, readModes.field, readModes.defaultValue);
  const present = (path: string): boolean => {
    const found = args[path];
    return found !== undefined && found !== null && found !== false && !(typeof found === 'string' && found.length === 0);
  };
  const reads = values !== undefined && values.every((value) => typeof value === 'string' && readModes.values.includes(value))
    && !(readModes.unless ?? []).some(present);
  return reads ? 'read' : own === 'read' ? 'write' : own;
}

/**
 * The argument values that make a call an act only the owner performs himself
 * (gate/classify.ts `owner-act`): a model's call carrying one is refused in
 * every mode. `values` are read from the published declaration of what is
 * named (the operator catalog's `ownerOnly`), not written by hand.
 */
export interface ToolOwnerActs {
  readonly field: ToolArgumentPath;
  readonly values: readonly string[];
}

/** A tool whose changes are recorded where the owner can undo them, except when a listed argument is present. */
export interface ToolRecoverability {
  readonly unless?: readonly ToolArgumentPath[] | undefined;
}

/** A capability a tool can state on its definition: `browser-control` drives a real browser; `desktop-control` drives the desktop outside one. */
export type ToolCapability = 'browser-control' | 'desktop-control';

/** The category a tool's calls are classed under: its declared one, else an engine tool's entry; undefined when neither. */
export function toolCategoryOf(definition: Pick<ToolDefinition, 'name' | 'category'>): PermissionCategory | undefined {
  return definition.category ?? (Object.hasOwn(ENGINE_TOOL_CATEGORIES, definition.name) ? ENGINE_TOOL_CATEGORIES[definition.name] : undefined);
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /**
   * The words every surface shows a call of this tool by ("Reading a file",
   * "read 2 files"). Never sent to the model. Absent: "Using <name>".
   */
  activity?: ToolActivity | undefined;
  /**
   * Side effects the tool may perform when executed successfully. Absent means
   * undeclared (an MCP or plugin tool): the gate never decides such a call from
   * its effects alone.
   */
  sideEffects?: readonly ToolSideEffect[] | undefined;
  /**
   * The tool's permission category: what the gate and the contract verifier
   * class its calls by (toolCategoryOf). An engine tool's comes from
   * ENGINE_TOOL_CATEGORIES; a tool that declares none is treated as 'delegate'.
   */
  category?: PermissionCategory | undefined;
  /** Where the paths, commands, hosts and recipients of a call sit in its arguments. Absent: undeclared. */
  subjects?: ToolSubjectDeclaration | undefined;
  /**
   * Present when every change a call makes is recorded where the owner can undo
   * it (the file-undo history), except a call carrying one of `unless`. Absent:
   * the change is not known to be recoverable.
   */
  recoverable?: ToolRecoverability | undefined;
  /** The argument values with which a call only reads; see {@link ToolReadModes}. */
  readModes?: ToolReadModes | undefined;
  /**
   * A tool the model reaches for on nearly every task: every model request
   * carries its full definition. Any other tool goes as a one-line entry whose
   * full definition `tool_schema` loads on demand (ToolRegistry.getModelToolDefinitions).
   */
  core?: boolean | undefined;
  /**
   * What the tool states it can do. Readiness surfaces read this from the
   * registry; nothing is inferred from names or descriptions. Never sent to the model.
   */
  capabilities?: readonly ToolCapability[] | undefined;
  /** Whether multiple calls can safely run in parallel. */
  concurrency?: ToolConcurrencyMode | undefined;
  /** Whether the tool can emit meaningful progress before final completion. */
  supportsProgress?: boolean | undefined;
  /** Whether results may be streamed or delivered incrementally. */
  supportsStreamingOutput?: boolean | undefined;
  /**
   * The tool changes who can reach the agent or acts on an outside system. Its calls are the
   * owner's to decide (gate/classify.ts, `grant-access`): the owner is asked once, and the answer
   * is remembered when he chooses; only yolo runs it unasked.
   */
  dangerous?: boolean | undefined;
  /** Calls of this tool that only the owner makes himself; see {@link ToolOwnerActs}. */
  ownerActs?: ToolOwnerActs | undefined;
  /**
   * Top-level argument names the host writes into a call after the model made
   * it (left out of the schema the model sees). They are the host's own, so a
   * call carrying them is never told they are unknown parameters. Never sent to
   * the model.
   */
  hostArguments?: readonly string[] | undefined;
}

/** What happened to a call at the gate. */
export type ToolDecisionState = 'allowed' | 'allowed-by-jev' | 'refused' | 'queued-for-owner' | 'skipped';

/** Who settled it: a fact in code, a standing rule, a limit, Jev, the owner, or the mode. */
export type ToolDecisionMaker = 'code' | 'rule' | 'limit' | 'jev' | 'owner' | 'mode';

/**
 * The gate's decision on one call, carried on its result so the asking agent
 * learns what happened, why, and what it can do next without another call.
 * The tool-side spelling of the refusal shape every surface uses.
 */
export interface ToolDecision {
  readonly state: ToolDecisionState;
  readonly decidedBy: ToolDecisionMaker;
  /** Why, in words the agent can act on. */
  readonly reason: string;
  /** The standing limit or rule that decided, when one did. */
  readonly limit?: string | undefined;
  /** What the agent can do instead, most useful first. */
  readonly next?: readonly string[] | undefined;
  /** On a refusal: true when every later call like this one is refused too for the rest of the session. */
  readonly standing?: boolean | undefined;
  /** The decision log row, when Jev decided. */
  readonly decisionId?: string | undefined;
  /** On `queued-for-owner`: the id the owner approves the held call by (`/held approve <id>`). */
  readonly heldId?: string | undefined;
}

/** A tool invocation requested by the LLM. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /**
   * The provider could not read this call's arguments (the text said why). The call carries empty
   * arguments and is answered with this error instead of running.
   */
  argumentError?: string | undefined;
}

/**
 * Facts a tool reports to the host that the model must not see. Hosts (evidence
 * collection, receipts) read them here; conversation rendering never includes them.
 */
export interface ToolHostEvidence {
  /**
   * One entry per file of a `read` result, aligned to that result's `files` array by `index`:
   * the observation (which lines were actually returned) and the resolved absolute path.
   */
  readonly reads?: readonly {
    readonly index: number;
    readonly path: string;
    readonly resolvedPath?: string | undefined;
    readonly readObservation?: Readonly<Record<string, unknown>> | undefined;
  }[] | undefined;
  /** A failed `edit` call's outcome as the matcher that refused it decided it. */
  readonly editStatus?: 'not_found' | 'ambiguous' | 'conflict' | 'failed' | undefined;
}

/** The outcome of executing a tool. */
export interface ToolResult {
  /** Host execution policy, never a decision-model receipt or semantic completion claim. */
  decisionPolicy?: DecisionModelPolicyState;
  callId: string;
  success: boolean;
  output?: string | undefined;
  error?: string | undefined;
  /** Non-failing issues the caller should surface with the result. */
  warnings?: readonly string[] | undefined;
  /**
   * The gate's decision: on every refused call, and on an allowed one when Jev
   * or the owner decided it (with Jev's decision log id). See {@link ToolDecision}.
   */
  decision?: ToolDecision | undefined;
  /**
   * True when this specific call was cancelled by the user mid-flight (per-call
   * cooperative cancellation, NOT a whole-turn abort). The turn continues:
   * the model sees this structured result and adapts. `error` carries the
   * human-readable "cancelled by user"; partial `output` is preserved when the
   * tool produced any before stopping.
   */
  cancelled?: boolean | undefined;
  /** Host-only facts about this result; never rendered to the model. See {@link ToolHostEvidence}. */
  hostEvidence?: ToolHostEvidence | undefined;
  /**
   * Pictures for the model, beside the text (an image file read, a phone
   * capture). Every conversation loop attaches them to its next request when
   * its model accepts images, and tells the model they were not shown when it
   * does not (core/tool-result-images.ts).
   */
  images?: readonly ToolResultImage[] | undefined;
}

/** One picture a tool result hands the model. */
export interface ToolResultImage {
  /** Where it came from: a file path, or a source label such as `phone:<artifact id>`. */
  readonly path: string;
  readonly base64: string;
  readonly mediaType: string;
  readonly description: string;
}

/**
 * Optional per-call execution options.
 *
 * `signal` is ADDITIVE: it was not present before, and every
 * existing tool implementation that declares `execute(args)` with a single
 * parameter remains a valid implementation of this interface (structural
 * typing, an unused trailing optional parameter is simply never read). Only
 * tools that opt in (exec, fetch) read it to propagate cooperative
 * cancellation into a spawned child process or an in-flight request.
 */
export interface ToolExecuteOptions {
  /** Additive original-caller restriction, never a permission grant. The registry
   * also supplies the actual effective arguments at the execution boundary. */
  readonly assertCurrent?: ((effectiveArgs?: Record<string, unknown>) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Registry-issued opaque projection capability; the creating owner must validate identity. */
  readonly inputProjectionContext?: object | undefined;
  /**
   * A tool that is still working calls this when it makes progress (output arrived, a step finished), with an
   * optional short note. Hosts count it as liveness, so a long call that keeps reporting is not mistaken for a
   * silent one. Additive and optional; a tool that never calls it behaves as before.
   */
  readonly onProgress?: ((note?: string) => void) | undefined;
}

/** A registered tool with its definition and executor. */
export interface Tool {
  definition: ToolDefinition;
  /**
   * Whether this call only reads, from facts the tool already holds (no I/O,
   * no request): a call that does runs beside the other reads of its response
   * (core/tool-batch.ts). For a fact that lives outside the definition, such
   * as an MCP server marking one of its tools read-only. Never a permission
   * grant; the gate decides every call as before. Absent or throwing: the
   * call is laned by its definition alone.
   */
  callReadsOnly?: ((args: Record<string, unknown>) => boolean) | undefined;
  /** Tools return a result without callId, the registry injects callId when wrapping. */
  execute(args: Record<string, unknown>, opts?: ToolExecuteOptions): Promise<Omit<ToolResult, 'callId'>>;
}
