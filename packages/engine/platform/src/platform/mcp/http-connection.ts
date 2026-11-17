import { executePolicyCheck } from '../gate/execute-policy-check.js';
import type { ExternalOperationSource } from '../permissions/external-request.js';
import { commitMcpElicitation, discardMcpElicitation } from './elicitation-autonomous.js';
import { snapshotJudgmentInput } from '../gate/judgment-input.js';
/**
 * Streamable HTTP connection for the MCP client.
 *
 * Speaks both eras of the transport:
 * - modern (2026-07-28+): stateless POST per request; MCP-Protocol-Version,
 *   Mcp-Method and Mcp-Name headers; per-request `_meta`; no sessions.
 * - legacy (2025-03-26..2025-11-25): initialize handshake, Mcp-Session-Id
 *   header, MCP-Protocol-Version header from 2025-06-18 onward.
 *
 * Era detection follows the specification: attempt a modern request first;
 * a recognized modern JSON-RPC error identifies a modern server (negotiate,
 * don't fall back); anything else falls back to the initialize handshake.
 * The era is cached for the lifetime of this connection (one origin).
 */
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { isRecord } from '../utils/record-coerce.js';
import { buildStandardRequestHeaders } from './http-headers.js';
import {
  buildModernMeta,
  isModernVersion,
  isRecognizedModernErrorCode,
  MCP_HTTP_VERSION_HEADER_SINCE,
  MCP_LEGACY_REVISIONS,
  MCP_STATELESS_REVISION,
  MCP_SUPPORTED_VERSIONS,
  parseDiscoverSupportedVersions,
  parseSupportedVersionsFromError,
  selectMutualVersion,
  withModernMeta,
  type McpClientIdentity,
  type McpNegotiatedProtocol,
} from './protocol.js';

/**
 * The server refused the request for its credentials (HTTP 401 or 403). `authType`
 * is the scheme its WWW-Authenticate header names (Bearer, Basic, ...), or
 * 'unknown' when it names none, so the owner is told what the server wants.
 */
export class McpHttpAuthError extends Error {
  readonly authType: string;
  constructor(serverName: string, method: string, readonly status: 401 | 403, challenge: string | null) {
    const scheme = challenge?.trim().split(/[\s,]/, 1)[0] ?? '';
    super(`MCP server '${serverName}': HTTP ${status} for '${method}': the server ${status === 401 ? 'wants credentials' : 'refused these credentials'}${scheme ? ` (${scheme})` : ''}. Set the server's credentials, then reconnect it.`);
    this.name = 'McpHttpAuthError';
    this.authType = scheme || 'unknown';
  }
}

export interface McpHttpServerMessageHandlers {
  /** Server-to-client notification observed on a response stream. */
  onNotification?: ((method: string, params?: unknown) => void) | undefined;
  /**
   * Server-to-client JSON-RPC request observed on a legacy SSE stream.
   * Return a result to answer it; throw (or return undefined) to have the
   * connection answer method-not-found.
   */
  onServerRequest?: ((id: number | string, method: string, params?: unknown, operation?: ExternalOperationSource) => Promise<unknown> | unknown) | undefined;
}

export interface McpHttpConnectionOptions {
  readonly serverName: string;
  readonly url: string;
  readonly clientInfo: McpClientIdentity;
  readonly clientCapabilities: Record<string, unknown>;
  readonly timeoutMs: number;
  /** Bound for each negotiation request (`server/discover`, `initialize`); 0 leaves them to `timeoutMs`. */
  readonly handshakeTimeoutMs?: number | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  /** Headers sent on every request, typically `Authorization`; a protocol header of the same name wins. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly handlers?: McpHttpServerMessageHandlers | undefined;
}

/** Thrown inside one attempt when an expired legacy session was renewed and the request must be sent again. */
const RESEND_ON_NEW_SESSION: unique symbol = Symbol('resend on the renewed MCP session');

type PostOptions = { era: 'modern' | 'legacy'; version: string; initialize?: boolean; extraHeaders?: Record<string, string>; operation?: ExternalOperationSource;
  beforeSend?: () => void; signal?: AbortSignal; timeoutMs?: number | undefined; resent?: boolean };

const SESSION_CLOSE_TIMEOUT_MS = 5_000;
/** A JSON-RPC answer larger than this is refused rather than buffered without limit. */
const MAX_JSON_RESPONSE_BYTES = 64 * 1024 * 1024;

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return response.json();
  // A stalled body keeps its read pending; cancelling on abort is what releases the stream.
  const release = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener('abort', release, { once: true });
  try {
    return await readJsonText(reader);
  } finally { signal.removeEventListener('abort', release); }
}

