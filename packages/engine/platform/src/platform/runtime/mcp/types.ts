/**
 * MCP lifecycle core type definitions.
 *
 * Referenced by: lifecycle.ts, permissions.ts, schema-freshness.ts, manager.ts
 * Spec: server state machine and MCP evolution.
 */
import type { McpServerRole, McpTrustMode, QuarantineReason } from '../../../events/mcp.js';

export type { McpServerRole, McpTrustMode, QuarantineReason };

// ── State machine ─────────────────────────────────────────────────────────────

/**
 * All legal states in the MCP server lifecycle state machine.
 *
 * Transition diagram:
 *   configured → connecting → connected → degraded
 *   connected  → auth_required
 *   connected  → reconnecting → connected
 *   connected  → disconnected
 *   reconnecting → disconnected (max attempts exceeded)
 *   degraded   → reconnecting
 *   degraded   → disconnected
 *   auth_required → connecting (after credentials provided)
 *   auth_required → disconnected
 */
export type McpServerState =
  | 'configured'
  | 'connecting'
  | 'connected'
  | 'degraded'
  | 'auth_required'
  | 'reconnecting'
  | 'disconnected';

// ── Schema freshness ──────────────────────────────────────────────────────────

/**
 * Freshness status of a server's tool/resource schema cache.
 *
 * - `fresh`       , fetched recently, within the TTL window
 * - `stale`       , fetched but TTL has elapsed; re-fetch recommended
 * - `unknown`     , never fetched or record cleared
 * - `fetch_failed`, last fetch attempt returned an error
 * - `quarantined` , schema is unsupported or stale past threshold; execution
 *                    blocked until operator refreshes or explicitly acknowledges
 */
export type SchemaFreshness = 'fresh' | 'stale' | 'unknown' | 'fetch_failed' | 'quarantined';

/**
 * Reason a schema was placed into quarantine.
 *
 * - `stale_threshold`  , TTL expired and refresh failed repeatedly
 * - `unsupported`     , schema version is unsupported with the runtime
 * - `operator_flagged` , manually flagged by an operator for review
 */
// QuarantineReason is imported from events/mcp.ts (see top of file).

/** Quarantine record attached to a schema when it enters the quarantined state. */
export interface QuarantineRecord {
  /** Why the schema was quarantined. */
  reason: QuarantineReason;
  /** Epoch ms when quarantine was applied. */
  quarantinedAt: number;
  /** Human-readable detail for display in the MCP panel. */
  detail?: string | undefined;
  /** Operator identifier who acknowledged and approved override, if any. */
  overrideAcknowledgedBy?: string | undefined;
  /** Epoch ms when the operator acknowledged the quarantine override. */
  overrideAcknowledgedAt?: number | undefined;
}

/** Per-server schema record tracking freshness metadata. */
export interface McpSchemaRecord {
  /** Server name this record belongs to. */
  serverName: string;
  /** Current freshness state. */
  freshness: SchemaFreshness;
  /** Epoch ms when schemas were last successfully fetched. */
  fetchedAt?: number | undefined;
  /** Epoch ms when the next fetch is required (fetchedAt + ttl). */
  expiresAt?: number | undefined;
  /** Error message from the last failed fetch attempt. */
  lastFetchError?: string | undefined;
  /** Number of consecutive failed fetch attempts. */
  consecutiveFailures: number;
  /** Quarantine metadata, present only when freshness is 'quarantined'. */
  quarantine?: QuarantineRecord | undefined;
}

// ── Permissions ───────────────────────────────────────────────────────────────

/**
 * The trust levels of an older permission design. Nothing decides from them:
 * a server's trust mode, per-tool overrides and its scopes decide every call.
 * Kept only as an exported name.
 */
export type McpTrustLevel = 'trusted' | 'standard' | 'restricted' | 'blocked';

/** Runtime trust mode used by the hardened MCP policy layer. */
// McpTrustMode and McpServerRole are imported from events/mcp.ts (see top of file).

/** Capability classes of an older, model-read classification of MCP tools. No call is decided by one; kept only as an exported name. */
export type McpCapabilityClass =
  | 'metadata'
  | 'read_fs'
  | 'write_fs'
  | 'exec'
  | 'network_read'
  | 'network_write'
  | 'secret_read'
  | 'spawn_agent'
  | 'config_mutation'
  | 'system_mutation'
  | 'generic';

