import type { TurnHookOwner } from '../hooks/turn-ownership.js';
import type { PermissionCategory, PermissionRequestAnalysis } from './types.js';
import type { RememberTier, RememberTierOption } from './approval-rules.js';
import type { OwnerOnlyKind } from '../gate/classify.js';

/** Stands in for a typed terminal-prompt answer in every stored or published approval record. */
export const WITHHELD_PROMPT_ANSWER = '[answer withheld]';

/**
 * Attribution for a permission ask that did NOT originate from the foreground
 * turn loop. Populated when a background/subagent tool call, or an MCP server's
 * elicitation request, brokers an ask so a surface can render "who is asking"
 * instead of an anonymous prompt. Absent on foreground asks (the common case).
 *
 * A discriminated union: every non-foreground origin that reaches the approval
 * broker names itself here so the same prompt UI can attribute it. Adding an
 * origin means adding a member, never widening `kind` to `string`.
 */
export type PermissionAttribution =
  | BackgroundAgentAttribution
  | McpServerAttribution
  | SandboxEscalationAttribution
  | FetchLocalhostAttribution
  | ExecPromptAttribution
  | OutsideCallerAttribution;

/**
 * A caller outside the daemon (a script or agent with a credential, a signed-in user, a paired device) asked for a
 * capability over the daemon's API, and the daemon put it to the owner (`capabilities.run`): the question names who
 * is asking.
 */
export interface OutsideCallerAttribution {
  readonly kind: 'outside-caller';
  /** Who asked, as a person reads it: a sign-in by its user name, a paired device by its name. */
  readonly name: string;
  /** The principal the daemon authenticated (`pairing:<id>`, a user name, `shared-token`). */
  readonly principalId: string;
}

/** A background/subagent tool call brokered an ask on behalf of a spawned agent. */
export interface BackgroundAgentAttribution {
  readonly kind: 'background-agent';
  /** The spawned agent's record id. */
  readonly agentId: string;
  /** The agent's archetype/template, when known (e.g. 'engineer'). */
  readonly template?: string | undefined;
}

/**
 * An MCP server asked the client for user input (spec `elicitation/create`), and
 * that request is routed through the SAME approval broker as a permission ask so
 * every surface's existing approval UI renders it and background-agent bubbling
 * applies. Carries which server is asking so the prompt can attribute it.
 */
export interface McpServerAttribution {
  readonly kind: 'mcp-server';
  /** The MCP server that issued the elicitation request. */
  readonly serverName: string;
}

/**
 * The active per-command exec sandbox needs host access a boundary-safe command
 * would not, network, a host-privilege escalation, a package install that
 * reaches the network, so it brokers an ASK through the SAME approval broker as
 * a permission ask (one learned pattern, not five). Every surface's approval UI
 * renders it and background bubbling applies. Names the sandbox and the specific
 * escalation so the prompt can attribute it ("wants-network").
 */
/**
 * The fetch tool wants to reach a loopback dev server (localhost/127.0.0.1)
 * and brokers a one-tap "allow for this project" ask through the SAME approval
 * broker as every other ask. Approving persists fetch.allowLocalhost in the
 * project settings so it is never asked again for this project.
 */
export interface FetchLocalhostAttribution {
  readonly kind: 'fetch-localhost';
  /** The loopback host being fetched (e.g. 'localhost'). */
  readonly host: string;
  /** The full URL of the first fetch that raised the ask. */
  readonly url: string;
}

/**
 * A running exec command stopped on a terminal prompt (host-key confirmation,
 * credential ask) under the PTY prompt-answer path, and the pending prompt is
 * brokered through the SAME approval broker as a permission ask so every
 * surface's existing approval/attention machinery renders it. The decision's
 * `modifiedArgs.answer` carries the typed reply back to the waiting child.
 */
export interface ExecPromptAttribution {
  readonly kind: 'exec-prompt';
  /** The command that is waiting on its terminal. */
  readonly command: string;
  /** The detected prompt line the child is blocked on. */
  readonly prompt: string;
}

export interface SandboxEscalationAttribution {
  readonly kind: 'sandbox-escalation';
  /** The sandbox that raised the escalation (e.g. 'exec-sandbox'). */
  readonly sandbox: string;
  /** The specific host-access escalations named on this ask (e.g. 'wants-network'). */
  readonly escalations: readonly string[];
}

