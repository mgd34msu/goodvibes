import type { JevDecision } from '@goodvibes-jev/judgment/decisions';
import type { DecisionModelPolicyState } from '@goodvibes-jev/engine/errors';

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
 */
export interface ToolReadModes {
  readonly field: string;
  readonly values: readonly string[];
  readonly defaultValue?: string | undefined;
  readonly unless?: readonly ToolArgumentPath[] | undefined;
}

/** The category a call of a tool with {@link ToolReadModes} is classed under. */
export function readModeCategory(readModes: ToolReadModes, args: Record<string, unknown>, own: PermissionCategory): PermissionCategory {
  const raw = args[readModes.field];
  const value = raw === undefined ? readModes.defaultValue : raw;
  const present = (path: string): boolean => {
    const found = args[path];
    return found !== undefined && found !== null && found !== false && !(typeof found === 'string' && found.length === 0);
  };
  const reads = typeof value === 'string' && readModes.values.includes(value) && !(readModes.unless ?? []).some(present);
  return reads ? 'read' : own === 'read' ? 'write' : own;
}

/** A tool whose changes are recorded where the owner can undo them, except when a listed argument is present. */
export interface ToolRecoverability {
  readonly unless?: readonly ToolArgumentPath[] | undefined;
}

/** The category a tool's calls are classed under: its declared one, else an engine tool's entry; undefined when neither. */
export function toolCategoryOf(definition: Pick<ToolDefinition, 'name' | 'category'>): PermissionCategory | undefined {
  return definition.category ?? (Object.hasOwn(ENGINE_TOOL_CATEGORIES, definition.name) ? ENGINE_TOOL_CATEGORIES[definition.name] : undefined);
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
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
 * Structured denial detail for a tool call the permission layer blocked.
 *
 * Rides on the failed ToolResult so the ASKING agent receives machine-readable
 * denial data scoped to that exact call, never a hung promise and never a bare
 * throw, and can continue and report honestly instead of parsing an error
 * string. `reason` is the permission layer's reason code (see
 * PermissionDecisionReasonCode, e.g. 'user_denied' / 'config_deny') and `scope`
 * is the layer that produced the decision (see PermissionDecisionSource, e.g.
 * 'user_prompt' / 'config_policy'); both are kept as plain strings so this
 * low-level type stays free of a permissions/ import.
 */
export interface ToolDenial {
  readonly denied: true;
  readonly reason: string;
  readonly scope: string;
  /** True when every later call like this one is refused too for the rest of the session. */
  readonly standing?: boolean | undefined;
  /** Optional user free-text (e.g. why a call was declined) for the model to adapt to. */
  readonly detail?: string | undefined;
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
  readonly autonomousDecision?: JevDecision | undefined;
  callId: string;
  success: boolean;
  output?: string | undefined;
  error?: string | undefined;
  /** Non-failing issues the caller should surface with the result. */
  warnings?: readonly string[] | undefined;
  /**
   * The gate's decision: on every refused call, and on an allowed one when Jev
   * or the owner decided it. See {@link ToolDecision}.
   */
  decision?: ToolDecision | undefined;
  /**
   * Present only when the call was refused by the permission layer.
   * @deprecated Read {@link ToolResult.decision}; this older shape lacks who decided and what to do next.
   */
  denial?: ToolDenial | undefined;
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
  /** Tools return a result without callId, the registry injects callId when wrapping. */
  execute(args: Record<string, unknown>, opts?: ToolExecuteOptions): Promise<Omit<ToolResult, 'callId'>>;
}