/** Runtime trust mode used by the hardened MCP policy layer. */
// McpTrustMode is imported from events/mcp.ts (see top of file).

/** Enforcement answers allow or deny; nothing at this layer asks. */
export type McpCoherenceVerdict = 'allow' | 'deny';
export type McpRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface McpTrustProfile {
  serverName: string;
  role: McpServerRole;
  mode: McpTrustMode;
  allowedPaths: string[];
  allowedHosts: string[];
  notes?: string | undefined;
  lastModifiedAt: number;
}

export interface McpCoherenceAssessment {
  verdict: McpCoherenceVerdict;
  riskLevel: McpRiskLevel;
  incoherent: boolean;
  reason: string;
}

export interface McpDecisionRecord {
  serverName: string;
  toolName: string;
  verdict: McpCoherenceVerdict;
  riskLevel: McpRiskLevel;
  incoherent: boolean;
  reason: string;
  profileMode: McpTrustMode;
  evaluatedAt: number;
}

/** Snapshot of a managed MCP server used for attack-path review. */
export interface McpSecuritySnapshot {
  /** Server name. */
  name: string;
  /** High-level role used for coherence evaluation. */
  role: McpServerRole;
  /** Runtime trust mode. */
  trustMode: McpTrustMode;
  /** Allowed filesystem scope. */
  allowedPaths: readonly string[];
  /** Allowed network host scope. */
  allowedHosts: readonly string[];
  /** Current schema freshness state. */
  schemaFreshness: SchemaFreshness;
  /** Active quarantine reason when schema execution is blocked. */
  quarantineReason?: QuarantineReason | undefined;
  /** Human-readable quarantine detail. */
  quarantineDetail?: string | undefined;
  /** Whether the server is currently connected. */
  connected?: boolean | undefined;
}

/** Type of attack-path finding surfaced by the security review. */
export type McpAttackPathFindingKind = 'server-posture' | 'recent-decision';

/** Single MCP attack-path finding. */
export interface McpAttackPathFinding {
  /** Finding classification. */
  kind: McpAttackPathFindingKind;
  /** Related server name. */
  serverName: string;
  /** Human-readable route summary. */
  route: string;
  /** Allow/ask/deny posture inferred from the review. */
  verdict: McpCoherenceVerdict;
  /** Risk level associated with the route. */
  severity: McpRiskLevel;
  /** Whether the finding indicates incoherent or suspicious behavior. */
  incoherent: boolean;
  /** Human-readable explanation. */
  reason: string;
  /** Evidence strings used to derive the finding. */
  evidence: readonly string[];
  /** Optional tool name for recent decision findings. */
  toolName?: string | undefined;
  /** Optional timestamp for recent decision findings. */
  evaluatedAt?: number | undefined;
}

/** Aggregated attack-path review across all MCP servers and recent decisions. */
export interface McpAttackPathReview {
  /** Epoch ms when the review was generated. */
  reviewedAt: number;
  /** Total server count included in the review. */
  totalServers: number;
  /** Connected server count. */
  connectedServers: number;
  /** Servers operating in allow-all mode. */
  allowAllServers: number;
  /** Servers operating in ask-on-risk mode. */
  askOnRiskServers: number;
  /** Servers operating in constrained mode. */
  constrainedServers: number;
  /** Servers blocked entirely. */
  blockedServers: number;
  /** Servers with quarantined schemas. */
  quarantinedServers: number;
  /** Findings with incoherent posture or behavior. */
  incoherentFindings: number;
  /** Findings with high or critical severity. */
  criticalFindings: number;
  /** Ordered findings, most severe first. */
  findings: readonly McpAttackPathFinding[];
  /** Human-readable summary of the review. */
  summary: string;
}