export interface PermissionPromptRequest {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  category: PermissionCategory;
  analysis: PermissionRequestAnalysis;
  workingDirectory?: string | undefined;
  /**
   * Set when the ask was brokered on behalf of a background/subagent tool call.
   * Undefined for foreground asks.
   */
  attribution?: PermissionAttribution | undefined;
  /**
   * The remember tiers this ask can offer (exact command / command class /
   * path scope / whole tool / session), most specific first, computed by
   * PermissionManager so EVERY surface (TUI, webui, companion) renders the
   * same options. A decision answers with `rememberTier`. An empty list: no
   * answer to this ask is remembered (a change asked for in a channel is
   * approved one call at a time), so a surface offers only allow once and deny.
   * Absent: an ask from before remember tiers; a surface may offer a session answer.
   */
  rememberOptions?: readonly RememberTierOption[] | undefined;
  /**
   * Set when only the owner decides this ask (gate/classify.ts). A remembered
   * allow answers it only when that allow was given to the same owner-only
   * item, as the gate matches it; a remembered deny answers it like any ask.
   */
  ownerOnly?: OwnerOnlyKind | undefined;
  /**
   * Set by the gate when the owner would be asked only about where the call
   * could reach, which a real containment boundary answers: a layer that runs
   * the call inside such a boundary may settle it (`settledBy`). Absent: only
   * the owner answers. In-process only; approvals.raise does not carry it.
   */
  containable?: true | undefined;
  /**
   * Set by the gate when the call acts on what the daemon holds and works in no project folder (a daemon
   * capability): the folder's trust neither refuses nor asks about it; the call itself is still asked. In-process
   * only; approvals.raise does not carry it.
   */
  outsideFolder?: true | undefined;
}

export interface PermissionPromptDecision {
  approved: boolean;
  /** Legacy session-only remember; equivalent to rememberTier 'session'. */
  remember?: boolean | undefined;
  /**
   * How far this decision reaches. A generalizing tier writes a durable
   * user-origin rule (survives restart, suppresses re-asks); 'session' only
   * caches in memory. Absent = one-time decision.
   */
  rememberTier?: RememberTier | undefined;
  /**
   * Optional free-text from the user, most useful on deny: it rides the
   * structured "user declined" tool result so the model can adapt instead of
   * guessing why.
   */
  reason?: string | undefined;
  /**
   * When present, replaces the tool call's original arguments for execution
   * (e.g. a per-hunk-filtered `edits` array for the `edit` tool). Never
   * populated by non-prompt approval paths (auto-approve, policy, session
   * cache), only the user-prompt path can set this.
   */
  modifiedArgs?: Record<string, unknown> | undefined;
  /**
   * Set when a layer between the gate and the owner settled the ask itself
   * (`sandbox`: the exec sandbox runs the command inside its boundary). The
   * gate records it as that layer's decision, never as the owner's, and only
   * for an ask it marked `containable`.
   */
  settledBy?: 'sandbox' | undefined;
  /**
   * Set by a surface where nobody can answer (a headless run with no
   * `--answer-permissions`): the ask was not answered, the call is held for
   * the owner, and `reason` says where it waits. The gate reports the call as
   * held for him, never as refused by him.
   */
  heldForOwner?: boolean | undefined;
}

/** In-process lifetime only; never stored in a prompt or sent over the wire. */
export interface PermissionExecutionOptions {
  /** Trusted in-process turn owner; never included in a prompt payload. */
  readonly hookOwner?: TurnHookOwner | undefined;
  readonly signal?: AbortSignal | undefined;
  /**
   * The registered definition of the tool being checked: its category, declared
   * effects, subjects and `dangerous` flag are the facts the gate classifies by.
   * A dangerous tool is an owner-only grant of access (gate/classify.ts).
   */
  readonly definition?: import('../types/tools.js').ToolDefinition | undefined;
  /**
   * A rule of the owner's outside the gate asks him about this call, in one
   * sentence: his `Pre:tool:<tool>` hook answered `ask`, or an MCP server he
   * trusts `ask-on-risk` was called outside its scope. The call is put to the
   * owner in every mode (held for him in just-vibes) unless a rule refuses it
   * outright.
   */
  readonly ownerAsk?: string | undefined;
}

export type PermissionRequestHandler = (
  request: PermissionPromptRequest,
  options?: PermissionExecutionOptions,
) => Promise<PermissionPromptDecision>;

export interface PermissionRequest extends PermissionPromptRequest {
  resolve: (approved: boolean, remember?: boolean, modifiedArgs?: Record<string, unknown>) => void;
}
