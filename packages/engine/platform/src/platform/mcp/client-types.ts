/**
 * Public option and observation types for McpClient.
 */
import type { McpElicitationContext } from './elicitation-autonomous.js';
import type { ExternalOperationSource } from '../permissions/external-request.js';
import type { JsonRpcId } from './jsonrpc.js';

export interface McpProcessSpec {
  command: string;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
  cwd?: string | undefined;
  summary?: string | undefined;
  sandboxSessionId?: string | undefined;
}

export interface McpToolInfo {
  name: string;
  description: string;
}

export interface McpToolSchema extends McpToolInfo {
  inputSchema: Record<string, unknown>;
  /** Server-declared presentation hints; never a permission grant. */
  annotations?: {
    readonly readOnlyHint?: boolean | undefined;
    readonly destructiveHint?: boolean | undefined;
    readonly idempotentHint?: boolean | undefined;
    readonly openWorldHint?: boolean | undefined;
  } | undefined;
}

/** A listed tool the client left out of its catalog, and why it cannot be called. */
export interface McpExcludedTool {
  readonly name: string;
  readonly reason: string;
}

/** A question an MCP server asked during a tool call that no one answered; it is added to the tool result. */
export interface McpUnansweredQuestion {
  readonly message: string;
  readonly fields: readonly string[];
}

/** Additive restrictions from the actual caller, never execution authority. */
export interface McpToolCallOptions {
  readonly signal?: AbortSignal | undefined;
  /** The caller's own check, run before admission and again just before the request is sent. */
  readonly assertCurrent?: (() => void) | undefined;
  /** Require the schema object this registry handed the caller (compared by identity); never a grant. */
  readonly expectedSchema?: McpToolSchema | undefined;
  /** The session making the call, carried on the MCP hook events. */
  readonly sessionId?: string | undefined;
  /** How long the server may take to answer the call; defaults to the registry's tool-call deadline. 0 means no deadline. */
  readonly deadlineMs?: number | undefined;
}

/** What the registry hands one client call: when to stop, what to check just before sending, and the calling operation. */
export interface McpClientCallOptions {
  readonly signal?: AbortSignal | undefined;
  /** Runs synchronously immediately before each request of the call is written; a throw sends nothing. */
  readonly beforeSend?: (() => void) | undefined;
  /** The autonomous operation the call belongs to; server questions during the call are resolved against it. */
  readonly operation?: ExternalOperationSource | undefined;
}

export interface McpClientNotification {
  serverName: string;
  method: string;
  params?: unknown | undefined;
}

export interface McpClientServerRequest {
  serverName: string;
  id: JsonRpcId;
  method: string;
  params?: unknown | undefined;
}

export interface McpClientUnhandledResponse {
  serverName: string;
  id: JsonRpcId | null;
  hasError: boolean;
  error?: string | undefined;
}

/**
 * A resolver for the MCP `elicitation/create` server→client request. When
 * wired, the client advertises the `elicitation` capability at handshake and
 * routes incoming elicitation requests here instead of hard-rejecting them with
 * `-32601`; the resolved outcome is written back as the JSON-RPC result.
 * Modern-era servers deliver elicitation as Multi Round-Trip Request input
 * requests on tool calls; those route through the same resolver.
 */
export type McpElicitationResolver = (input: {
  serverName: string;
  id: JsonRpcId;
  params?: unknown | undefined;
  context?: McpElicitationContext | undefined;
}) => Promise<{ action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> | undefined }>;

/**
 * Where a client's connection is in its life. `restart-wait` means a crashed
 * stdio server will be respawned on a timer; `gave-up` means it will not be
 * respawned without a reconnect (configuration reload).
 */
export type McpClientPhase = 'idle' | 'starting' | 'negotiating' | 'ready' | 'restart-wait' | 'gave-up' | 'closed';

export interface McpClientOptions {
  /** Live owner check immediately before every initial or restarted process spawn. */
  beforeProcessStart?: (() => void) | undefined;
  /** Bound for every request on this connection; 0 (the default) leaves tool calls to the registry's deadline. */
  timeout?: number | undefined;
  /**
   * Bound for the handshake (stdio `initialize`, HTTP `server/discover` and
   * `initialize`), so a server that never answers cannot hold a connect open
   * forever even when `timeout` is 0.
   * Defaults to `timeout` when that is set, otherwise 30 s; 0 disables it.
   */
  initializeTimeoutMs?: number | undefined;
  /** Base delay before a crashed stdio server is restarted; attempt N waits N times this. Defaults to 2 s. */
  restartDelayMs?: number | undefined;
  processSpec?: McpProcessSpec | undefined;
  onNotification?: ((notification: McpClientNotification) => void) | undefined;
  onServerRequest?: ((request: McpClientServerRequest) => void) | undefined;
  onUnhandledResponse?: ((response: McpClientUnhandledResponse) => void) | undefined;
  /**
   * When set, `elicitation/create` server requests are resolved through this
   * handler (which brokers them to the approval channel) rather than dropped.
   */
  onElicitation?: McpElicitationResolver | undefined;
  /** Injectable fetch for the Streamable HTTP transport (tests). */
  fetchImpl?: typeof fetch | undefined;
}
