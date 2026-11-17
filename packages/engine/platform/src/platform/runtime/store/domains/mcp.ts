/**
 * MCP domain state, tracks all MCP server connections and their lifecycle
 * state. The tools themselves are the MCP registry's.
 */

import type { McpServerState } from '../../mcp/types.js';

/** States for the MCP server lifecycle machine. One declaration: an alias of {@link McpServerState}. */
export type McpServerLifecycleState = McpServerState;

/** Health and connection record for a single MCP server. */
export interface McpServerRecord {
  /** Server name (from MCP config). */
  name: string;
  /** Server display name or label. */
  displayName: string;
  /** Current lifecycle state. */
  status: McpServerLifecycleState;
  /** Transport type used by this server. */
  transport: 'stdio' | 'sse' | 'http';
  /** Number of tools registered by this server. */
  toolCount: number;
  /** Epoch ms of connection establishment. */
  connectedAt?: number | undefined;
  /** Last error message. */
  lastError?: string | undefined;
  /** Number of reconnect attempts. */
  reconnectAttempts: number;
  /** Runtime trust mode for this server. */
  trustMode: import('../../mcp/types.js').McpTrustMode;
  /** High-level role used for coherence evaluation. */
  role: import('../../mcp/types.js').McpServerRole;
  /** Allowed filesystem scope. */
  allowedPaths: string[];
  /** Allowed network host scope. */
  allowedHosts: string[];
  /** Current schema freshness state. */
  schemaFreshness: import('../../mcp/types.js').SchemaFreshness;
  /** Active quarantine reason when schema execution is blocked. */
  quarantineReason?: import('../../mcp/types.js').QuarantineReason | undefined;
  /** Human-readable quarantine detail. */
  quarantineDetail?: string | undefined;
  /** Operator id that approved the last quarantine override. */
  quarantineApprovedBy?: string | undefined;
}

/**
 * McpDomainState, all MCP server connections and tool registry.
 */
export interface McpDomainState {
  // ── Domain metadata ────────────────────────────────────────────────────────
  /** Monotonic revision counter; increments on every mutation. */
  revision: number;
  /** Timestamp of last mutation (Date.now()). */
  lastUpdatedAt: number;
  /** Subsystem that triggered the last mutation. */
  source: string;

  // ── Server registry ───────────────────────────────────────────────────────
  /** All MCP servers keyed by server name. */
  servers: Map<string, McpServerRecord>;
  /** Names of servers currently in 'connected' state. */
  connectedServerNames: string[];

  // ── Tools ─────────────────────────────────────────────────────────────────
  /** Total number of available (callable) tools. */
  availableToolCount: number;

  // ── Aggregate ──────────────────────────────────────────────────────────────
  /** Connection failures this session: a server degraded, disconnected or quarantined. */
  totalErrors: number;
}

/**
 * Returns the default initial state for the MCP domain.
 */
export function createInitialMcpState(): McpDomainState {
  return {
    revision: 0,
    lastUpdatedAt: 0,
    source: 'init',
    servers: new Map(),
    connectedServerNames: [],
    availableToolCount: 0,
    totalErrors: 0,
  };
}
