/**
 * Remote Substrate, Reconnect Engine
 *
 * Implements reconnect with handshake tokens, epoch tracking,
 * replay from last acknowledged offset, and idempotent command submission.
 *
 * The reconnect engine drives the transport state machine:
 *   disconnected → initializing → authenticating → connected → syncing → degraded
 *   → reconnecting → ... (retry loop)
 *   → terminal_failure (max attempts exceeded or non-retryable error)
 */

import type {
  HandshakeToken,
  ReplayConfig,
  RemoteSession,
  DurableIdentity,
  RetryPolicy,
  TransportErrorCategory,
  NegotiatedProtocol,
} from './types.js';
import {
  CONTROL_RETRY_POLICY,
  computeRetryDelay,
  shouldRetry,
} from './transport-contract.js';
import { randomUUID } from 'node:crypto';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { readFailureTransience } from '@goodvibes-jev/engine/errors';

/** Default reconnect policy. */
const DEFAULT_RECONNECT_POLICY: Readonly<RetryPolicy> = Object.freeze({
  ...CONTROL_RETRY_POLICY,
  maxAttempts: 10,
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  retryOn: ['network', 'timeout', 'server', 'transient'] as const,
}) satisfies RetryPolicy;

/** Default replay configuration. */
const DEFAULT_REPLAY_CONFIG: Readonly<ReplayConfig> = Object.freeze({
  lastAckedOffset: 0,
  maxReplayCount: 500,
  enabled: true,
});

/** Outcome of a connect/reconnect attempt. */
export type ConnectOutcome =
  | {
      readonly success: true;
      readonly token: HandshakeToken;
      readonly epoch: number;
      readonly replayFromOffset: number;
      /** Negotiated protocol agreed during handshake. */
      readonly negotiatedProtocol: NegotiatedProtocol;
    }
  | {
      readonly success: false;
      readonly category: TransportErrorCategory;
      readonly error: string;
      readonly retryable: boolean;
      /**
       * Unsupported code when the failure is due to version mismatch.
       * Absent for auth/network failures.
       */
      readonly unsupportedCode?:
        | 'major_version_mismatch'
        | 'peer_version_too_old'
        | 'peer_version_unsupported';
    };

/**
 * Adapter interface, callers implement the actual transport operations.
 *
 * The reconnect engine delegates real I/O to this adapter, keeping itself
 * transport-agnostic (WebSocket, HTTP, stdio all implement the same adapter).
 */
export interface TransportAdapter {
  /**
   * Attempt to establish a connection and perform the handshake.
   *
   * Implementations must:
   * 1. Open the transport channel
   * 2. Send HANDSHAKE_INIT with identity, epoch, lastAckedOffset, authToken,
   *    and the local `protocolVersion` from CURRENT_PROTOCOL_VERSION
   * 3. Wait for HANDSHAKE_ACCEPT or HANDSHAKE_REJECT
   * 4. On HANDSHAKE_ACCEPT, extract `negotiatedProtocol` and return it in the outcome
   * 5. On HANDSHAKE_REJECT with an `unsupportedCode`, return success=false with
   *    that code, the engine will treat it as a terminal (non-retryable) failure
   *
   * @param identity - Stable durable identity to present.
   * @param lastAckedOffset - Offset to replay from.
   * @param authToken - Bearer token from the AuthProvider.
   * @returns ConnectOutcome, success with token+negotiatedProtocol or failure with category.
   */
  connect(
    identity: DurableIdentity,
    lastAckedOffset: number,
    authToken: string,
  ): Promise<ConnectOutcome>;

  /** Disconnect the transport cleanly. */
  disconnect(): Promise<void>;

  /**
   * Called after a successful handshake to replay messages since lastAckedOffset.
   * The adapter fetches and delivers replayed messages via its normal receive path.
   */
  requestReplay(fromOffset: number, maxCount: number): Promise<void>;
}

