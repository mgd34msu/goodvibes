/** The 5 lifecycle phases */
export type HookPhase = 'Pre' | 'Post' | 'Fail' | 'Change' | 'Lifecycle';

/** Hook event categories */
export type HookCategory =
  | 'tool' | 'file' | 'git' | 'agent' | 'compact'
  | 'llm' | 'mcp' | 'config' | 'budget' | 'session' | 'contract'
  | 'permission' | 'transport' | 'communication' | 'webhook';

/** A fully qualified hook event path: Phase:Category:Specific */
export type HookEventPath = `${HookPhase}:${HookCategory}:${string}`;

/** A Phase:Category:Specific pattern; any segment may be the wildcard `*`. */
export type HookPattern = `${HookPhase | '*'}:${HookCategory | '*'}:${string}`;

/** Event payload passed to hooks */
export interface HookEvent {
  path: HookEventPath;
  phase: HookPhase;
  category: HookCategory;
  specific: string;
  sessionId: string;
  timestamp: number;
  payload: Record<string, unknown>;
  /** For agent-scoped events */
  agentId?: string | undefined;
}

/** Result returned by a hook handler */
export interface HookResult {
  /** For a Pre hook that may deny: `deny` refuses the call or request; `allow` and `ask` have no effect on a tool call. */
  decision?: 'allow' | 'deny' | 'ask' | undefined;
  /** Reason for denial */
  reason?: string | undefined;
  /** Modified input (Pre hooks can modify tool input) */
  updatedInput?: Record<string, unknown> | undefined;
  /** Context to inject into the LLM conversation */
  additionalContext?: string | undefined;
  /** Whether the hook ran successfully */
  ok: boolean;
  /** Error message if hook failed */
  error?: string | undefined;
  /** Machine-readable failure reason, when the runner can identify one. */
  code?: 'OWNED_PROCESS_GROUP_UNSUPPORTED' | 'OWNED_AGENT_EXECUTION_UNSUPPORTED' | undefined;
}

/** The 5 hook types */
export type HookType = 'command' | 'prompt' | 'agent' | 'http' | 'ts';

/** Hook definition in hooks.json */
export interface HookDefinition {
  /**
   * A hook fires on the key it is listed under in hooks.json. `match` is
   * optional there and, when present, must equal that key. A chain's action
   * uses it as the event path the action reports.
   */
  match?: string | undefined;
  /** Further filter within the match (e.g., specific tool name) */
  matcher?: string | undefined;
  /** Hook type */
  type: HookType;
  /** For command hooks: the shell command to run. It receives the event JSON on stdin and may print a result JSON on stdout (the fields a hook returns); a non-zero exit is a failure, and output that is not JSON counts as success with no result. */
  command?: string | undefined;
  /** For prompt/agent hooks: the prompt text. $ARGUMENTS replaced with event JSON. */
  prompt?: string | undefined;
  /** For http hooks: URL to POST to */
  url?: string | undefined;
  /** For ts hooks: path to TypeScript file */
  path?: string | undefined;
  /** For http hooks: custom headers */
  headers?: Record<string, string> | undefined;
  /** For prompt/agent hooks: LLM model to use */
  model?: string | undefined;
  /**
   * Timeout in seconds (default: 30 for command/prompt/http/ts, 60 for agent).
   * At the deadline the hook is asked to stop; one that has not stopped 2 s later
   * is left running and reported as failed, and the turn goes on. 0 means no
   * deadline and is accepted only for an `async` hook.
   */
  timeout?: number | undefined;
  /** Custom status message shown while hook runs */
  statusMessage?: string | undefined;
  /** Run in the background: the turn neither waits for it nor cancels it; its own deadline still applies. */
  async?: boolean | undefined;
  /** Run once then auto-remove */
  once?: boolean | undefined;
  /** Description for documentation */
  description?: string | undefined;
  /** Optional name for programmatic enable/disable/remove */
  name?: string | undefined;
  /** Whether the hook is enabled (default: true) */
  enabled?: boolean | undefined;
  /**
   * For http hooks: when true, bypasses the SSRF tier filter and
   * allows requests to internal/private hosts. Use only in trusted,
   * air-gapped environments where the hook target is a known internal service.
   * Default: false (SSRF filter active).
   */
  allowInternal?: boolean | undefined;
}

/** Hook chain step */
export interface ChainStep {
  /** The event path pattern this step waits for, such as `Post:tool:edit`. */
  match: string;
  /** Values kept from the matching event: a name for each, mapped to the event payload field it is read from. */
  capture?: Record<string, string> | undefined;
  /** How long after the previous step this step may arrive, such as `30s` or `5m`; later, the chain starts over. */
  within?: string;
  /** An expression over the event payload fields that must be true for the event to count (`===`, `!==`, `<`, `<=`, `>`, `>=`, `&&`, `||`, `!`), such as `exitCode !== 0`. */
  condition?: string;
  /** The step may be skipped: an event for the next step moves past it. */
  optional?: boolean | undefined;
  /** For an optional step: wait this long after its last matching event (such as `2s`) before moving on, so a burst counts once. */
  debounce?: string;
}

/** Hook chain definition */
export interface HookChain {
  /** The chain's name, unique among chains. */
  name: string;
  /** What the chain is for, in words. */
  description?: string | undefined;
  /** The events that must happen, in order, before the action runs. */
  steps: ChainStep[];
  /** The hook that runs once every step has happened; its `match` is the event path it reports. */
  action: HookDefinition;
}

/** Full hooks.json schema */
export interface HooksConfig {
  /** Direct hooks keyed by event path pattern */
  hooks?: Record<string, HookDefinition[]> | undefined;
  /** Multi-event chains */
  chains?: HookChain[] | undefined;
}