/** Permission verdict for a single tool invocation. */
export interface McpPermission {
  readonly causes?: readonly ('path-out-of-scope' | 'host-out-of-scope')[] | undefined;
  /**
   * Set when the server is trusted `ask-on-risk` and the call is outside its
   * configured scope: the sentence the owner is asked with. The call runs only
   * when he allows it; with nobody to ask it is refused.
   */
  readonly askOwner?: string | undefined;
  /** Whether the tool call is permitted. */
  allowed: boolean;
  /** Human-readable explanation for the verdict. */
  reason: string;
  /** Richer verdict used by the hardened trust layer. */
  verdict?: McpCoherenceVerdict | undefined;
  /** Risk associated with the evaluated tool call. */
  riskLevel?: McpRiskLevel | undefined;
  /** Whether the request was flagged as incoherent for its server role. */
  incoherent?: boolean | undefined;
  /** Effective trust mode when the decision was made. */
  profileMode?: McpTrustMode | undefined;
}

/** Per-tool permission override stored in a server's permission record. */
export interface McpToolPermission {
  /** Tool name on the server (not qualified). */
  toolName: string;
  /** Explicit allow or deny override. */
  verdict: 'allow' | 'deny';
  /** Optional note recorded when the override was set. */
  note?: string | undefined;
}

/** One per-tool allow or deny on a server, and where it came from. */
export interface McpToolRuleRecord {
  /** Tool name on the server (not qualified). */
  readonly toolName: string;
  readonly rule: 'allow' | 'deny';
  /** `session`: denied with /mcp deny, until the process exits; `stored`: kept with the server's entry in its MCP config file. */
  readonly source: 'session' | 'stored';
  /** False for an allow that a deny of the same tool overrides: a deny from any source wins. */
  readonly inEffect: boolean;
}

/** Complete permission configuration for a single MCP server. */
export interface McpServerPermissions {
  /** Server name. */
  serverName: string;
  /** Trust mode, role and scopes: what decides each call. */
  profile: McpTrustProfile;
  /** Explicit per-tool overrides, applied before the scope check. */
  toolOverrides: Map<string, McpToolPermission>;
  /** Epoch ms when permissions were last modified. */
  lastModifiedAt: number;
}

// ── Server entry ──────────────────────────────────────────────────────────────

/**
 * Connection state of one MCP server.
 *
 * Held by McpLifecycleManager, which the MCP registry composes; drives the
 * lifecycle events, the server status surfaces and the not-connected refusal.
 */
export interface McpServerEntry {
  /** Server name (matches McpServerConfig.name). */
  name: string;
  /** Current lifecycle state. */
  state: McpServerState;
  /** Number of reconnect attempts in the current reconnection cycle. */
  reconnectAttempts: number;
  /** Whether a reconnect timer is currently scheduled. */
  reconnectPending: boolean;
  /** Epoch ms of the next reconnect attempt while one is scheduled. */
  nextReconnectAt?: number | undefined;
  /** Epoch ms of the most recent successful connection. */
  connectedAt?: number | undefined;
  /** Epoch ms of the most recent disconnection. */
  disconnectedAt?: number | undefined;
  /** Reason for the most recent drop or failed attempt. */
  lastError?: string | undefined;
  /** Why automatic reconnect stopped (attempts used up, turned off, cancelled); cleared by the next connect request. */
  stoppedReason?: string | undefined;
}

/** What one server's reconnect is doing, for status surfaces and refusals. */
export interface McpReconnectStatus {
  readonly state: McpServerState;
  /** Attempts made in the current cycle. */
  readonly attempt: number;
  readonly maxAttempts: number;
  /** Epoch ms of the next attempt while one is scheduled. */
  readonly nextAttemptAt?: number | undefined;
  /** Why automatic reconnect stopped, once it did. */
  readonly stoppedReason?: string | undefined;
}

// ── Reconnect config ─────────────────────────────────────────────────────────

/** Configuration for the exponential back-off reconnect strategy. */
export interface McpReconnectConfig {
  /** Maximum number of reconnect attempts before moving to disconnected. */
  maxAttempts: number;
  /** Base delay in ms (doubled each attempt). */
  baseDelayMs: number;
  /** Hard ceiling for any single reconnect delay (ms). */
  maxDelayMs: number;
}

/** Default reconnect configuration. */
export const DEFAULT_RECONNECT_CONFIG: McpReconnectConfig = {
  maxAttempts: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
};