/** Lifecycle event callbacks fired by the reconnect engine. */
export interface ReconnectEngineCallbacks {
  /** Called when version negotiation produces a downgrade. Unsupported = terminal failure. */
  onVersionNegotiated?(protocol: NegotiatedProtocol): void;
  /** Called when the transport enters 'initializing'. */
  onInitializing?(attempt: number): void;
  /** Called when authentication is in progress. */
  onAuthenticating?(): void;
  /** Called when the connection is successfully established. */
  onConnected(token: HandshakeToken, epoch: number): void;
  /** Called when state sync is in progress after connect. */
  onSyncing?(): void;
  /**
   * Called when the sync that `onSyncing` announced has finished. `ok` is false
   * when the replay request failed, so messages may be missing.
   */
  onSynced?(ok: boolean, error?: string): void;
  /** Called when a reconnect attempt is scheduled. */
  onReconnecting?(attempt: number, maxAttempts: number, delayMs: number): void;
  /** Called when the transport is disconnected (willRetry indicates intent). */
  onDisconnected?(reason?: string, willRetry?: boolean): void;
  /** Called when all retries are exhausted, terminal failure. */
  onTerminalFailure(error: string): void;
}

/**
 * ReconnectEngine, manages the full reconnect lifecycle with backoff and replay.
 *
 * Usage:
 * ```ts
 * const engine = new ReconnectEngine(adapter, identity, replayConfig, callbacks);
 * await engine.connect(); // blocks until connected or terminal failure
 * // After a failure detected externally:
 * await engine.reconnect(); // drives the retry loop
 * engine.dispose(); // cancel any pending reconnect
 * ```
 */
export class ReconnectEngine {
  private readonly _policy: Readonly<RetryPolicy>;
  private readonly _replay: Readonly<ReplayConfig>;
  private _handshakeToken: HandshakeToken | undefined;
  private _epoch = 0;
  private _lastAckedOffset: number;
  private _attempts = 0;
  private _disposed = false;
  private _pendingTimer: ReturnType<typeof setTimeout> | null = null;
  /** Wakes a reconnect loop parked in its back-off sleep, so dispose ends it at once. */
  private _wakeSleep: (() => void) | null = null;
  /** The reconnect loop in flight, so a second caller joins it instead of starting another. */
  private _reconnecting: Promise<boolean> | null = null;
  /** Negotiated protocol from the last successful handshake. */
  private _negotiatedProtocol: NegotiatedProtocol | undefined;

  constructor(
    private readonly adapter: TransportAdapter,
    private readonly identity: DurableIdentity,
    replayConfig?: Partial<ReplayConfig>,
    private readonly callbacks?: ReconnectEngineCallbacks,
    reconnectPolicy?: Partial<RetryPolicy>,
  ) {
    this._policy = reconnectPolicy
      ? Object.freeze({ ...DEFAULT_RECONNECT_POLICY, ...reconnectPolicy })
      : DEFAULT_RECONNECT_POLICY;
    this._replay = replayConfig
      ? Object.freeze({ ...DEFAULT_REPLAY_CONFIG, ...replayConfig })
      : DEFAULT_REPLAY_CONFIG;
    this._lastAckedOffset = this._replay.lastAckedOffset;
  }

  /** Current handshake token (undefined until first successful connect). */
  get handshakeToken(): HandshakeToken | undefined {
    return this._handshakeToken;
  }

  /** Current server epoch. */
  get epoch(): number {
    return this._epoch;
  }

  /** Offset of the last acknowledged message. */
  get lastAckedOffset(): number {
    return this._lastAckedOffset;
  }

  /** Number of reconnect attempts since last successful connect. */
  get attempts(): number {
    return this._attempts;
  }

  /**
   * The negotiated protocol from the last successful handshake.
   * Undefined until the first successful connect.
   */
  get negotiatedProtocol(): NegotiatedProtocol | undefined {
    return this._negotiatedProtocol;
  }

  /**
   * Update the last acknowledged offset.
   * Call this whenever an ack is sent or a message is durably processed.
   *
   * @param offset - The offset to record as acknowledged.
   */
  ackOffset(offset: number): void {
    if (offset > this._lastAckedOffset) {
      this._lastAckedOffset = offset;
    }
  }

