/**
 * McpClient, connects to a single MCP server over stdio (spawned process,
 * newline-delimited JSON-RPC 2.0) or Streamable HTTP (config `url`).
 *
 * Protocol currency: speaks the stateless 2026-07-28 revision (per-request
 * `_meta`, `server/discover`, Multi Round-Trip Requests) and the
 * handshake-based revisions back through 2024-11-05. Era detection follows
 * the specification: probe `server/discover` first, fall back to
 * `initialize` on any error that is not a recognized modern error. The
 * negotiated version is exposed via `protocolInfo` for diagnostics.
 *
 * Tool catalog: connect() fetches no tool data. The first listing, schema
 * read or call loads one catalog per connection from one paged `tools/list`
 * (the protocol has no names-only listing), holding the full schemas. A tool
 * is either in it and callable, or excluded with the reason in
 * `excludedTools`. The catalog is dropped when the connection is replaced or
 * the server sends `notifications/tools/list_changed`; `catalogRevision`
 * counts those changes.
 */
import { randomUUID } from 'node:crypto';
import { captureMcpInputRequired, readProtocolRequest } from '../permissions/protocol-request.js';
import { snapshotJudgmentInput } from '../gate/judgment-input.js';
import type { ExternalOperationSource, ExternalRequestScope } from '../permissions/external-request.js';
import { awaitPermission } from '../permissions/cancellation.js';
import { bindMcpElicitationResponse, commitMcpElicitation, discardMcpElicitation, wasHandedBackToAgent } from './elicitation-autonomous.js';
import type { McpElicitationOutcome } from './elicitation.js';
import { logger } from '../utils/logger.js';
import { VERSION } from '../version.js';
import type { McpServerConfig } from './config.js';
import { summarizeError } from '../utils/error-display.js';
import { isRecord } from '../utils/record-coerce.js';
import { McpHttpConnection, McpRpcError } from './http-connection.js';
import type {
  McpClientCallOptions,
  McpClientNotification,
  McpClientOptions,
  McpClientPhase,
  McpClientServerRequest,
  McpClientUnhandledResponse,
  McpExcludedTool,
  McpToolInfo,
  McpToolSchema,
  McpUnansweredQuestion,
} from './client-types.js';
import {
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  jsonRpcIdKey,
  type JsonRpcId,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './jsonrpc.js';
import { buildParamHeaders, hasValidHeaderAnnotations } from './http-headers.js';
import {
  buildModernMeta,
  isInputRequiredResult,
  isModernVersion,
  isRecognizedModernErrorCode,
  MCP_LEGACY_REVISIONS,
  MCP_STATELESS_REVISION,
  MCP_SUPPORTED_VERSIONS,
  parseDiscoverSupportedVersions,
  parseSupportedVersionsFromError,
  selectMutualVersion,
  withModernMeta,
  type McpNegotiatedProtocol,
} from './protocol.js';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** One loaded tool catalog: what the server listed, keyed by tool name, and what was left out and why. */
interface McpToolCatalog {
  readonly revision: number;
  readonly tools: ReadonlyMap<string, McpToolSchema>;
  readonly excluded: readonly McpExcludedTool[];
}

/** A tool call in flight on this connection; a question the server asks during it is recorded here. */
interface InflightCall {
  readonly operation: ExternalOperationSource | undefined;
  readonly questions: McpUnansweredQuestion[];
}

const DEFAULT_TIMEOUT_MS = 0;
const MAX_TOOL_LIST_PAGES = 100;
/** Bound for one health probe; a server that cannot answer a ping this fast is reported unresponsive. */
const PING_TIMEOUT_MS = 5_000;
const RESTART_DELAY_MS = 2_000;
const MAX_RESTART_ATTEMPTS = 3;
/** Era-detection probe: a legacy stdio server answers `server/discover` quickly with method-not-found; this bound covers servers that stay silent instead. */
const DISCOVER_PROBE_TIMEOUT_MS = 3_000;
/** The handshake is bounded separately from tool calls, on both transports; OAuth-style servers can take a while to answer it. */
const HANDSHAKE_TIMEOUT_MS = 30_000;

export type { JsonRpcId } from './jsonrpc.js';
export type {
  McpClientCallOptions,
  McpClientNotification,
  McpClientOptions,
  McpClientPhase,
  McpClientServerRequest,
  McpClientUnhandledResponse,
  McpElicitationResolver,
  McpExcludedTool,
  McpProcessSpec,
  McpToolInfo,
  McpToolSchema,
  McpUnansweredQuestion,
} from './client-types.js';

function readAnnotations(value: unknown): McpToolSchema['annotations'] {
  if (!isRecord(value)) return undefined;
  return {
    ...(typeof value.readOnlyHint === 'boolean' ? { readOnlyHint: value.readOnlyHint } : {}),
    ...(typeof value.destructiveHint === 'boolean' ? { destructiveHint: value.destructiveHint } : {}),
    ...(typeof value.idempotentHint === 'boolean' ? { idempotentHint: value.idempotentHint } : {}),
    ...(typeof value.openWorldHint === 'boolean' ? { openWorldHint: value.openWorldHint } : {}),
  };
}

/** The question an `elicitation/create` request asks, in the words and fields the server gave. */
function describeQuestion(params: unknown): McpUnansweredQuestion {
  const record = isRecord(params) ? params : {};
  const message = typeof record.message === 'string' && record.message.trim() ? record.message : 'The server asked for input.';
  const schema = isRecord(record.requestedSchema) ? record.requestedSchema : undefined;
  const fields = schema && isRecord(schema.properties) ? Object.keys(schema.properties) : [];
  return { message, fields };
}

/** The tool result with each declined question added as text the agent can act on. */
function withUnansweredQuestions(serverName: string, result: unknown, questions: readonly McpUnansweredQuestion[]): unknown {
  if (questions.length === 0 || !isRecord(result)) return result;
  const lines = questions.map(question => `MCP server '${serverName}' asked: "${question.message}"${question.fields.length ? ` (fields: ${question.fields.join(', ')})` : ''}. `
    + 'No one could answer it here, so it was declined. Ask the user for this, then call the tool again with the answer in its arguments.');
  const content = Array.isArray(result.content) ? result.content : [];
  return { ...result, content: [...content, ...lines.map(text => ({ type: 'text', text }))], unansweredQuestions: questions };
}

export class McpClient {
  private connectionId = randomUUID();
  private connectionLife = new AbortController();
  private readonly incoming = new Map<string, AbortController>();
  readonly #inflight = new Set<InflightCall>();

  private retireConnection(reason = 'the connection was closed'): void {
    this.connectionLife.abort(new Error(`MCP server '${this.config.name}': ${reason}; call the tool again once it is connected`));
    this.#invalidateToolCatalog();
    for (const request of this.incoming.values()) request.abort();
    this.incoming.clear();
  }
  private renewConnection(): void {
    this.retireConnection('the connection was replaced');
    this.connectionId = randomUUID(); this.connectionLife = new AbortController();
  }

  /** The destination and connection a call is admitted against; the signal ends with this connection. */
  captureToolScope(): ExternalRequestScope {
    const connectionId = this.connectionId;
    const destination = this.config.url ?? this.options?.processSpec?.command ?? this.config.command ?? '';
    const signal = this.connectionLife.signal;
    signal.throwIfAborted();
    return { connectionId, destination, signal, assertCurrent: () => signal.throwIfAborted() };
  }

  /** The call a server request belongs to: the one named by the operation, else the only call in flight. */
  #callFor(operation: ExternalOperationSource | undefined): InflightCall | undefined {
    if (operation?.operationId) for (const call of this.#inflight) if (call.operation?.operationId === operation.operationId) return call;
    return this.#inflight.size === 1 ? this.#inflight.values().next().value : undefined;
  }

  private async resolveElicitation(id: JsonRpcId, params: unknown, operation?: ExternalOperationSource, nested = false): Promise<McpElicitationOutcome> {
    const resolver = this.options?.onElicitation;
    if (!resolver) return { action: 'cancel' };
    const call = this.#callFor(operation);
    const owner = operation ?? call?.operation;
    const key = nested ? `${owner?.operationId ?? 'unowned'}:${jsonRpcIdKey(id)}` : jsonRpcIdKey(id);
    const prior = this.incoming.get(key);
    if (prior) { prior.abort(); throw new Error('Duplicate MCP request id'); }
    const controller = new AbortController(); this.incoming.set(key, controller);
    const connectionId = this.connectionId;
    const serverName = this.config.name;
    const signal = AbortSignal.any([this.connectionLife.signal, controller.signal, ...(owner?.signal ? [owner.signal] : [])]);
    const destination = this.config.url ?? this.options?.processSpec?.command ?? this.config.command ?? '';
    const assertCurrent = () => {
      signal.throwIfAborted(); owner?.assertCurrent();
      if (this.incoming.get(key) !== controller) throw new Error('MCP request was replaced');
    };
    const close = () => { if (this.incoming.get(key) === controller) this.incoming.delete(key); controller.abort(); };
    let held: McpElicitationOutcome | undefined;
    try {
      const owned = snapshotJudgmentInput(params);
      assertCurrent();
      const outcome = await awaitPermission(() => resolver({ serverName, id, params: owned,
        context: { scope: { connectionId, destination, signal, assertCurrent }, ...(owner ? { operation: owner } : {}) } }), signal);
      held = outcome;
      assertCurrent();
      if (wasHandedBackToAgent(outcome)) call?.questions.push(describeQuestion(owned));
      const bound = bindMcpElicitationResponse(outcome, assertCurrent, close);
      held = undefined;
      return bound;
    } catch (error) {
      // An accepted outcome already owns an admission and a listener; releasing the request alone would leak both.
      if (held) discardMcpElicitation(held);
      close(); throw error;
    }
  }

  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private nextId = 1;
  private pendingRequests = new Map<string, PendingRequest>();
  private buffer = '';
  /**
   * The process whose stdout is being read. Tracked per process, not as one
   * flag: a loop still blocked on an old process's pipe (a grandchild holding
   * it open) must not stop the next process from getting its own reader.
   */
  private readLoopProc: ReturnType<typeof Bun.spawn> | null = null;
  private restartCount = 0;
  #phase: McpClientPhase = 'idle';
  #lastError: string | null = null;
  /** The pending crash-restart timer, held so a deliberate disconnect can cancel it. */
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private initialized = false;
  /** Set true by disconnect() to suppress the read-loop's auto-restart. Reset on each successful _startProcess(). */
  private intentionalClose = false;

  /** Streamable HTTP connection when the server is configured with a `url`. */
  private http: McpHttpConnection | null = null;

  /** Outcome of protocol version negotiation, for diagnostics. */
  private negotiated: McpNegotiatedProtocol | null = null;

  #catalogRevision = 0;
  #catalog: McpToolCatalog | null = null;
  #pendingCatalog: Promise<McpToolCatalog> | undefined;
  #invalidateToolCatalog(): void {
    this.#catalogRevision++; this.#catalog = null; this.#pendingCatalog = undefined;
  }

  constructor(
    private config: McpServerConfig,
    private options?: McpClientOptions,
  ) {}

  get name(): string {
    return this.config.name;
  }

  get isConnected(): boolean { return this.#isConnected(); }

  #isConnected(): boolean {
    if (this.http) return this.http.isOpen;
    if (!this.proc) return false;
    try {
      // A process ended by a signal (kill, crash) has a null exitCode but a signalCode.
      const proc = this.proc as { exitCode: number | null; signalCode?: string | null };
      return proc.exitCode === null && (proc.signalCode ?? null) === null;
    } catch {
      return false;
    }
  }

  /** The negotiated protocol (era, version, transport), or null before connect. */
  get protocolInfo(): McpNegotiatedProtocol | null {
    return this.negotiated;
  }

  /** Where the connection is in its life; `connected:false` alone cannot tell restarting from given up. */
  get phase(): McpClientPhase {
    // An HTTP session can close underneath a ready client without any local event.
    if (this.#phase === 'ready' && !this.#isConnected()) return 'closed';
    return this.#phase;
  }

  /** The most recent connect, handshake or crash failure; cleared once the server is ready again. */
  get lastError(): string | null {
    return this.#lastError;
  }

  /** Bumped whenever the tool catalog is dropped (connection replaced, server said its list changed). */
  get catalogRevision(): number {
    return this.#catalogRevision;
  }

  /** Tools the loaded catalog left out, each with the reason; empty before the first listing. */
  get excludedTools(): readonly McpExcludedTool[] {
    return this.#catalog?.excluded ?? [];
  }

  #fail(phase: McpClientPhase, error: unknown): void {
    this.#phase = phase;
    this.#lastError = summarizeError(error);
  }

  /**
   * connect, Start the transport and negotiate a protocol version.
   * After connect, listTools() is available. No tool data is fetched here.
   */
  async connect(): Promise<void> {
    try {
      await this.#connect();
    } catch (error) {
      // A process that died mid-handshake may already have a restart queued.
      this.#fail(this.restartTimer ? 'restart-wait' : 'gave-up', error);
      throw error;
    }
    this.#phase = 'ready';
    this.#lastError = null;
  }

  #handshakeTimeoutMs(): number {
    return this.options?.initializeTimeoutMs ?? (this.options?.timeout || HANDSHAKE_TIMEOUT_MS);
  }

  async #connect(): Promise<void> {
    if (this.config.url) {
      if (this.http?.isOpen) return;
      this.#phase = 'negotiating';
      this.renewConnection();
      this.http = new McpHttpConnection({
        serverName: this.config.name,
        url: this.config.url,
        clientInfo: { name: 'goodvibes-platform', version: VERSION },
        clientCapabilities: this._clientCapabilities(),
        timeoutMs: this.options?.timeout ?? DEFAULT_TIMEOUT_MS,
        handshakeTimeoutMs: this.#handshakeTimeoutMs(),
        fetchImpl: this.options?.fetchImpl,
        ...(this.config.headers ? { headers: this.config.headers } : {}),
        handlers: {
          onNotification: (method, params) => {
            this._handleNotification({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
          },
          onServerRequest: (id, method, params, operation) => this._answerServerRequestOverHttp(id, method, params, operation),
        },
      });
      this.negotiated = await this.http.negotiate();
      return;
    }
    if (this.proc && this.isConnected) return;
    await this._startProcess();
    await this._negotiate();
    // Only a negotiated connection counts as a successful start.
    this.restartCount = 0;
  }

  /** Every page of tools/list: a server that pages is never silently cut to its first page. */
  async #requestAllTools(signal: AbortSignal): Promise<unknown[]> {
    const tools: unknown[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_LIST_PAGES; page++) {
      const result = await this._request<{ tools?: unknown[]; nextCursor?: unknown }>('tools/list', cursor === undefined ? undefined : { cursor }, undefined, undefined, undefined, signal);
      tools.push(...(Array.isArray(result?.tools) ? result.tools : []));
      const next = typeof result?.nextCursor === 'string' && result.nextCursor !== '' ? result.nextCursor : undefined;
      if (next === undefined) return tools;
      if (seen.has(next)) throw new Error(`McpClient(${this.config.name}): tools/list repeated a page cursor`);
      seen.add(next); cursor = next;
    }
    throw new Error(`McpClient(${this.config.name}): tools/list returned more than ${MAX_TOOL_LIST_PAGES} pages; the catalog would be incomplete`);
  }

  #buildCatalog(revision: number, listed: readonly unknown[]): McpToolCatalog {
    const tools = new Map<string, McpToolSchema>();
    const excluded: McpExcludedTool[] = [];
    for (const entry of listed) {
      if (!isRecord(entry) || typeof entry.name !== 'string' || !entry.name) continue;
      const inputSchema = isRecord(entry.inputSchema) ? entry.inputSchema : { type: 'object', properties: {} };
      // On the HTTP transport the specification requires excluding tool
      // definitions whose x-mcp-header annotations are invalid.
      if (this.http && !hasValidHeaderAnnotations(inputSchema)) {
        excluded.push({ name: entry.name, reason: 'its x-mcp-header annotations are invalid, so the HTTP transport cannot carry its arguments' });
        logger.warn('McpClient: excluding tool with invalid x-mcp-header annotations', { server: this.config.name, tool: entry.name });
        continue;
      }
      const annotations = readAnnotations(entry.annotations);
      tools.set(entry.name, {
        name: entry.name,
        description: typeof entry.description === 'string' ? entry.description : '',
        inputSchema,
        ...(annotations ? { annotations } : {}),
      });
    }
    return Object.freeze({ revision, tools, excluded: Object.freeze(excluded) });
  }

  /**
   * The connection's one tool catalog. A listing in progress is shared, and it
   * runs under the connection's own lifetime: cancelling one waiting caller
   * never fails another's listing.
   */
  #loadCatalog(): Promise<McpToolCatalog> {
    if (this.#catalog) return Promise.resolve(this.#catalog);
    if (this.#pendingCatalog) return this.#pendingCatalog;
    if (!this.isConnected) return Promise.reject(new Error(`McpClient(${this.config.name}): not connected`));
    const revision = this.#catalogRevision;
    const pending = this.#requestAllTools(this.connectionLife.signal).then(listed => {
      const catalog = this.#buildCatalog(revision, listed);
      if (this.#catalogRevision === revision) this.#catalog = catalog;
      return catalog;
    });
    this.#pendingCatalog = pending;
    const finished = () => { if (this.#pendingCatalog === pending) this.#pendingCatalog = undefined; };
    pending.then(finished, finished);
    return pending;
  }

  async #catalogFor(signal?: AbortSignal): Promise<McpToolCatalog> {
    return signal ? awaitPermission(() => this.#loadCatalog(), signal) : this.#loadCatalog();
  }

  /** Tool names and descriptions from the connection's catalog. */
  async listTools(signal?: AbortSignal): Promise<McpToolInfo[]> {
    const catalog = await this.#catalogFor(signal);
    return [...catalog.tools.values()].map(tool => ({ name: tool.name, description: tool.description }));
  }

  /** The full schema of one listed tool, or null when the server does not list it (or it was excluded). */
  async getToolSchema(toolName: string, signal?: AbortSignal): Promise<McpToolSchema | null> {
    return (await this.#catalogFor(signal)).tools.get(toolName) ?? null;
  }

  /** The schema from the loaded catalog without any request; undefined before the first listing. */
  getCachedToolSchema(toolName: string): McpToolSchema | undefined {
    return this.#catalog?.tools.get(toolName);
  }

  /** Why a tool name cannot be called on this server: not listed, or listed but excluded and why. */
  describeUnavailableTool(toolName: string): string {
    const excluded = this.excludedTools.find(tool => tool.name === toolName);
    return excluded
      ? `MCP server '${this.config.name}' lists tool '${toolName}' but it cannot be called: ${excluded.reason}. Fix the tool definition on the server.`
      : `MCP server '${this.config.name}' does not list a tool named '${toolName}'. List its tools again to see the current names.`;
  }

  /**
   * callTool, Execute a tool on the MCP server.
   * Modern-era servers may answer with an input_required interim result
   * (Multi Round-Trip Requests); elicitation input requests are resolved
   * through the wired resolver and the call is retried with inputResponses.
   * A question the server asked that was declined is added to the result.
   */
  async callTool(toolName: string, args: Record<string, unknown>, options: McpClientCallOptions = {}): Promise<unknown> {
    if (!this.isConnected) throw new Error(`McpClient(${this.config.name}): not connected`);
    const signal = options.signal ? AbortSignal.any([this.connectionLife.signal, options.signal]) : this.connectionLife.signal;
    const operation = options.operation;
    const boundOperation: ExternalOperationSource | undefined = operation
      ? { ...operation, operationId: randomUUID(), signal, assertCurrent: () => { signal.throwIfAborted(); operation.assertCurrent(); } }
      : undefined;
    const call: InflightCall = { operation: boundOperation, questions: [] };
    let responses: Record<string, unknown> | null = null;
    this.#inflight.add(call);
    try {
      const schema = await this.getToolSchema(toolName, signal);
      if (!schema) throw new Error(this.describeUnavailableTool(toolName));
      let params: Record<string, unknown> = { name: toolName, arguments: args };
      while (true) {
        signal.throwIfAborted();
        const pendingResponses = responses;
        const beforeSend = () => {
          signal.throwIfAborted();
          if (this.getCachedToolSchema(toolName) !== schema) throw new Error(`MCP server '${this.config.name}' changed its tool list during the call; nothing was sent. Call the tool again.`);
          options.beforeSend?.();
          if (pendingResponses) for (const response of Object.values(pendingResponses)) commitMcpElicitation(response);
        };
        const result = await this._request('tools/call', params, this._toolCallHeaders(schema, args), boundOperation, beforeSend, signal);
        // The tool has run once its result is back: a change after that point must
        // not discard the result. Only an interim result that asks for another
        // request still needs the call to be current.
        const interim = this.negotiated?.era === 'modern' && isInputRequiredResult(result);
        responses = null;
        if (!interim) return withUnansweredQuestions(this.config.name, result, call.questions);
        signal.throwIfAborted();
        const ownedResult = readProtocolRequest(captureMcpInputRequired(result)).wire as typeof result;
        responses = await this._resolveInputRequests(toolName, ownedResult.inputRequests, boundOperation);
        params = { name: toolName, arguments: args, ...(responses ? { inputResponses: responses } : {}),
          ...(typeof ownedResult.requestState === 'string' ? { requestState: ownedResult.requestState } : {}) };
      }
    } finally {
      this.#inflight.delete(call);
      if (responses) for (const response of Object.values(responses)) discardMcpElicitation(response);
    }
  }

  /** Mcp-Param-* headers for a tools/call on the modern HTTP transport. */
  private _toolCallHeaders(schema: McpToolSchema, args: Record<string, unknown>): Record<string, string> | undefined {
    if (!this.http || this.negotiated?.era !== 'modern') return undefined;
    const headers = buildParamHeaders(schema.inputSchema, args);
    return Object.keys(headers).length > 0 ? headers : undefined;
  }

  /** Resolve MRTR input requests; only elicitation is answerable client-side. */
  private async _resolveInputRequests(
    toolName: string,
    inputRequests: Record<string, unknown> | undefined,
    operation?: ExternalOperationSource,
  ): Promise<Record<string, unknown> | null> {
    if (!inputRequests) return null;
    const resolver = this.options?.onElicitation;
    const responses = Object.create(null) as Record<string, unknown>;
    try {
      for (const [key, request] of Object.entries(inputRequests)) {
        const method = isRecord(request) && typeof request.method === 'string' ? request.method : 'unknown';
        if (method !== 'elicitation/create' || !resolver) {
          throw new Error(
            `McpClient(${this.config.name}): tool '${toolName}' requested '${method}' input this client cannot provide`,
          );
        }
        const params = isRecord(request) ? request.params : undefined;
        responses[key] = await this.resolveElicitation(key, params, operation, true);
      }
      return responses;
    } catch (error) { for (const response of Object.values(responses)) discardMcpElicitation(response); throw error; }
  }

  /**
   * disconnect, Stop the server process and clean up.
   */
  async disconnect(): Promise<void> {
    // Mark this as a deliberate shutdown so the read-loop finally does not
    // resurrect the process via _scheduleRestart(). Set synchronously before
    // any await so it is already true when the detached read loop runs.
    this.intentionalClose = true;
    this._cancelRestart();
    this.retireConnection('the server was disconnected');
    if (this.http) {
      const http = this.http;
      await http.close();
      if (this.http === http) { this.http = null; this.negotiated = null; this.#phase = 'closed'; }
      return;
    }
    if (!this.proc) { this.#phase = 'closed'; return; }
    const proc = this.proc;
    // Reject all pending requests
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`McpClient(${this.config.name}): disconnected`));
    }
    this.pendingRequests.clear();

    try {
      (proc.stdin as import('bun').FileSink).end();
      proc.kill();
      await proc.exited;
    } catch (err: unknown) {
      // The process may already be gone; record the shutdown error for ops.
      logger.warn('[McpClient] error during process shutdown', { error: String(err) });
    } finally {
      this.#phase = 'closed';
      if (this.proc === proc) {
        this.proc = null;
        this.buffer = '';
        if (this.readLoopProc === proc) this.readLoopProc = null;
        this.initialized = false;
        this.negotiated = null;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async _startProcess(): Promise<void> {
    this.renewConnection();
    this.#phase = 'starting';
    // A new process has negotiated nothing, whatever the previous one did.
    this.initialized = false;
    this.negotiated = null;
    const processSpec = this.options?.processSpec;
    const cmd = processSpec?.command ?? this.config.command;
    if (!cmd) {
      throw new Error(`McpClient(${this.config.name}): no command configured (stdio servers need 'command'; HTTP servers need 'url')`);
    }
    const args = processSpec?.args ?? this.config.args ?? [];
    const env = { ...process.env, ...(this.config.env ?? {}), ...(processSpec?.env ?? {}) };
    const cwd = processSpec?.cwd;

    try {
      this.options?.beforeProcessStart?.();
      this.proc = Bun.spawn([cmd, ...args], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env,
        ...(cwd ? { cwd } : {}),
      });
      this.buffer = '';
      this.intentionalClose = false;
      this._startReadLoop();
    } catch (err) {
      logger.error('McpClient: failed to start process', { server: this.config.name, err: summarizeError(err) });
      this.proc = null;
      throw new Error(`McpClient(${this.config.name}): failed to start: ${summarizeError(err)}`);
    }
  }

  /** Capabilities advertised to the server (both eras). */
  private _clientCapabilities(): Record<string, unknown> {
    // Advertise the elicitation capability only when a resolver is wired, so
    // a spec-compliant server knows it may ask the user for input (and does
    // not when we would only reject it).
    return this.options?.onElicitation ? { elicitation: {} } : {};
  }

  /**
   * Detect the server's era and negotiate a protocol version (stdio).
   *
   * Probe with `server/discover` first, as the specification directs for
   * dual-era stdio clients. A recognized modern error negotiates from the
   * server's advertised versions; any other error (or probe silence) falls
   * back to the `initialize` handshake.
   */
  private async _negotiate(): Promise<void> {
    if (this.initialized) return;
    this.#phase = 'negotiating';
    let modernSupported: string[] | 'legacy';
    try {
      const meta = buildModernMeta(MCP_STATELESS_REVISION, { name: 'goodvibes-platform', version: VERSION }, this._clientCapabilities());
      const result = await this._rawRequest('server/discover', withModernMeta({}, meta), DISCOVER_PROBE_TIMEOUT_MS);
      modernSupported = parseDiscoverSupportedVersions(result) ?? [MCP_STATELESS_REVISION];
    } catch (err) {
      // The process died or the connection was retired: there is nothing to fall back to.
      if (this.connectionLife.signal.aborted) throw err;
      const supported = err instanceof McpRpcError && isRecognizedModernErrorCode(err.code)
        ? parseSupportedVersionsFromError(err.data)
        : null;
      modernSupported = supported ?? 'legacy';
    }

    if (modernSupported !== 'legacy') {
      const mutual = selectMutualVersion(modernSupported);
      if (!mutual) {
        throw new Error(
          `McpClient(${this.config.name}): no shared protocol version `
          + `(server: ${modernSupported.join(', ')}; client: ${MCP_SUPPORTED_VERSIONS.join(', ')})`,
        );
      }
      if (isModernVersion(mutual)) {
        // Stateless era: no handshake; every request carries _meta.
        this.negotiated = { era: 'modern', version: mutual, transport: 'stdio' };
        this.initialized = true;
        return;
      }
      // Dual-era server whose newest mutual version is handshake-based.
    }

    try {
      const requested = MCP_LEGACY_REVISIONS[0];
      const result = await this._rawRequest('initialize', {
        protocolVersion: requested,
        capabilities: this._clientCapabilities(),
        clientInfo: { name: 'goodvibes-platform', version: VERSION },
      }, this.#handshakeTimeoutMs());
      const serverVersion = isRecord(result) && typeof result.protocolVersion === 'string'
        ? result.protocolVersion
        : requested;
      if (!MCP_SUPPORTED_VERSIONS.includes(serverVersion)) {
        throw new Error(`server negotiated unsupported protocol version ${serverVersion} (client supports: ${MCP_SUPPORTED_VERSIONS.join(', ')})`);
      }
      this._notify('notifications/initialized', {});
      this.negotiated = { era: 'legacy', version: serverVersion, transport: 'stdio' };
      this.initialized = true;
    } catch (err) {
      logger.error('McpClient: initialize handshake failed', { server: this.config.name, err: summarizeError(err) });
      throw err;
    }
  }

  /**
   * Send a JSON-RPC request; returns the result. In the modern era the
   * request params carry the per-request `_meta` the revision requires.
   */
  private _request<T = unknown>(method: string, params?: unknown, extraHeaders?: Record<string, string>, operation?: ExternalOperationSource, beforeSend?: () => void, signal?: AbortSignal, timeoutOverrideMs?: number): Promise<T> {
    let finalParams = params;
    if (this.negotiated?.era === 'modern') {
      const meta = buildModernMeta(this.negotiated.version, { name: 'goodvibes-platform', version: VERSION }, this._clientCapabilities());
      finalParams = withModernMeta(params, meta);
    }
    const requestSignal = signal ?? operation?.signal;
    if (this.http) {
      return this.http.request(method, finalParams, extraHeaders, operation, beforeSend, requestSignal, timeoutOverrideMs) as Promise<T>;
    }
    return this._rawRequest<T>(method, finalParams, timeoutOverrideMs, beforeSend, requestSignal);
  }

  /** Send a JSON-RPC request over stdio without protocol decoration. */
  private _rawRequest<T = unknown>(method: string, params?: unknown, timeoutOverrideMs?: number, beforeSend?: () => void, operationSignal?: AbortSignal): Promise<T> {
    if (!this.proc) {
      return Promise.reject(new Error(`McpClient(${this.config.name}): not running`));
    }

    const id = this.nextId++;
    const pendingKey = jsonRpcIdKey(id);
    const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    const line = JSON.stringify(msg) + '\n';
    const timeoutMs = timeoutOverrideMs ?? this.options?.timeout ?? DEFAULT_TIMEOUT_MS;

    const signal = operationSignal ? AbortSignal.any([this.connectionLife.signal, operationSignal]) : this.connectionLife.signal;
    return new Promise<T>((resolve, reject) => {
      let written = false;
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); };
      const onAbort = () => {
        this.pendingRequests.delete(pendingKey);
        cleanup(); if (written) this.#cancelRequest(id, method, 'request aborted'); reject(signal.reason);
      };
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pendingRequests.delete(pendingKey);
        cleanup();
        if (written) this.#cancelRequest(id, method, `request timed out after ${timeoutMs}ms`);
        reject(new Error(`McpClient(${this.config.name}): request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs) : undefined;
      timer?.unref?.();

      this.pendingRequests.set(pendingKey, {
        resolve: value => { cleanup(); resolve(value as T); },
        reject: error => { cleanup(); reject(error); },
        timer,
      });

      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) { onAbort(); return; }
      // The caller's own refusal reaches it as thrown, so it is not mistaken for a transport write failure.
      try { beforeSend?.(); } catch (err) { cleanup(); this.pendingRequests.delete(pendingKey); reject(err); return; }
      try {
        (this.proc?.stdin as import('bun').FileSink | undefined)?.write(line);
        written = true;
      } catch (err) {
        cleanup();
        this.pendingRequests.delete(pendingKey);
        reject(new Error(`McpClient(${this.config.name}): write failed: ${summarizeError(err)}`));
      }
    });
  }

  /**
   * Tell the server a request it may still be running was given up on, so a slow
   * mutating tool is not left running while the caller retries it. Best effort:
   * the specification forbids cancelling `initialize`, and a gone process needs nothing.
   */
  #cancelRequest(requestId: number, method: string, reason: string): void {
    if (method === 'initialize' || !this.proc || !this.isConnected) return;
    try {
      (this.proc.stdin as import('bun').FileSink).write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId, reason } })}\n`);
    } catch (err) {
      logger.debug('McpClient: could not send request cancellation', { server: this.config.name, method, err: summarizeError(err) });
    }
  }

  /** Send a JSON-RPC notification (no response expected). */
  private _notify(method: string, params?: unknown): void {
    if (!this.proc || !this.isConnected) {
      logger.warn('McpClient: skipped JSON-RPC notification because process is not connected', { server: this.config.name, method });
      return;
    }
    try {
      const msg = { jsonrpc: '2.0', method, params };
      (this.proc.stdin as import('bun').FileSink).write(JSON.stringify(msg) + '\n');
    } catch (err) {
      logger.warn('McpClient: failed to send JSON-RPC notification', { server: this.config.name, method, err: summarizeError(err) });
    }
  }

  private _startReadLoop(): void {
    if (!this.proc || this.readLoopProc === this.proc) return;
    const proc = this.proc;
    this.readLoopProc = proc;
    const decoder = new TextDecoder();

    (async () => {
      try {
        const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          this.buffer += decoder.decode(value, { stream: true });
          this._processBuffer();
        }
      } catch (err) {
        logger.warn('McpClient: stdout read loop ended', { server: this.config.name, err: summarizeError(err) });
      } finally {
        if (this.readLoopProc === proc) this.readLoopProc = null;
        if (this.proc === proc) this.#onProcessExit(proc);
      }
    })();
  }

  #onProcessExit(proc: ReturnType<typeof Bun.spawn>): void {
    // Reject remaining pending requests before retiring the connection, so
    // callers learn the process exited rather than a bare abort.
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`McpClient(${this.config.name}): process exited unexpectedly`));
    }
    this.pendingRequests.clear();
    this.retireConnection('the server process exited');
    // The process is gone; any restart must re-negotiate the protocol.
    this.initialized = false;
    this.negotiated = null;

    // Auto-restart only on an unexpected crash, never after a deliberate disconnect.
    if (this.intentionalClose) {
      this.#phase = 'closed';
      return;
    }
    // stdout can close while the process lives on; nothing would read its
    // replies again, so it must not keep reporting itself connected.
    if (this.#isConnected()) {
      try { proc.kill(); } catch { /* already gone */ }
    }
    // Keep a more specific failure (a timed-out restart handshake) when there is one.
    this.#lastError ??= 'the server process exited unexpectedly';
    if (this.restartCount < MAX_RESTART_ATTEMPTS) {
      this._scheduleRestart();
    } else {
      this.#phase = 'gave-up';
      // The exit status can land after stdout closes; a client that gave up holds no process.
      this.proc = null;
      this.buffer = '';
      logger.info('McpClient: exceeded max restart attempts', { server: this.config.name });
    }
  }

  private _processBuffer(): void {
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (!line) continue;
      this._dispatchLine(line);
    }
  }

  private _dispatchLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      logger.warn('McpClient: failed to parse JSON line', { server: this.config.name, err: summarizeError(err), line: line.slice(0, 200) });
      return;
    }

    if (!isRecord(msg)) {
      logger.warn('McpClient: ignored non-object JSON-RPC line', { server: this.config.name, line: line.slice(0, 200) });
      return;
    }

    if (isJsonRpcResponse(msg)) {
      this._handleResponse(msg);
      return;
    }

    if (isJsonRpcRequest(msg)) {
      this._handleServerRequest(msg);
      return;
    }

    if (isJsonRpcNotification(msg)) {
      this._handleNotification(msg);
      return;
    }

    logger.warn('McpClient: ignored unsupported JSON-RPC message', { server: this.config.name, line: line.slice(0, 200) });
  }

  private _handleResponse(response: JsonRpcResponse): void {
    const pendingKey = response.id === null ? null : jsonRpcIdKey(response.id);
    if (pendingKey === null) {
      this._handleUnhandledResponse(response);
      return;
    }
    const pending = pendingKey ? this.pendingRequests.get(pendingKey) : undefined;
    if (!pending) {
      this._handleUnhandledResponse(response);
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(pendingKey);
    if (response.error) {
      pending.reject(new McpRpcError(
        response.error.code,
        `McpClient(${this.config.name}) RPC error ${response.error.code}: ${response.error.message}`,
        response.error.data,
      ));
    } else {
      pending.resolve(response.result);
    }
  }

  private _handleNotification(notification: JsonRpcNotification): void {
    if (notification.method === 'notifications/tools/list_changed') this.#invalidateToolCatalog();
    if (notification.method === 'notifications/cancelled' && isRecord(notification.params)) {
      const requestId = notification.params.requestId;
      if (typeof requestId === 'string' || typeof requestId === 'number') this.incoming.get(jsonRpcIdKey(requestId))?.abort();
    }
    logger.debug('McpClient: received JSON-RPC notification', {
      server: this.config.name,
      method: notification.method,
    });
    const observed: McpClientNotification = {
      serverName: this.config.name,
      method: notification.method,
      ...(notification.params !== undefined ? { params: notification.params } : {}),
    };
    this._callObserver('notification', () => this.options?.onNotification?.(observed));
  }

  private _handleServerRequest(request: JsonRpcRequest): void {
    try { request = snapshotJudgmentInput(request) as JsonRpcRequest; } catch (err) {
      // An answer the server can act on, rather than leaving it waiting for one that never comes.
      logger.warn('McpClient: refused an unreadable server request', { server: this.config.name, id: request.id, err: summarizeError(err) });
      this._sendJsonRpcError(request.id, -32600, 'Invalid request: the client could not read its parameters');
      return;
    }
    const observed: McpClientServerRequest = {
      serverName: this.config.name,
      id: request.id,
      method: request.method,
      ...(request.params !== undefined ? { params: request.params } : {}),
    };
    // The observer (a Lifecycle hook) fires for every server request regardless
    // of whether we can answer it.
    this._callObserver('server request', () => this.options?.onServerRequest?.(observed));

    // Elicitation is the one server→client request we can genuinely answer: route
    // it to the wired resolver and write its outcome back as the JSON-RPC result
    // instead of rejecting with -32601.
    const elicit = this.options?.onElicitation;
    if (request.method === 'elicitation/create' && elicit) {
      logger.info('McpClient: brokering elicitation/create request', {
        server: this.config.name,
        id: request.id,
      });
      const proc = this.proc, connectionId = this.connectionId;
      void this.resolveElicitation(request.id, request.params)
        .then((outcome) => {
          try {
            if (this.proc !== proc || this.connectionId !== connectionId || !this.isConnected) return;
            commitMcpElicitation(outcome);
            this._sendJsonRpcResult(request.id, outcome);
          } finally { discardMcpElicitation(outcome); }
        })
        .catch((err: unknown) => {
          logger.warn('McpClient: elicitation resolver failed', {
            server: this.config.name,
            id: request.id,
            err: summarizeError(err),
          });
          // A resolver failure is not the same as an unsupported method, report
          // an internal error so the server can distinguish the two.
          if (this.proc === proc && this.connectionId === connectionId && this.isConnected && !this.connectionLife.signal.aborted)
            this._sendJsonRpcError(request.id, -32603, 'Elicitation request could not be resolved');
        });
      return;
    }

    logger.info('McpClient: received unsupported server JSON-RPC request', {
      server: this.config.name,
      method: request.method,
      id: request.id,
    });
    this._sendJsonRpcError(request.id, -32601, `Client method '${request.method}' is not supported`);
  }

  private _handleUnhandledResponse(response: JsonRpcResponse): void {
    const error = response.error
      ? `${response.error.code}: ${response.error.message}`
      : undefined;
    logger.warn('McpClient: received JSON-RPC response with no pending request', {
      server: this.config.name,
      id: response.id,
      hasError: response.error !== undefined,
      ...(error ? { error } : {}),
    });
    const observed: McpClientUnhandledResponse = {
      serverName: this.config.name,
      id: response.id,
      hasError: response.error !== undefined,
      ...(error ? { error } : {}),
    };
    this._callObserver('unhandled response', () => this.options?.onUnhandledResponse?.(observed));
  }

  private _sendJsonRpcError(id: JsonRpcId, code: number, message: string): void {
    if (!this.proc || !this.isConnected) return;
    try {
      const response: JsonRpcResponse = {
        jsonrpc: '2.0',
        id,
        error: { code, message },
      };
      (this.proc.stdin as import('bun').FileSink).write(JSON.stringify(response) + '\n');
    } catch (err) {
      logger.warn('McpClient: failed to send JSON-RPC error response', {
        server: this.config.name,
        id,
        err: summarizeError(err),
      });
    }
  }

  private _sendJsonRpcResult(id: JsonRpcId, result: unknown): void {
    if (!this.proc || !this.isConnected) return;
    try {
      const response: JsonRpcResponse = {
        jsonrpc: '2.0',
        id,
        result,
      };
      (this.proc.stdin as import('bun').FileSink).write(JSON.stringify(response) + '\n');
    } catch (err) {
      logger.warn('McpClient: failed to send JSON-RPC result response', {
        server: this.config.name,
        id,
        err: summarizeError(err),
      });
    }
  }

  private _callObserver(label: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      logger.warn(`McpClient: ${label} observer threw`, {
        server: this.config.name,
        err: summarizeError(err),
      });
    }
  }

  private _cancelRestart(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private _scheduleRestart(): void {
    this._cancelRestart();
    this.restartCount++;
    const delay = (this.options?.restartDelayMs ?? RESTART_DELAY_MS) * this.restartCount;
    logger.info('McpClient: scheduling restart', { server: this.config.name, attempt: this.restartCount, delayMs: delay });
    this.#phase = 'restart-wait';

    const timer = setTimeout(async () => {
      if (this.restartTimer === timer) this.restartTimer = null;
      if (this.intentionalClose) return; // Deliberately disconnected, do not restart
      // Already restarted by something else (a live process nobody reads is not a restart).
      if (this.proc && this.isConnected && this.readLoopProc === this.proc) return;
      try {
        await this._startProcess();
        await this._negotiate();
        // A restart only counts once the server has negotiated; a process that
        // spawns and then crashes must still run out of attempts.
        this.restartCount = 0;
        // The restarted server may advertise a changed tool list.
        this.#invalidateToolCatalog();
        this.#phase = 'ready';
        this.#lastError = null;
        logger.info('McpClient: restart successful', { server: this.config.name });
      } catch (err) {
        logger.error('McpClient: restart failed', { server: this.config.name, err: summarizeError(err) });
        this.#lastError = summarizeError(err);
        this._handleFailedRestart();
      }
    }, delay);
    timer.unref?.();
    this.restartTimer = timer;
  }

  /**
   * A restart attempt did not produce a negotiated server. Treat it like a crash:
   * a live but un-negotiated process is killed so the read loop's exit path
   * counts the attempt and either schedules the next one or gives up, leaving the
   * client disconnected. A process that already exited is handled by that same
   * path; only a failed spawn (no process at all) needs scheduling here.
   */
  private _handleFailedRestart(): void {
    if (this.intentionalClose) return;
    const proc = this.proc;
    if (proc) {
      try { proc.kill(); } catch { /* already gone; the read loop reports the exit */ }
      return;
    }
    if (this.restartCount < MAX_RESTART_ATTEMPTS) {
      this._scheduleRestart();
    } else {
      this.#phase = 'gave-up';
      logger.info('McpClient: exceeded max restart attempts', { server: this.config.name });
    }
  }

  /**
   * ping, Check whether the server answers at all, within a short bound.
   * The 2026-07-28 revision removed `ping`; modern-era servers are probed
   * with `server/discover` instead. Legacy servers keep the classic ping.
   */
  async ping(signal?: AbortSignal): Promise<boolean> {
    if (!this.isConnected) return false;
    const method = this.negotiated?.era === 'modern' ? 'server/discover' : 'ping';
    try {
      await this._request(method, {}, undefined, undefined, undefined, signal, PING_TIMEOUT_MS);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Answer a server-to-client JSON-RPC request arriving on a legacy HTTP SSE
   * stream. Elicitation routes to the wired resolver; everything else is
   * unsupported (the connection answers method-not-found for undefined).
   */
  private async _answerServerRequestOverHttp(id: JsonRpcId, method: string, params: unknown, operation?: ExternalOperationSource): Promise<unknown> {
    this._callObserver('server request', () => this.options?.onServerRequest?.({
      serverName: this.config.name,
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    }));
    const elicit = this.options?.onElicitation;
    if (method === 'elicitation/create' && elicit) {
      return this.resolveElicitation(id, params, operation);
    }
    return undefined;
  }
}
