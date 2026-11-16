/**
 * McpLifecycleManager, the one owner of each MCP server's connection state
 * and of reconnecting a server that dropped.
 *
 * The MCP registry composes one and reports every connect outcome to it. The
 * manager holds the state machine (lifecycle.ts), schedules reconnect attempts
 * with exponential back-off, gives up after a bounded number of attempts, and
 * emits the MCP lifecycle events. It never opens a connection itself: each
 * attempt goes through the connector it was given, so a reconnect passes the
 * same admission, sandbox and permission checks as the first connect.
 *
 * Nothing here runs on the tool-call path: the registry asks the manager only
 * when a connect starts, succeeds or fails, a server drops, or a status
 * surface or refusal needs the reconnect state.
 */
import { logger } from '../../utils/logger.js';
import type { McpEvent } from '../../../events/mcp.js';
import { applyTransition, canTransition, isOperational } from './lifecycle.js';
import type { McpReconnectConfig, McpReconnectStatus, McpServerEntry, McpServerState } from './types.js';
import { DEFAULT_RECONNECT_CONFIG } from './types.js';
import { summarizeError } from '../../utils/error-display.js';

/** Callback type for state-change notifications. */
export type McpEventHandler = (event: McpEvent) => void;

/**
 * Starts one connect attempt for a server. Resolves false when the server is
 * no longer configured (nothing was started). The attempt's outcome comes back
 * through `connected` or `failed`; a rejection means the attempt was cancelled
 * or could not clean up, and counts as a failed attempt.
 */
export type McpLifecycleConnector = (serverName: string) => Promise<boolean>;

/** Options for constructing a McpLifecycleManager. */
export interface McpLifecycleManagerOptions {
  /** Opens the connection for one attempt. */
  readonly connector: McpLifecycleConnector;
  /** Reconnect back-off configuration. Defaults to DEFAULT_RECONNECT_CONFIG. */
  readonly reconnect?: Partial<McpReconnectConfig> | undefined;
  /** Read when a server drops and before each attempt: whether to reconnect automatically. Defaults to always. */
  readonly enabled?: (() => boolean) | undefined;
  /** Ends every scheduled reconnect for good once aborted. */
  readonly signal?: AbortSignal | undefined;
  /** Receives every lifecycle event. */
  readonly onEvent?: McpEventHandler | undefined;
}

interface TrackedServer {
  readonly entry: McpServerEntry;
  /** Bumped by every request, failure, stop and forget, so a superseded timer or attempt does nothing. */
  generation: number;
  timer?: ReturnType<typeof setTimeout> | undefined;
}

/** The setting that turns automatic reconnect on and off, named in what the user is told. */
const RECONNECT_SETTING = 'runtime.mcpLifecycle';

export class McpLifecycleManager {
  readonly #servers = new Map<string, TrackedServer>();
  readonly #config: McpReconnectConfig;
  readonly #connector: McpLifecycleConnector;
  readonly #enabled: () => boolean;
  readonly #signal: AbortSignal | undefined;
  readonly #handlers: McpEventHandler[] = [];

  constructor(options: McpLifecycleManagerOptions) {
    this.#config = { ...DEFAULT_RECONNECT_CONFIG, ...options.reconnect };
    this.#connector = options.connector;
    this.#enabled = options.enabled ?? (() => true);
    this.#signal = options.signal;
    if (options.onEvent) this.#handlers.push(options.onEvent);
    this.#signal?.addEventListener('abort', () => this.stopAll('automatic reconnect was cancelled'), { once: true });
  }

  /** Register an event handler called on every lifecycle transition. Returns the unsubscribe. */
  onEvent(handler: McpEventHandler): () => void {
    this.#handlers.push(handler);
    return () => {
      const index = this.#handlers.indexOf(handler);
      if (index >= 0) this.#handlers.splice(index, 1);
    };
  }

  get reconnectConfig(): Readonly<McpReconnectConfig> {
    return this.#config;
  }

  // ── Outcomes reported by the connection owner ─────────────────────────────