  /**
   * Perform the initial connect attempt.
   *
   * @param authToken - Bearer token from the AuthProvider.
   * @returns True when connected. False when not: use `connectOutcome` to tell a
   * failure that can clear (call `reconnect`) from a terminal one.
   */
  async connect(authToken: string): Promise<boolean> {
    return (await this.connectOutcome(authToken)) === 'connected';
  }

  /**
   * Perform the initial connect attempt and say how it ended: `connected`,
   * `retry` (failed, and `reconnect` may succeed) or `terminal` (do not retry).
   */
  async connectOutcome(authToken: string): Promise<'connected' | 'retry' | 'terminal'> {
    if (this._disposed) return 'terminal';
    return this._attemptConnect(authToken, false);
  }

  /**
   * Drive the reconnect retry loop.
   *
   * Attempts reconnection up to `policy.maxAttempts` times using
   * exponential backoff with jitter. Calls callbacks at each state transition.
   *
   * @param getAuthToken - Called before each attempt to get a fresh token.
   * @returns True if eventually connected, false on terminal failure.
   */
  reconnect(getAuthToken: () => Promise<string>): Promise<boolean> {
    if (this._disposed) return Promise.resolve(false);
    // The attempt counter and the back-off timer belong to one loop; a second
    // caller (a close handler and a user action) shares the loop already running.
    if (this._reconnecting) return this._reconnecting;
    const loop = this._runReconnect(getAuthToken).finally(() => { this._reconnecting = null; });
    this._reconnecting = loop;
    return loop;
  }

  private async _runReconnect(getAuthToken: () => Promise<string>): Promise<boolean> {
    // A previous loop that ran out of attempts leaves the count at the limit;
    // a fresh call is a fresh series, not an immediate failure.
    if (this._attempts >= this._policy.maxAttempts) this._attempts = 0;

    while (this._attempts < this._policy.maxAttempts) {
      if (this._disposed) return false;

      this._attempts++;
      const delayMs = computeRetryDelay(this._policy, this._attempts);

      this.callbacks?.onReconnecting?.(
        this._attempts,
        this._policy.maxAttempts,
        delayMs,
      );

      logger.debug('ReconnectEngine: scheduling reconnect attempt', {
        attempt: this._attempts,
        maxAttempts: this._policy.maxAttempts,
        delayMs,
      });

      await this._sleep(delayMs);
      if (this._disposed) return false;

      let authToken: string;
      try {
        authToken = await getAuthToken();
      } catch (error) {
        // No token for this attempt is a failed attempt, not an exit that
        // leaves the caller's state at "reconnecting" with nothing running.
        if (this._disposed) return false;
        const message = `ReconnectEngine: could not obtain an auth token: ${summarizeError(error)}`;
        logger.warn(message, { attempt: this._attempts });
        this.callbacks?.onDisconnected?.(message, true);
        continue;
      }
      if (this._disposed) return false;
      const attempt = await this._attemptConnect(authToken, true);
      if (attempt === 'connected') {
        this._attempts = 0;
        return true;
      }
      // A failure that cannot clear was already signalled as terminal; another
      // attempt would only repeat it and signal it again.
      if (attempt === 'terminal') return false;
    }

    if (this._disposed) return false;
    const error = `ReconnectEngine: max reconnect attempts (${this._policy.maxAttempts}) exceeded`;
    logger.error(error);
    this.callbacks?.onTerminalFailure(error);
    return false;
  }

