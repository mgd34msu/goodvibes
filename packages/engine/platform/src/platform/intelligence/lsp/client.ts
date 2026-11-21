import { logger } from '../../utils/logger.js';
import type { JsonRpcRequest, JsonRpcResponse, JsonRpcNotification, Diagnostic } from './protocol.js';
import type { LspCapabilities } from './capabilities.js';
import { summarizeError } from '../../utils/error-display.js';
import type { ChildHandle } from '../../utils/owned-work.js';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** A request the server did not answer within its time limit. */
export class LspRequestTimeoutError extends Error {
  constructor(readonly method: string, readonly timeoutMs: number) {
    super(`LspClient: request '${method}' timed out after ${timeoutMs}ms`);
    this.name = 'LspRequestTimeoutError';
  }
}

/** The newest diagnostics the server published for one document. */
interface PublishedDiagnostics {
  readonly version: number | undefined;
  /** Notification sequence number it arrived at. */
  readonly seq: number;
  readonly diagnostics: Diagnostic[];
}

interface DiagnosticsWaiter {
  readonly uri: string;
  readonly version: number;
  readonly afterSeq: number;
  /** A publication without a version that may yet be followed by a fuller one. */
  offer(diagnostics: Diagnostic[]): void;
  resolve(diagnostics: Diagnostic[] | null): void;
}

/** What a sync told the server, so a diagnostics wait can match the answer. */
export interface DocumentSync {
  readonly version: number;
  /** Notification sequence at the moment this text was sent (the earlier send when the text is unchanged). */
  readonly sentAtSeq: number;
}

/** An open document: the text the server has, its version, and the notification sequence it was sent at. */
interface OpenDocument {
  readonly text: string;
  readonly version: number;
  readonly sentAtSeq: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** Documents one server is told about at once; the least recently used is closed past this. */
const MAX_OPEN_DOCUMENTS = 64;
/**
 * A server that does not stamp diagnostics with a version may publish them in
 * stages (syntax, then types); the answer is the newest publication once none
 * has followed it for this long.
 */
const DIAGNOSTICS_SETTLE_MS = 400;
/** Server stderr kept for a start-failure message; the rest goes to the debug log. */
const STDERR_TAIL_BYTES = 2048;

export class LspClient {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private nextId = 1;
  private pendingRequests: Map<number, PendingRequest> = new Map();
  /** Raw stdout bytes not yet framed; Content-Length counts bytes, so framing happens before decoding. */
  private buffer: Uint8Array = new Uint8Array(0);
  private readLoopRunning = false;
  /** Opened documents in least-recently-used order (a Map keeps insertion order). */
  private readonly documents = new Map<string, OpenDocument>();
  private readonly published = new Map<string, PublishedDiagnostics>();
  private readonly diagnosticsWaiters = new Set<DiagnosticsWaiter>();
  private notificationSeq = 0;
  private stderrTail = '';
  /** What the server said it can do, from its initialize answer. Null until then. */
  capabilities: LspCapabilities | null = null;

  constructor(
    private command: string,
    private args: string[],
    private options?: { cwd?: string | undefined; env?: Record<string, string>; timeout?: number },
  ) {}

  /** Start the LSP server process. */
  async start(): Promise<void> {
    if (this.proc) return;
    try {
      this.proc = Bun.spawn([this.command, ...this.args], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        ...(this.options?.cwd !== undefined ? { cwd: this.options.cwd } : {}),
        ...(this.options?.env !== undefined ? { env: { ...process.env, ...this.options.env } } : {}),
      } as Parameters<typeof Bun.spawn>[1]);
      this._startReadLoop();
      this._drainStderr();
    } catch (err) {
      logger.error('LspClient: failed to start process', { command: this.command, err: summarizeError(err) });
      this.proc = null;
      throw err;
    }
  }

  /** The last lines the server wrote to stderr, for a failure message. */
  get recentStderr(): string {
    return this.stderrTail.trim();
  }

