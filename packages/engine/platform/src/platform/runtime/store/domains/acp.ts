/**
 * ACP domain state: the subagent connections this process runs over the
 * Agent Client Protocol, kept from the transport events each connection
 * announces (platform/acp/connection.ts).
 */

import type { DaemonTransportState } from './daemon.js';

/** The ACP transport uses the same lifecycle states as the daemon listener. */
export type AcpTransportState = DaemonTransportState;

/** One live (or failed, while others are live) ACP subagent connection. */
export interface AcpConnection {
  /** The subagent's id, the same as its agent record's. */
  agentId: string;
  /** The task the subagent was spawned with. */
  label: string;
  transportState: AcpTransportState;
  /** Epoch ms the connection last reached `connected`. */
  connectedAt?: number | undefined;
  /** Terminal failures this connection reported. */
  errorCount: number;
  lastError?: string | undefined;
}

export interface AcpDomainState {
  // ── Domain metadata ────────────────────────────────────────────────────────
  revision: number;
  lastUpdatedAt: number;
  source: string;

  // ── Transport ─────────────────────────────────────────────────────────────
  /** One state for all connections: failures are reported beside live ones. */
  managerTransportState: AcpTransportState;
  /** Each connection's state, keyed by transport id (`acp:<agentId>`). */
  transportStates: Map<string, AcpTransportState>;
  initialized: boolean;

  // ── Connections ───────────────────────────────────────────────────────────
  /** The connections still open, and failed ones while another is live, keyed by agent id. */
  connections: Map<string, AcpConnection>;
  /** Connections that have not failed. */
  activeConnectionIds: string[];

  // ── Statistics ─────────────────────────────────────────────────────────────
  /** Connections started this session. */
  totalSpawned: number;
  /** Connections that ended in a terminal failure this session. */
  totalFailed: number;
}

export function createInitialAcpState(): AcpDomainState {
  return {
    revision: 0,
    lastUpdatedAt: 0,
    source: 'init',
    managerTransportState: 'disconnected',
    transportStates: new Map(),
    initialized: false,
    connections: new Map(),
    activeConnectionIds: [],
    totalSpawned: 0,
    totalFailed: 0,
  };
}