  /** Cancel any pending reconnect timer and mark engine as disposed. */
  dispose(): void {
    this._disposed = true;
    if (this._pendingTimer !== null) {
      clearTimeout(this._pendingTimer);
      this._pendingTimer = null;
    }
    const wake = this._wakeSleep;
    this._wakeSleep = null;
    wake?.();
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async _attemptConnect(authToken: string, isReconnect: boolean): Promise<'connected' | 'retry' | 'terminal'> {
    if (this._disposed) return 'terminal';

    this.callbacks?.onInitializing?.(this._attempts);
    this.callbacks?.onAuthenticating?.();

    let outcome: ConnectOutcome;
    try {
      outcome = await this.adapter.connect(this.identity, this._lastAckedOffset, authToken);
    } catch (error) {
      // A rejecting adapter (a refused or dropped socket) is a failed attempt
      // the loop can retry, not an exception that leaves the state at "authenticating".
      outcome = { success: false, category: 'network', error: summarizeError(error), retryable: true };
    }
    // Disposed while connecting: whoever disposed owns what happens next, so
    // no callback may report a connection or failure for this engine.
    if (this._disposed) return 'terminal';

    if (!outcome.success) {
      // Version unsupported is always terminal, never retry
      if (outcome.unsupportedCode) {
        logger.error('ReconnectEngine: unsupported peer version, terminal failure', {
          error: outcome.error,
          unsupportedCode: outcome.unsupportedCode,
        });
        if (this._disposed) return 'terminal';
        this.callbacks?.onTerminalFailure(outcome.error);
        return 'terminal';
      }

      const retryable = await this._retryable(outcome);
      if (this._disposed) return 'terminal';
      logger.warn('ReconnectEngine: connect attempt failed', {
        error: outcome.error,
        category: outcome.category,
        retryable,
        isReconnect,
      });

      if (!retryable) {
        this.callbacks?.onTerminalFailure(outcome.error);
        return 'terminal';
      }

      this.callbacks?.onDisconnected?.(outcome.error, true);
      return 'retry';
    }

    // Success path
    const { token, epoch, replayFromOffset, negotiatedProtocol } = outcome;
    this._epoch = epoch;
    this._handshakeToken = token;
    this._negotiatedProtocol = negotiatedProtocol;

    if (this.callbacks?.onVersionNegotiated) {
      this.callbacks.onVersionNegotiated(negotiatedProtocol);
    }

    this.callbacks?.onConnected(token, epoch);

    // Trigger replay if enabled and the server offers messages to replay
    if (this._replay.enabled && replayFromOffset > 0) {
      this.callbacks?.onSyncing?.();
      let replayError: string | undefined;
      try {
        await this.adapter.requestReplay(
          replayFromOffset,
          this._replay.maxReplayCount,
        );
      } catch (err) {
        replayError = summarizeError(err);
        logger.warn('ReconnectEngine: replay request failed (degraded mode)', {
          err: replayError,
        });
      }
      if (!this._disposed) this.callbacks?.onSynced?.(replayError === undefined, replayError);
    }

    logger.debug('ReconnectEngine: connected successfully', {
      sessionId: this.identity.sessionId,
      epoch,
      lastAckedOffset: this._lastAckedOffset,
    });

    return 'connected';
  }

  /**
   * Whether a failed connect could succeed on another attempt. The adapter's
   * own `retryable` flag and a known category against the configured policy
   * decide exactly; a failure the adapter could not categorise (`unknown`)
   * is read through the engine's failure reading (readFailureTransience:
   * structure first, then the `engine.failure-reading` battery on the
   * wording). A failure that cannot be read rejects the reconnect.
   */
  private async _retryable(outcome: Extract<ConnectOutcome, { readonly success: false }>): Promise<boolean> {
    if (!outcome.retryable) return false;
    if (outcome.category !== 'unknown') return shouldRetry(this._policy, outcome.category);
    const transience = await readFailureTransience(outcome.error, 'remote.reconnect.failure');
    return transience.failureClass === 'retryable';
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this._wakeSleep = resolve;
      this._pendingTimer = setTimeout(() => {
        this._pendingTimer = null;
        this._wakeSleep = null;
        resolve();
      }, ms);
      this._pendingTimer.unref?.();
    });
  }
}

/**
 * Generate an idempotent submission key for a command.
 *
 * The key combines the session ID with a random UUID so that retried
 * submissions with the same key can be deduplicated by the server.
 *
 * @param sessionId - Durable session ID.
 * @returns A stable key string for use as `idempotencyKey`.
 */
export function generateIdempotencyKey(sessionId: string): string {
  return `${sessionId}:${randomUUID()}`;
}
