/**
 * Daemon domain state: the HTTP listener this process hosts for the daemon
 * facade, as its transport events report it (platform/daemon/transport-events.ts).
 * A terminal that is a client of a separately running daemon hosts no
 * listener; its connection to that daemon is not described here.
 */

/**
 * States from the ACP/daemon transport lifecycle machine.
 * Shared with acp.ts since the daemon uses the same transport lifecycle.
 */
export type DaemonTransportState =
  | 'initializing'
  | 'authenticating'
  | 'connected'
  | 'syncing'
  | 'degraded'
  | 'reconnecting'
  | 'disconnected'
  | 'terminal_failure';

/**
 * DaemonDomainState, the local daemon listener's transport state.
 */
export interface DaemonDomainState {
  // ── Domain metadata ────────────────────────────────────────────────────────
  /** Monotonic revision counter; increments on every mutation. */
  revision: number;
  /** Timestamp of last mutation (Date.now()). */
  lastUpdatedAt: number;
  /** Subsystem that triggered the last mutation. */
  source: string;

  // ── Transport ─────────────────────────────────────────────────────────────
  /** Current transport lifecycle state. */
  transportState: DaemonTransportState;
  /** Whether the listener is up. */
  isRunning: boolean;
  /** Epoch ms of the last time the listener came up. */
  lastConnectedAt?: number | undefined;
  /** Why the listener last went down; cleared when it is up again. */
  lastError?: string | undefined;
}

/**
 * Returns the default initial state for the daemon domain.
 */
export function createInitialDaemonState(): DaemonDomainState {
  return {
    revision: 0,
    lastUpdatedAt: 0,
    source: 'init',
    transportState: 'disconnected',
    isRunning: false,
    lastConnectedAt: undefined,
    lastError: undefined,
  };
}