  /** Send a request and wait for response. */
  async request<T = unknown>(method: string, params?: unknown, options?: { timeoutMs?: number | undefined }): Promise<T> {
    if (!this.proc || !this.isRunning) {
      throw new Error('LspClient: server is not running');
    }
    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    const json = JSON.stringify(msg);
    const frame = LspClient.encodeFrame(json);

    return new Promise<T>((resolve, reject) => {
      const timeoutMs = options?.timeoutMs ?? this.options?.timeout ?? DEFAULT_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new LspRequestTimeoutError(method, timeoutMs));
      }, timeoutMs);
      timer.unref?.();

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      try {
        (this.proc?.stdin as import('bun').FileSink | undefined)?.write(frame);
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(new Error(`LspClient: failed to write request: ${summarizeError(err)}`));
      }
    });
  }

  /** Send a notification (no response expected). */
  notify(method: string, params?: unknown): void {
    if (!this.proc || !this.isRunning) return;
    try {
      const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params };
      const json = JSON.stringify(msg);
      const frame = LspClient.encodeFrame(json);
      (this.proc.stdin as import('bun').FileSink).write(frame);
    } catch (err) {
      logger.error('LspClient: failed to send notification', { method, err: summarizeError(err) });
    }
  }

  /**
   * Tell the server about a document before asking it anything about it: a
   * server answers only for documents it was opened with. Sends the text once,
   * and again (as a full change) when it differs from what the server has.
   * Past {@link MAX_OPEN_DOCUMENTS} the least recently used document is closed,
   * so neither process holds every file a long session touched.
   */
  syncDocument(uri: string, languageId: string, text: string): DocumentSync {
    const known = this.documents.get(uri);
    const sentAtSeq = this.notificationSeq;
    if (known) {
      this.documents.delete(uri);
      if (known.text === text) {
        this.documents.set(uri, known);
        return { version: known.version, sentAtSeq: known.sentAtSeq };
      }
      const version = known.version + 1;
      this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
      this.documents.set(uri, { text, version, sentAtSeq });
      return { version, sentAtSeq };
    }
    this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text } });
    this.documents.set(uri, { text, version: 1, sentAtSeq });
    while (this.documents.size > MAX_OPEN_DOCUMENTS) {
      const oldest = this.documents.keys().next().value;
      if (oldest === undefined) break;
      this.documents.delete(oldest);
      this.published.delete(oldest);
      this.notify('textDocument/didClose', { textDocument: { uri: oldest } });
    }
    return { version: 1, sentAtSeq };
  }

  /**
   * The diagnostics the server publishes for `sync`'s text, waiting at most
   * `timeoutMs`. A server that stamps its notification with a version is
   * matched on it. For one that does not, the answer is the newest
   * publication after the text was sent once {@link DIAGNOSTICS_SETTLE_MS}
   * pass without another. A publication already held answers at once when it
   * is for this text: stamped with its version, or version-less and received
   * after the text was sent. Null when none arrived in time.
   */
  waitForDiagnostics(uri: string, sync: DocumentSync, timeoutMs: number): Promise<Diagnostic[] | null> {
    const current = this.published.get(uri);
    if (current && (current.version === sync.version || (current.version === undefined && current.seq > sync.sentAtSeq))) {
      return Promise.resolve(current.diagnostics);
    }
    if (!this.isRunning) return Promise.resolve(null);
    return new Promise((resolve) => {
      let latest: Diagnostic[] | null = null;
      let settle: ReturnType<typeof setTimeout> | undefined;
      const waiter: DiagnosticsWaiter = {
        uri,
        version: sync.version,
        afterSeq: sync.sentAtSeq,
        offer: (diagnostics) => {
          latest = diagnostics;
          if (settle) clearTimeout(settle);
          settle = setTimeout(() => waiter.resolve(latest), DIAGNOSTICS_SETTLE_MS);
          settle.unref?.();
        },
        resolve: (diagnostics) => {
          clearTimeout(deadline);
          if (settle) clearTimeout(settle);
          this.diagnosticsWaiters.delete(waiter);
          resolve(diagnostics);
        },
      };
      // At the deadline a version-less server's newest answer still beats none.
      const deadline = setTimeout(() => waiter.resolve(latest), timeoutMs);
      deadline.unref?.();
      this.diagnosticsWaiters.add(waiter);
    });
  }

  /**
   * Stop the server process: close its input and send `signal` (SIGTERM by
   * default; SIGKILL for a server that has nothing to save, such as one that
   * failed its handshake).
   */
  async stop(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    if (!this.proc) return;
    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('LspClient: server stopped'));
      this.pendingRequests.delete(id);
    }
    for (const waiter of [...this.diagnosticsWaiters]) waiter.resolve(null);
    try {
      (this.proc.stdin as import('bun').FileSink).end();
      this.proc.kill(signal);
      await this.proc.exited;
    } catch (err) {
      logger.warn('LspClient: shutdown cleanup failed', { err: summarizeError(err) });
    } finally {
      this.proc = null;
      this.buffer = new Uint8Array(0);
      this.documents.clear();
      this.published.clear();
      this.readLoopRunning = false;
    }
  }

  /** The newest diagnostics the server published for each open document, keyed by document URI. */
  publishedDiagnostics(): ReadonlyMap<string, readonly Diagnostic[]> {
    const out = new Map<string, readonly Diagnostic[]>();
    for (const [uri, entry] of this.published) out.set(uri, entry.diagnostics);
    return out;
  }

  /** The server process, for an owner that must see it exit (null before start or after stop). */
  get child(): ChildHandle | null {
    const proc = this.proc;
    return proc ? { pid: proc.pid, kill: signal => proc.kill(signal), exited: proc.exited } : null;
  }

  /** Is the server running? */
  get isRunning(): boolean {
    if (!this.proc) return false;
    // Bun.spawn process: check exitCode, null means still running
    try {
      return (this.proc as { exitCode: number | null }).exitCode === null;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _startReadLoop(): void {
    if (this.readLoopRunning || !this.proc) return;
    this.readLoopRunning = true;

    const proc = this.proc;

    (async () => {
      try {
        const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          this.buffer = concatBytes(this.buffer, value);
          this._processBuffer();
        }
      } catch (err) {
        logger.warn('LspClient: stdout read loop failed', { err: summarizeError(err) });
      } finally {
        this.readLoopRunning = false;
        // Reject any remaining pending requests
        for (const [id, pending] of this.pendingRequests) {
          clearTimeout(pending.timer);
          pending.reject(new Error('LspClient: server process exited unexpectedly'));
          this.pendingRequests.delete(id);
        }
        for (const waiter of [...this.diagnosticsWaiters]) waiter.resolve(null);
      }
    })();
  }

  /**
   * Read the server's stderr for as long as it runs. A pipe nobody reads fills
   * and blocks the server on its next write, after which every request times
   * out. Lines go to the debug log; the last few are kept for failure messages.
   */
  private _drainStderr(): void {
    const proc = this.proc;
    const stream = proc?.stderr;
    if (!stream || typeof stream === 'number') return;
    const command = this.command;
    (async () => {
      const decoder = new TextDecoder();
      try {
        const reader = (stream as ReadableStream<Uint8Array>).getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_BYTES);
          logger.debug('LspClient: server stderr', { command, text: text.slice(0, 500) });
        }
      } catch (err) {
        logger.debug('LspClient: stderr read ended', { command, err: summarizeError(err) });
      }
    })();
  }

  private _processBuffer(): void {
    const { bodies, rest } = takeFrames(this.buffer);
    this.buffer = rest;
    for (const body of bodies) this._dispatchMessage(body);
  }

  private _dispatchMessage(body: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(body);
    } catch (err) {
      logger.error('LspClient: failed to parse JSON-RPC message', { err: summarizeError(err), body: body.slice(0, 200) });
      return;
    }

    if (typeof msg !== 'object' || msg === null) {
      logger.warn('LspClient: received malformed JSON-RPC payload', { payloadType: typeof msg });
      return;
    }

    // A message with both `method` and `id` is the server asking the client for
    // something, not an answer. Its id is the server's own and may equal one of
    // ours, so it must never be matched against pending requests.
    const asked = msg as { id?: unknown; method?: unknown; params?: unknown };
    if (typeof asked.method === 'string' && (typeof asked.id === 'number' || typeof asked.id === 'string')) {
      this._answerServerRequest(asked.id, asked.method, asked.params);
      return;
    }

    const response = msg as JsonRpcResponse;
    if ('id' in response && typeof response.id === 'number') {
      const pending = this.pendingRequests.get(response.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(response.id);
        if (response.error) {
          pending.reject(new Error(`LSP error ${response.error.code}: ${response.error.message}`));
        } else {
          pending.resolve(response.result);
        }
      } else {
        logger.warn('LspClient: received response for unknown request id', { id: response.id });
      }
      return;
    }

    const notification = msg as JsonRpcNotification;
    if (notification.jsonrpc === '2.0' && typeof notification.method === 'string') {
      this.notificationSeq += 1;
      if (notification.method === 'textDocument/publishDiagnostics') this._takeDiagnostics(notification.params);
      // Every other notification (progress, log and show messages) has no
      // reader in this client and is dropped rather than kept.
      return;
    }

    logger.warn('LspClient: received unrecognized JSON-RPC message', { message: msg });
  }

  /** Keep the newest diagnostics for an open document and wake whoever waits for them. */
  private _takeDiagnostics(params: unknown): void {
    if (typeof params !== 'object' || params === null) return;
    const { uri, version, diagnostics } = params as { uri?: unknown; version?: unknown; diagnostics?: unknown };
    if (typeof uri !== 'string' || !Array.isArray(diagnostics) || !this.documents.has(uri)) return;
    const entry: PublishedDiagnostics = {
      version: typeof version === 'number' ? version : undefined,
      seq: this.notificationSeq,
      diagnostics: diagnostics as Diagnostic[],
    };
    this.published.set(uri, entry);
    for (const waiter of [...this.diagnosticsWaiters]) {
      if (waiter.uri !== uri) continue;
      if (entry.version === waiter.version) waiter.resolve(entry.diagnostics);
      else if (entry.version === undefined && entry.seq > waiter.afterSeq) waiter.offer(entry.diagnostics);
    }
  }

  /**
   * Answer a server-to-client request. This client offers no workspace
   * features, so the answer is empty: null, or one null per configuration item.
   */
  private _answerServerRequest(id: number | string, method: string, params: unknown): void {
    const items = (params as { items?: unknown } | null | undefined)?.items;
    const result = method === 'workspace/configuration' && Array.isArray(items) ? items.map(() => null) : null;
    try {
      const frame = LspClient.encodeFrame(JSON.stringify({ jsonrpc: '2.0', id, result }));
      (this.proc?.stdin as import('bun').FileSink | undefined)?.write(frame);
    } catch (err) {
      logger.warn('LspClient: failed to answer a server request', { method, err: summarizeError(err) });
    }
  }

  /** Encode a JSON-RPC frame (Content-Length framing). Exposed for testing. */
  static encodeFrame(json: string): string {
    const bytes = Buffer.byteLength(json, 'utf-8');
    return `Content-Length: ${bytes}\r\n\r\n${json}`;
  }

  /** Parse all complete JSON-RPC messages from a buffer string. Returns [messages, remainingBuffer]. */
  static parseMessages(buffer: string): [unknown[], string] {
    const { bodies, rest } = takeFrames(new TextEncoder().encode(buffer));
    const messages: unknown[] = [];
    for (const body of bodies) {
      try {
        messages.push(JSON.parse(body));
      } catch {
        // skip malformed
      }
    }
    return [messages, new TextDecoder().decode(rest)];
  }
}