async function readJsonText(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<unknown> {
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_JSON_RESPONSE_BYTES) {
      void reader.cancel().catch(() => undefined);
      throw new Error(`MCP response body exceeds ${MAX_JSON_RESPONSE_BYTES} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
}

interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export class McpRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'McpRpcError';
  }
}

function parseJsonRpcError(body: unknown): JsonRpcErrorShape | null {
  if (!isRecord(body) || !isRecord(body.error)) return null;
  const { code, message } = body.error;
  if (typeof code !== 'number' || typeof message !== 'string') return null;
  return { code, message, data: body.error.data };
}

/** Parse `data:` payloads out of an SSE stream incrementally. */
class SseEventParser {
  private buffer = '';

  push(chunk: string): string[] {
    this.buffer += chunk;
    const events: string[] = [];
    let boundary: number;
    while ((boundary = this.buffer.search(/\r?\n\r?\n/)) !== -1) {
      const rawEvent = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
      const dataLines = rawEvent
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''));
      if (dataLines.length > 0) events.push(dataLines.join('\n'));
    }
    return events;
  }
}

export class McpHttpConnection {
  private negotiatedProtocol: McpNegotiatedProtocol | null = null;
  private sessionId: string | null = null;
  private closed = false;
  private nextId = 1;
  private sessionEpoch = 0;
  /** The session DELETE close() sent; null until one is sent. */
  private sessionEnd: Promise<void> | null = null;
  private readonly lifetime = new AbortController();
  /** The in-flight replacement of an expired legacy session, shared by every request that finds it expired. */
  #renewing: Promise<void> | undefined;

  constructor(private readonly options: McpHttpConnectionOptions) {}

  /** Monotonic session identity; a pending input response cannot cross a session replacement. */
  get sessionGeneration(): number { return this.sessionEpoch; }

  get isOpen(): boolean {
    return !this.closed && this.negotiatedProtocol !== null;
  }

  get negotiated(): McpNegotiatedProtocol | null {
    return this.negotiatedProtocol;
  }

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch;
  }

  /**
   * Detect the server's era and negotiate a protocol version.
   * Modern attempt first; recognized modern errors negotiate; anything else
   * falls back to the legacy initialize handshake.
   */
  async negotiate(): Promise<McpNegotiatedProtocol> {
    if (this.negotiatedProtocol) return this.negotiatedProtocol;
    let modernOutcome: { supported: string[] } | 'legacy';
    try {
      const result = await this.postAndParse('server/discover', withModernMeta({}, this.modernMeta(MCP_STATELESS_REVISION)), {
        era: 'modern',
        version: MCP_STATELESS_REVISION,
        timeoutMs: this.options.handshakeTimeoutMs,
      });
      const supported = parseDiscoverSupportedVersions(result) ?? [MCP_STATELESS_REVISION];
      modernOutcome = { supported };
    } catch (err) {
      if (err instanceof McpRpcError && isRecognizedModernErrorCode(err.code)) {
        // A modern server that rejected our preferred version: negotiate.
        const supported = parseSupportedVersionsFromError(err.data);
        if (!supported) {
          throw new Error(`MCP server '${this.options.serverName}' rejected protocol version ${MCP_STATELESS_REVISION} without advertising supported versions: ${err.message}`);
        }
        modernOutcome = { supported };
      } else {
        modernOutcome = 'legacy';
      }
    }

    if (modernOutcome !== 'legacy') {
      const mutual = selectMutualVersion(modernOutcome.supported);
      if (!mutual) {
        throw new Error(
          `MCP server '${this.options.serverName}' shares no protocol version with this client `
          + `(server: ${modernOutcome.supported.join(', ')}; client: ${MCP_SUPPORTED_VERSIONS.join(', ')})`,
        );
      }
      if (isModernVersion(mutual)) {
        this.negotiatedProtocol = { era: 'modern', version: mutual, transport: 'http' };
        return this.negotiatedProtocol;
      }
      // Dual-era server whose newest mutual version is handshake-based.
    }

    return this.negotiateLegacy();
  }

  private renewSession(expired: string): Promise<void> {
    if (this.sessionId !== expired) return this.#renewing ?? Promise.resolve();
    this.#renewing ??= (async () => {
      this.sessionId = null; this.sessionEpoch++;
      try { await this.negotiateLegacy(); }
      finally { this.#renewing = undefined; }
    })();
    return this.#renewing;
  }

  private async negotiateLegacy(): Promise<McpNegotiatedProtocol> {
    const requested = MCP_LEGACY_REVISIONS[0];
    const result = await this.postAndParse('initialize', {
      protocolVersion: requested,
      capabilities: this.options.clientCapabilities,
      clientInfo: this.options.clientInfo,
    }, { era: 'legacy', version: requested, initialize: true, timeoutMs: this.options.handshakeTimeoutMs });
    const serverVersion = isRecord(result) && typeof result.protocolVersion === 'string'
      ? result.protocolVersion
      : requested;
    if (!MCP_SUPPORTED_VERSIONS.includes(serverVersion)) {
      throw new Error(`MCP server '${this.options.serverName}' negotiated unsupported protocol version ${serverVersion} (client supports: ${MCP_SUPPORTED_VERSIONS.join(', ')})`);
    }
    this.negotiatedProtocol = { era: 'legacy', version: serverVersion, transport: 'http' };
    await this.notify('notifications/initialized', {});
    return this.negotiatedProtocol;
  }

  /** Send a request and return its JSON-RPC result. */
  async request(method: string, params: unknown, extraHeaders?: Record<string, string>, operation?: ExternalOperationSource, beforeSend?: () => void, signal?: AbortSignal, timeoutMs?: number): Promise<unknown> {
    if (this.#renewing) await this.#renewing.catch(() => {});
    const negotiated = this.negotiatedProtocol;
    if (!negotiated) throw new Error(`MCP server '${this.options.serverName}': not connected`);
    const finalParams = negotiated.era === 'modern'
      ? withModernMeta(params, this.modernMeta(negotiated.version))
      : params;
    return this.postAndParse(method, finalParams, {
      era: negotiated.era,
      version: negotiated.version,
      ...(extraHeaders ? { extraHeaders } : {}),
      ...(operation ? { operation } : {}), ...(beforeSend ? { beforeSend } : {}),
      ...(signal ? { signal } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  }

  /** Send a notification (expects 202, no body). */
  async notify(method: string, params: unknown): Promise<void> {
    const negotiated = this.negotiatedProtocol;
    const era = negotiated?.era ?? 'legacy';
    const version = negotiated?.version ?? MCP_LEGACY_REVISIONS[0];
    const body = { jsonrpc: '2.0', method, params };
    try {
      await this.post(body, { era, version, method, params });
    } catch (err) {
      logger.warn('McpHttpConnection: failed to send notification', {
        server: this.options.serverName,
        method,
        err: summarizeError(err),
      });
    }
  }

  /**
   * Best-effort session termination (legacy sessions only). The DELETE is sent
   * but not awaited: its answer changes nothing here, so a reconnect or reload
   * never waits on a slow server. It is still bounded so a server that never
   * answers does not hold the request open. A shutdown, after which the process
   * exits, waits on sessionEnded() briefly so the request leaves at all.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.lifetime.abort();
    this.sessionEpoch++;
    const sessionId = this.sessionId;
    if (!sessionId) return;
    this.sessionId = null;
    this.sessionEnd = Promise.resolve().then(() => this.fetchImpl(this.options.url, {
      method: 'DELETE',
      headers: this.withConfiguredHeaders({ 'Mcp-Session-Id': sessionId }),
      signal: AbortSignal.timeout(SESSION_CLOSE_TIMEOUT_MS),
    })).then(
      async (response) => { await response.body?.cancel().catch(() => undefined); },
      // The server may not support DELETE, or may not answer in time.
      () => undefined,
    );
  }

  /** Settles once the session DELETE sent by close() is answered or given up; at once when none was sent. Never rejects. */
  sessionEnded(): Promise<void> {
    return this.sessionEnd ?? Promise.resolve();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private modernMeta(version: string): Record<string, unknown> {
    return buildModernMeta(version, this.options.clientInfo, this.options.clientCapabilities);
  }

  private buildHeaders(input: {
    era: 'modern' | 'legacy';
    version: string;
    method: string;
    params: unknown;
    initialize?: boolean | undefined;
    extraHeaders?: Record<string, string> | undefined;
  }): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (input.era === 'modern') {
      headers['MCP-Protocol-Version'] = input.version;
      Object.assign(headers, buildStandardRequestHeaders(input.method, input.params));
    } else {
      // The version header exists from 2025-06-18 on and is not sent on the
      // initialize request itself (the version is not negotiated yet).
      if (!input.initialize && input.version >= MCP_HTTP_VERSION_HEADER_SINCE) {
        headers['MCP-Protocol-Version'] = input.version;
      }
      if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    }
    if (input.extraHeaders) Object.assign(headers, input.extraHeaders);
    return this.withConfiguredHeaders(headers);
  }

  /** Configured headers fill in around the protocol's own; the protocol never loses a header to a same-named (any case) configured one. */
  private withConfiguredHeaders(headers: Record<string, string>): Record<string, string> {
    const taken = new Set(Object.keys(headers).map((name) => name.toLowerCase()));
    for (const [name, value] of Object.entries(this.options.headers ?? {})) {
      if (!taken.has(name.toLowerCase())) headers[name] = value;
    }
    return headers;
  }

  private async postAndParse(method: string, params: unknown, options: PostOptions): Promise<unknown> {
    try {
      return await this.postAndParseOnce(method, params, options);
    } catch (error) {
      if (error !== RESEND_ON_NEW_SESSION) throw error;
      // The 404 establishes the request was not run, so it is sent once more on the new session.
      return this.postAndParseOnce(method, params, { ...options, resent: true });
    }
  }

  private async postAndParseOnce(
    method: string,
    params: unknown,
    options: PostOptions,
  ): Promise<unknown> {
    const id = this.nextId++;
    const body = { jsonrpc: '2.0', id, method, params };
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal, ...(options.signal ? [options.signal] : []), ...(options.operation?.signal ? [options.operation.signal] : [])]);
    const timeoutMs = options.timeoutMs || this.options.timeoutMs;
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(new Error(`MCP server '${this.options.serverName}': request '${method}' gave no answer within ${timeoutMs}ms`)), timeoutMs) : undefined;
    timer?.unref?.();
    let response: Response | undefined;
    const sessionAtSend = this.sessionId;
    try {
      response = await this.post(body, { ...options, method, params, signal });

      if (response.status === 202) {
        throw new Error(`MCP server '${this.options.serverName}': request '${method}' was accepted as a notification (202) instead of answered`);
      }
      if (!response.ok) {
        // A 404 on a session id means the session ended, whatever the body says: reference servers
        // answer it with a JSON-RPC "Session not found" error, which must not mask the renewal.
        if (response.status === 404 && sessionAtSend && options.era === 'legacy' && !options.initialize) {
          await this.renewSession(sessionAtSend);
          if (!options.resent) throw RESEND_ON_NEW_SESSION;
          throw new Error(`MCP server '${this.options.serverName}': its session expired again (HTTP 404 for '${method}') right after it was renewed; the request was not run. Check the server, then call again.`);
        }
        if (response.status === 401 || response.status === 403) {
          throw new McpHttpAuthError(this.options.serverName, method, response.status, response.headers.get('www-authenticate'));
        }
        const errorBody = await executePolicyCheck(() => readBoundedJson(response!, signal), signal).catch(() => { signal.throwIfAborted(); return null; });
        const rpcError = parseJsonRpcError(errorBody);
        if (rpcError) throw new McpRpcError(rpcError.code, rpcError.message, rpcError.data);
        throw new Error(`MCP server '${this.options.serverName}': HTTP ${response.status} for '${method}'`);
      }

      this.lifetime.signal.throwIfAborted();
      this.captureSessionId(response);
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('text/event-stream')) {
        return await this.readSseResponse(response, id, method, options.operation, signal);
      }
      const parsed: unknown = await executePolicyCheck(() => readBoundedJson(response!, signal), signal);
      return this.resolveJsonRpcResponse(parsed, method);
    } catch (error) {
      if (signal.aborted && !this.lifetime.signal.aborted && options.era === 'legacy' && !options.initialize) {
        // Timed out or aborted while the server may still be working: say so, so a slow write is not left running.
        void this.notify('notifications/cancelled', { requestId: id, reason: 'request timed out or was aborted' });
      }
      signal.throwIfAborted();
      throw error;
    } finally {
      clearTimeout(timer);
      controller.abort();
      void response?.body?.cancel().catch(() => {});
    }
  }

  private async post(
    body: unknown,
    options: { era: 'modern' | 'legacy'; version: string; method: string; params: unknown; initialize?: boolean; extraHeaders?: Record<string, string>; operation?: ExternalOperationSource; beforeSend?: () => void; signal?: AbortSignal },
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = !options.signal && this.options.timeoutMs > 0 ? setTimeout(() => controller.abort(), this.options.timeoutMs) : undefined;
    timer?.unref?.();
    try {
      const headers = this.buildHeaders(options);
      const serialized = JSON.stringify(body);
      const signal = AbortSignal.any([controller.signal, this.lifetime.signal, ...(options.signal ? [options.signal] : []), ...(options.operation?.signal ? [options.operation.signal] : [])]);
      signal.throwIfAborted();
      options.operation?.assertCurrent();
      options.beforeSend?.();
      return await executePolicyCheck(() => this.fetchImpl(this.options.url, {
        method: 'POST', headers, body: serialized, signal,
      }), signal);
    } finally {
      clearTimeout(timer);
    }
  }

  private captureSessionId(response: Response): void {
    const session = response.headers.get('mcp-session-id');
    if (session && session !== this.sessionId) { this.sessionEpoch++; this.sessionId = session; }
  }

  private resolveJsonRpcResponse(message: unknown, method: string): unknown {
    if (!isRecord(message)) {
      throw new Error(`MCP server '${this.options.serverName}': non-object JSON-RPC response for '${method}'`);
    }
    const rpcError = parseJsonRpcError(message);
    if (rpcError) throw new McpRpcError(rpcError.code, rpcError.message, rpcError.data);
    return message.result;
  }

  private async readSseResponse(response: Response, requestId: number, method: string, operation?: ExternalOperationSource, requestSignal?: AbortSignal): Promise<unknown> {
    const bodyStream = response.body;
    if (!bodyStream) throw new Error(`MCP server '${this.options.serverName}': empty SSE body for '${method}'`);
    const streamLife = new AbortController();
    const epoch = this.sessionEpoch;
    const signal = AbortSignal.any([this.lifetime.signal, streamLife.signal, ...(requestSignal ? [requestSignal] : []), ...(operation?.signal ? [operation.signal] : [])]);
    const assertCurrent = () => { signal.throwIfAborted(); operation?.assertCurrent(); if (this.sessionEpoch !== epoch) throw new Error('MCP HTTP session changed'); };
    const boundOperation = operation ? { ...operation, signal, assertCurrent } : undefined;
    const reader = bodyStream.getReader();
    const decoder = new TextDecoder();
    const parser = new SseEventParser();
    try {
      while (true) {
        const { done, value } = await executePolicyCheck(() => reader.read(), signal);
        if (done) break;
        for (const payload of parser.push(decoder.decode(value, { stream: true }))) {
          let message: unknown;
          try {
            message = JSON.parse(payload);
          } catch {
            logger.warn('McpHttpConnection: unparseable SSE event', { server: this.options.serverName });
            continue;
          }
          if (!isRecord(message)) continue;
          if (message.id === requestId && !('method' in message)) {
            return this.resolveJsonRpcResponse(message, method);
          }
          this.dispatchStreamMessage(message, boundOperation);
        }
      }
    } finally {
      streamLife.abort();
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    throw new Error(`MCP server '${this.options.serverName}': SSE stream for '${method}' ended without a response`);
  }

  private dispatchStreamMessage(message: Record<string, unknown>, operation?: ExternalOperationSource): void {
    const method = typeof message.method === 'string' ? message.method : null;
    if (!method) return;
    const id = message.id;
    if (typeof id === 'number' || typeof id === 'string') {
      // Legacy servers may send JSON-RPC requests on SSE streams; answer via POST.
      void this.answerServerRequest(id, method, message.params, operation);
      return;
    }
    try {
      this.options.handlers?.onNotification?.(method, message.params);
    } catch (err) {
      logger.warn('McpHttpConnection: notification observer threw', {
        server: this.options.serverName,
        err: summarizeError(err),
      });
    }
  }

  private async answerServerRequest(id: number | string, method: string, params: unknown, operation?: ExternalOperationSource): Promise<void> {
    const negotiated = this.negotiatedProtocol;
    const era = negotiated?.era ?? 'legacy';
    const version = negotiated?.version ?? MCP_LEGACY_REVISIONS[0];
    const epoch = this.sessionEpoch, destination = this.options.url;
    const assertCurrent = () => { this.lifetime.signal.throwIfAborted(); operation?.assertCurrent();
      if (this.closed || this.sessionEpoch !== epoch || this.options.url !== destination) throw new Error('MCP HTTP request owner changed'); };
    let outcome: unknown;
    let body: Record<string, unknown>;
    let readable = false;
    try {
      const handler = this.options.handlers?.onServerRequest;
      const ownedParams = snapshotJudgmentInput(params);
      readable = true;
      assertCurrent();
      const result = handler ? await handler(id, method, ownedParams, operation) : undefined;
      outcome = result;
      assertCurrent();
      body = result === undefined
        ? { jsonrpc: '2.0', id, error: { code: -32601, message: `Client method '${method}' is not supported` } }
        : { jsonrpc: '2.0', id, result };
    } catch (err) {
      body = readable
        ? { jsonrpc: '2.0', id, error: { code: -32603, message: 'MCP input request could not be resolved' } }
        : { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid request: the client could not read its parameters' } };
    }
    try {
      assertCurrent();
      await this.post(body, { era, version, method, params, beforeSend() { assertCurrent(); commitMcpElicitation(outcome); } });
    } catch (err) {
      logger.warn('McpHttpConnection: failed to answer server request', {
        server: this.options.serverName,
        method,
        err: summarizeError(err),
      });
    } finally { discardMcpElicitation(outcome); }
  }
}