  /**
   * A connect was asked for (start-up, reload, an explicit connect). It starts
   * a fresh reconnect cycle: any scheduled attempt is cancelled and the count
   * and the reason a previous cycle stopped are cleared.
   */
  requested(serverName: string): void {
    const tracked = this.#track(serverName);
    this.#cancelTimer(tracked);
    tracked.generation++;
    const { entry } = tracked;
    entry.reconnectAttempts = 0;
    delete entry.stoppedReason;
    if (isOperational(entry.state) || entry.state === 'connecting') return;
    if (this.#move(entry, 'connecting')) this.#emit({ type: 'MCP_CONNECTING', serverId: serverName });
  }

  /** The server is connected and answering. */
  connected(serverName: string, toolCount = 0): void {
    const tracked = this.#track(serverName);
    this.#cancelTimer(tracked);
    const { entry } = tracked;
    if (entry.state === 'connected') return;
    if (!canTransition(entry.state, 'connected')) this.#move(entry, 'connecting');
    if (!this.#move(entry, 'connected')) return;
    entry.reconnectAttempts = 0;
    entry.connectedAt = Date.now();
    delete entry.lastError;
    delete entry.stoppedReason;
    this.#emit({ type: 'MCP_CONNECTED', serverId: serverName, toolCount, resourceCount: 0 });
  }

  /** A connected server answers but its tool list could not be read. */
  degraded(serverName: string, reason: string): void {
    const tracked = this.#servers.get(serverName);
    if (!tracked || tracked.entry.state !== 'connected') return;
    if (!this.#move(tracked.entry, 'degraded')) return;
    tracked.entry.lastError = reason;
    this.#emit({ type: 'MCP_DEGRADED', serverId: serverName, reason, availableTools: [] });
  }

  /** A degraded server's tool list loaded again. A no-op for any other state. */
  recovered(serverName: string): void {
    if (this.#servers.get(serverName)?.entry.state === 'degraded') this.connected(serverName);
  }

  /**
   * A connect attempt failed or a connected server dropped. Schedules the next
   * attempt after the back-off delay, or gives up when attempts are used up,
   * automatic reconnect is off, or the manager was cancelled. A failure
   * reported after a deliberate stop is stale and ignored.
   */
  failed(serverName: string, reason: string): void {
    const tracked = this.#servers.get(serverName);
    if (!tracked) return;
    const { entry } = tracked;
    if (entry.state === 'disconnected' || entry.state === 'configured' || entry.state === 'reconnecting') return;
    tracked.generation++;
    entry.lastError = reason;
    entry.disconnectedAt = Date.now();
    const stop = this.#stopReason(entry) ?? (canTransition(entry.state, 'reconnecting') ? undefined : 'it cannot be reconnected from its current state');
    if (stop) {
      this.#giveUp(tracked, reason, stop);
      return;
    }
    const attempt = entry.reconnectAttempts + 1;
    const delayMs = Math.min(this.#config.baseDelayMs * 2 ** (attempt - 1), this.#config.maxDelayMs);
    if (!this.#move(entry, 'reconnecting')) return;
    entry.reconnectAttempts = attempt;
    entry.reconnectPending = true;
    entry.nextReconnectAt = Date.now() + delayMs;
    this.#emit({ type: 'MCP_DISCONNECTED', serverId: serverName, reason, willRetry: true });
    this.#emit({ type: 'MCP_RECONNECTING', serverId: serverName, attempt, maxAttempts: this.#config.maxAttempts });
    logger.info('McpLifecycleManager: scheduling reconnect', { server: serverName, attempt, delayMs, reason });
    const generation = tracked.generation;
    const timer = setTimeout(() => { void this.#attempt(serverName, tracked, generation); }, delayMs);
    timer.unref?.();
    tracked.timer = timer;
  }

  /** A deliberate disconnect: cancel any scheduled attempt; nothing reconnects until a connect is requested. */
  stop(serverName: string, reason?: string): void {
    const tracked = this.#servers.get(serverName);
    if (!tracked) return;
    this.#halt(tracked, reason);
  }

  /** Stop every server's reconnect (shutdown, owner revoked, cancellation); `reason` is kept as why reconnect stopped. */
  stopAll(reason: string): void {
    for (const tracked of this.#servers.values()) {
      const wasRetrying = tracked.entry.state === 'reconnecting';
      this.#halt(tracked, reason);
      if (wasRetrying) tracked.entry.stoppedReason = reason;
    }
  }

  /** The server left the configuration: drop everything held for it. */
  forget(serverName: string): void {
    const tracked = this.#servers.get(serverName);
    if (!tracked) return;
    this.#cancelTimer(tracked);
    tracked.generation++;
    this.#servers.delete(serverName);
  }

  // ── Inspection ────────────────────────────────────────────────────────────

  /** The current lifecycle state for a server, or `null` if unknown. */
  getState(serverName: string): McpServerState | null {
    return this.#servers.get(serverName)?.entry.state ?? null;
  }

  /** A copy of one server's entry, or `null`. */
  getServer(serverName: string): McpServerEntry | null {
    const entry = this.#servers.get(serverName)?.entry;
    return entry ? { ...entry } : null;
  }

  /** Copies of every server's entry. */
  getServers(): ReadonlyMap<string, McpServerEntry> {
    return new Map([...this.#servers].map(([name, tracked]) => [name, { ...tracked.entry }] as const));
  }

  /** Whether an attempt is scheduled for the server and has not started yet. */
  isReconnecting(serverName: string): boolean {
    return this.#servers.get(serverName)?.entry.state === 'reconnecting';
  }

  /** The reconnect state for status surfaces and refusals; undefined when no cycle ran or stopped. */
  reconnectStatus(serverName: string): McpReconnectStatus | undefined {
    const entry = this.#servers.get(serverName)?.entry;
    if (!entry || (entry.reconnectAttempts === 0 && entry.stoppedReason === undefined)) return undefined;
    return {
      state: entry.state,
      attempt: entry.reconnectAttempts,
      maxAttempts: this.#config.maxAttempts,
      ...(entry.nextReconnectAt !== undefined ? { nextAttemptAt: entry.nextReconnectAt } : {}),
      ...(entry.stoppedReason !== undefined ? { stoppedReason: entry.stoppedReason } : {}),
    };
  }

  /** Names of all servers currently in an operational state (connected/degraded). */
  get operationalServerNames(): string[] {
    return [...this.#servers].filter(([, tracked]) => isOperational(tracked.entry.state)).map(([name]) => name);
  }

  // ── Private ───────────────────────────────────────────────────────────────

  async #attempt(serverName: string, tracked: TrackedServer, generation: number): Promise<void> {
    if (this.#servers.get(serverName) !== tracked || tracked.generation !== generation) return;
    tracked.timer = undefined;
    const { entry } = tracked;
    entry.reconnectPending = false;
    delete entry.nextReconnectAt;
    const stop = this.#stopReason(entry, false);
    if (stop) {
      this.#giveUp(tracked, entry.lastError ?? 'the server dropped', stop);
      return;
    }
    if (!this.#move(entry, 'connecting')) return;
    this.#emit({ type: 'MCP_CONNECTING', serverId: serverName });
    const current = (): boolean => this.#servers.get(serverName) === tracked && tracked.generation === generation && entry.state === 'connecting';
    let started: boolean;
    try {
      started = await this.#connector(serverName);
    } catch (error) {
      if (current()) this.failed(serverName, summarizeError(error));
      return;
    }
    if (!started && current()) this.#giveUp(tracked, 'the server is no longer configured', 'automatic reconnect stopped');
  }

  /** Why no further attempt may be made, or undefined when one may. */
  #stopReason(entry: McpServerEntry, countAttempts = true): string | undefined {
    if (this.#signal?.aborted) return 'automatic reconnect was cancelled';
    if (!this.#enabled()) return `automatic reconnect is off (${RECONNECT_SETTING})`;
    if (countAttempts && entry.reconnectAttempts >= this.#config.maxAttempts) return `automatic reconnect gave up after ${this.#config.maxAttempts} attempts`;
    return undefined;
  }

  #giveUp(tracked: TrackedServer, reason: string, stoppedReason: string): void {
    this.#cancelTimer(tracked);
    const { entry } = tracked;
    entry.reconnectPending = false;
    delete entry.nextReconnectAt;
    entry.stoppedReason = stoppedReason;
    entry.disconnectedAt = Date.now();
    if (entry.state !== 'disconnected') this.#move(entry, 'disconnected');
    this.#emit({ type: 'MCP_DISCONNECTED', serverId: entry.name, reason: `${reason}; ${stoppedReason}`, willRetry: false });
    logger.info('McpLifecycleManager: not reconnecting', { server: entry.name, reason, stoppedReason });
  }

  #halt(tracked: TrackedServer, reason: string | undefined): void {
    this.#cancelTimer(tracked);
    tracked.generation++;
    const { entry } = tracked;
    const wasRetrying = entry.state === 'reconnecting';
    entry.reconnectPending = false;
    delete entry.nextReconnectAt;
    if (entry.state === 'disconnected' || entry.state === 'configured') return;
    entry.disconnectedAt = Date.now();
    this.#move(entry, 'disconnected');
    if (wasRetrying) this.#emit({ type: 'MCP_DISCONNECTED', serverId: entry.name, reason, willRetry: false });
  }

  #track(serverName: string): TrackedServer {
    let tracked = this.#servers.get(serverName);
    if (!tracked) {
      tracked = { entry: { name: serverName, state: 'configured', reconnectAttempts: 0, reconnectPending: false }, generation: 0 };
      this.#servers.set(serverName, tracked);
    }
    return tracked;
  }

  #cancelTimer(tracked: TrackedServer): void {
    if (tracked.timer === undefined) return;
    clearTimeout(tracked.timer);
    tracked.timer = undefined;
    tracked.entry.reconnectPending = false;
  }

  /** Applies a table-legal move. Returns whether it applied; a refused move leaves the entry untouched. */
  #move(entry: McpServerEntry, next: McpServerState): boolean {
    const result = applyTransition(entry.state, next);
    if (!result.success) {
      logger.debug('McpLifecycleManager: transition refused', { server: entry.name, from: entry.state, to: next, reason: result.reason });
      return false;
    }
    entry.state = next;
    return true;
  }

  #emit(event: McpEvent): void {
    for (const handler of this.#handlers) {
      try {
        handler(event);
      } catch (err) {
        // A handler error must not stop the lifecycle.
        logger.warn('McpLifecycleManager: event handler threw', { event: event.type, err: summarizeError(err) });
      }
    }
  }
}