const HEADER_TERMINATOR = [13, 10, 13, 10];

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left, 0);
  joined.set(right, left.length);
  return joined;
}

function indexOfTerminator(bytes: Uint8Array): number {
  outer: for (let index = 0; index + HEADER_TERMINATOR.length <= bytes.length; index += 1) {
    for (let offset = 0; offset < HEADER_TERMINATOR.length; offset += 1) {
      if (bytes[index + offset] !== HEADER_TERMINATOR[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

/**
 * Splits complete Content-Length frames off the front of a byte buffer. The
 * length is a byte count (LSP base protocol), so the body is cut from the raw
 * bytes and only then decoded as UTF-8; a body with multi-byte characters is
 * cut exactly where the header says.
 */
function takeFrames(buffer: Uint8Array): { bodies: string[]; rest: Uint8Array } {
  const decoder = new TextDecoder();
  const bodies: string[] = [];
  let rest = buffer;
  for (;;) {
    const headerEnd = indexOfTerminator(rest);
    if (headerEnd === -1) break;
    const header = decoder.decode(rest.subarray(0, headerEnd));
    const contentLengthMatch = header.match(/Content-Length:\s*(\d+)/i);
    const bodyStart = headerEnd + HEADER_TERMINATOR.length;
    if (!contentLengthMatch) {
      // Malformed header, skip to the next boundary.
      rest = rest.subarray(bodyStart);
      continue;
    }
    const bodyEnd = bodyStart + parseInt(contentLengthMatch[1]!, 10);
    if (rest.length < bodyEnd) break;
    bodies.push(decoder.decode(rest.subarray(bodyStart, bodyEnd)));
    rest = rest.subarray(bodyEnd);
  }
  return { bodies, rest: rest.slice() };
}
