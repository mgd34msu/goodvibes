import type { ExternalRequestEvidence } from '../../permissions/external-request-evidence.js';
/**
 * MCP per-server permissions: each registered server's trust mode, role,
 * scopes and per-tool allow/deny overrides, and the one decision every live
 * call goes through ({@link McpPermissionManager.evaluateToolCall}).
 */
import type {
  McpTrustMode,
  McpServerRole,
  McpAttackPathFinding,
  McpAttackPathReview,
  McpSecuritySnapshot,
  McpDecisionRecord,
  McpPermission,
  McpServerPermissions,
  McpToolPermission,
} from './types.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { hostOutsideScope, pathOutsideScope, readScopedValues, type ScopedValue } from './scope.js';

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_TRUST_MODE: McpTrustMode = 'ask-on-risk';
const DEFAULT_SERVER_ROLE: McpServerRole = 'general';
const MAX_DECISION_HISTORY = 50;

/**
 * What the caller knows about the call: `workingDirectory` is where the server
 * resolves a relative path; `inputSchema` is the tool's input schema as the
 * server listed it, which says which arguments are paths or URIs.
 */
export interface McpReadingOwner {
  readonly externalRequestEvidence?: ExternalRequestEvidence | undefined;
  readonly workingDirectory?: string | undefined;
  readonly inputSchema?: Readonly<Record<string, unknown>> | undefined;
}

/** One argument value for a refusal: the argument name, the value (shortened) and where it resolves. */
function describeScoped(entry: ScopedValue & { readonly resolved?: string }): string {
  const value = entry.value.length > 120 ? `${entry.value.slice(0, 117)}...` : entry.value;
  const resolved = entry.resolved !== undefined && entry.resolved !== entry.value ? ` (resolves to ${entry.resolved})` : '';
  return `argument '${entry.argument || '(value)'}' = '${value}'${resolved}`;
}

function scopeLabel(items: readonly string[]): string {
  if (items.length === 0) return 'unbounded';
  if (items.length === 1) return items[0]!;
  return `${items.length} scopes`;
}

function severityForPosture(
  trustMode: McpTrustMode,
  schemaFreshness: import('./types.js').SchemaFreshness,
  allowedPaths: readonly string[],
  allowedHosts: readonly string[],
): import('./types.js').McpRiskLevel {
  if (schemaFreshness === 'quarantined' || trustMode === 'blocked') return 'critical';
  if (trustMode === 'allow-all') {
    if (allowedPaths.length === 0 || allowedHosts.length === 0) return 'critical';
    return 'high';
  }
  if (trustMode === 'ask-on-risk') {
    if (allowedPaths.length === 0 || allowedHosts.length === 0) return 'high';
    return 'medium';
  }
  if (allowedPaths.length === 0 || allowedHosts.length === 0) return 'medium';
  return 'low';
}

function verdictForPosture(
  trustMode: McpTrustMode,
  schemaFreshness: import('./types.js').SchemaFreshness,
): import('./types.js').McpCoherenceVerdict {
  if (schemaFreshness === 'quarantined' || trustMode === 'blocked') return 'deny';
  if (trustMode === 'allow-all') return 'allow';
  // A call inside the configured scope is allowed; one outside it is denied under
  // constrained and put to the owner under ask-on-risk (evaluateToolCall).
  return 'allow';
}

function reasonForPosture(
  serverName: string,
  role: McpServerRole,
  trustMode: McpTrustMode,
  schemaFreshness: import('./types.js').SchemaFreshness,
  allowedPaths: readonly string[],
  allowedHosts: readonly string[],
  quarantineReason?: import('./types.js').QuarantineReason,
  quarantineDetail?: string,
): string {
  if (schemaFreshness === 'quarantined') {
    return `schema for server '${serverName}' is quarantined${quarantineReason ? ` (${quarantineReason})` : ''}${quarantineDetail ? `: ${quarantineDetail}` : ''}`;
  }
  if (trustMode === 'blocked') {
    return `server '${serverName}' is blocked`;
  }
  if (trustMode === 'allow-all' && (allowedPaths.length === 0 || allowedHosts.length === 0)) {
    return `server '${serverName}' exposes an unbounded attack surface for ${role}`;
  }
  if (trustMode === 'allow-all') {
    return `server '${serverName}' is elevated to allow-all`;
  }
  if (trustMode === 'ask-on-risk' && (allowedPaths.length === 0 || allowedHosts.length === 0)) {
    return `server '${serverName}' is allowed inside its configured scope and still exposes broad scope`;
  }
  if (trustMode === 'ask-on-risk') {
    return `server '${serverName}' is allowed inside its configured scope; calls outside it are put to the owner`;
  }
  if (allowedPaths.length === 0 || allowedHosts.length === 0) {
    return `server '${serverName}' is constrained but still has an open scope boundary`;
  }
  return `server '${serverName}' is constrained and scoped`;
}

function postureRoute(
  serverName: string,
  role: McpServerRole,
  trustMode: McpTrustMode,
  allowedPaths: readonly string[],
  allowedHosts: readonly string[],
  schemaFreshness: import('./types.js').SchemaFreshness,
): string {
  return `${serverName} -> role:${role} -> trust:${trustMode} -> paths:${scopeLabel(allowedPaths)} -> hosts:${scopeLabel(allowedHosts)} -> schema:${schemaFreshness}`;
}

function sortFindings(a: McpAttackPathFinding, b: McpAttackPathFinding): number {
  const severityRank: Record<import('./types.js').McpRiskLevel, number> = {
    low: 0,
    medium: 1,
    high: 2,
    critical: 3,
  };
  const severityDelta = severityRank[b.severity] - severityRank[a.severity];
  if (severityDelta !== 0) return severityDelta;
  if (a.kind !== b.kind) return a.kind === 'server-posture' ? -1 : 1;
  return a.serverName.localeCompare(b.serverName);
}

// ── Manager ───────────────────────────────────────────────────────────────────

/**
 * Manages per-server permission state.
 *
 * Lifecycle:
 *   1. `registerServer(name, profile)`, called when a server transitions to configured/connecting.
 *   2. `setTrustMode(name, mode)` / `setServerRole(name, role)`, adjust policy at runtime.
 *   3. `allowTool(name, tool)` / `denyTool(name, tool)`, explicit overrides.
 *   4. `evaluateToolCall(name, tool, args)`, checked before every tool invocation.
 *   5. `removeServer(name)`, called on permanent disconnection.
 */
export class McpPermissionManager {
  private readonly permissions = new Map<string, McpServerPermissions>();
  private readonly recentDecisions: McpDecisionRecord[] = [];
  private readonly decisionListeners = new Set<() => void>();


  /** Be told whenever a decision is recorded. The listener carries no payload: read the recent decisions again. */
  subscribeDecisions(listener: () => void): () => void {
    this.decisionListeners.add(listener);
    return () => { this.decisionListeners.delete(listener); };
  }

  // ── Registration ─────────────────────────────────────────────────────────

  /**
   * Register a server, or refresh its config-derived profile.
   *
   * Called on every transition to configured/connecting, so it also runs when
   * a server is reconnected after its config was edited in place. When a
   * `profile` is supplied it is treated as the current policy and replaces the
   * stored fields it names; without one the call is a no-op for an
   * already-registered server. Per-tool overrides set through
   * {@link allowTool}/{@link denyTool} survive a refresh.
   *
   * @param serverName - Server identifier
   * @param profile    - Current profile (mode, role, scopes), if known
   */
  registerServer(
    serverName: string,
    profile?: Partial<McpServerPermissions['profile']>,
  ): void {
    const existing = this.permissions.get(serverName);
    if (existing) {
      if (!profile) return;
      const previous = existing.profile;
      const notes = profile.notes ?? previous.notes;
      existing.profile = {
        serverName,
        role: profile.role ?? previous.role,
        mode: profile.mode ?? previous.mode,
        allowedPaths: profile.allowedPaths ?? previous.allowedPaths,
        allowedHosts: profile.allowedHosts ?? previous.allowedHosts,
        ...(notes ? { notes } : {}),
        lastModifiedAt: Date.now(),
      };
      existing.lastModifiedAt = Date.now();
      logger.debug('McpPermissionManager: server profile refreshed from config', { serverName });
      return;
    }
    this.permissions.set(serverName, {
      serverName,
      profile: {
        serverName,
        role: profile?.role ?? DEFAULT_SERVER_ROLE,
        mode: profile?.mode ?? DEFAULT_TRUST_MODE,
        allowedPaths: profile?.allowedPaths ?? [],
        allowedHosts: profile?.allowedHosts ?? [],
        ...(profile?.notes ? { notes: profile.notes } : {}),
        lastModifiedAt: Date.now(),
      },
      toolOverrides: new Map(),
      lastModifiedAt: Date.now(),
    });
    logger.debug('McpPermissionManager: server registered', { serverName, mode: profile?.mode ?? DEFAULT_TRUST_MODE });
  }

  /**
   * Remove all permission state for a server.
   *
   * @param serverName - Server identifier
   */
  removeServer(serverName: string): void {
    if (this.permissions.delete(serverName)) {
      logger.debug('McpPermissionManager: server removed', { serverName });
    }
  }

  // ── Trust mode and role ───────────────────────────────────────────────────

  setTrustMode(serverName: string, mode: McpTrustMode): void {
    const record = this._getRequired(serverName);
    record.profile.mode = mode;
    record.lastModifiedAt = Date.now();
    record.profile.lastModifiedAt = record.lastModifiedAt;
  }

  getTrustMode(serverName: string): McpTrustMode | null {
    return this.permissions.get(serverName)?.profile.mode ?? null;
  }

  setServerRole(serverName: string, role: McpServerRole): void {
    const record = this._getRequired(serverName);
    record.profile.role = role;
    record.lastModifiedAt = Date.now();
    record.profile.lastModifiedAt = record.lastModifiedAt;
  }

  listProfiles(): Array<McpServerPermissions['profile']> {
    return Array.from(this.permissions.values()).map((record) => ({ ...record.profile }));
  }

  // ── Tool overrides ────────────────────────────────────────────────────────

  /**
   * Explicitly allow a tool on a server, overriding any deny.
   *
   * @param serverName - Server identifier
   * @param toolName   - Tool name on the server (not qualified)
   * @param note       - Optional reason for the override
   * @throws {Error} If the server is not registered
   */
  allowTool(serverName: string, toolName: string, note?: string): void {
    const record = this._getRequired(serverName);
    record.toolOverrides.set(toolName, { toolName, verdict: 'allow', note });
    record.lastModifiedAt = Date.now();
    logger.debug('McpPermissionManager: tool allowed', { serverName, toolName });
  }

  /**
   * Explicitly deny a tool on a server, whatever its trust mode allows.
   *
   * @param serverName - Server identifier
   * @param toolName   - Tool name on the server (not qualified)
   * @param note       - Optional reason for the denial
   * @throws {Error} If the server is not registered
   */
  denyTool(serverName: string, toolName: string, note?: string): void {
    const record = this._getRequired(serverName);
    record.toolOverrides.set(toolName, { toolName, verdict: 'deny', note });
    record.lastModifiedAt = Date.now();
    logger.debug('McpPermissionManager: tool denied', { serverName, toolName });
  }

  /**
   * Remove a per-tool override, reverting to the trust mode and scopes.
   *
   * @param serverName - Server identifier
   * @param toolName   - Tool name on the server
   */
  clearToolOverride(serverName: string, toolName: string): void {
    const record = this.permissions.get(serverName);
    if (record?.toolOverrides.delete(toolName)) {
      record.lastModifiedAt = Date.now();
      logger.debug('McpPermissionManager: tool override cleared', { serverName, toolName });
    }
  }

  /**
   * Replace every per-tool override of a server at once, so the set its
   * configuration and this session give is exactly the set in force.
   *
   * @throws {Error} If the server is not registered
   */
  replaceToolOverrides(serverName: string, overrides: readonly McpToolPermission[]): void {
    const record = this._getRequired(serverName);
    record.toolOverrides = new Map(overrides.map((override) => [override.toolName, { ...override }]));
    record.lastModifiedAt = Date.now();
  }

  // ── Permission check ──────────────────────────────────────────────────────

  async evaluateToolCall(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    owner: McpReadingOwner = {},
  ): Promise<McpPermission> {
    const permission = this._evaluateToolCall(serverName, toolName, args, owner);
    const profile = this.permissions.get(serverName)?.profile;
    if (profile) {
      this._recordDecision({
        serverName,
        toolName,
        // An ask is recorded as one: the owner's answer is recorded once, by the gate's admission record.
        verdict: permission.verdict ?? (permission.allowed ? 'allow' : 'deny'),
        riskLevel: severityForPosture(profile.mode, 'unknown', profile.allowedPaths, profile.allowedHosts),
        // A call the owner decides is not an incoherent decision; only a refused out-of-scope call is.
        incoherent: permission.verdict === 'deny' && (permission.causes?.length ?? 0) > 0,
        reason: permission.reason,
        profileMode: profile.mode,
        evaluatedAt: Date.now(),
      });
    }
    return permission;
  }

  /** Mode, override and scope, decided in code from what the record holds: no reading, no I/O beyond resolving paths. */
  private _evaluateToolCall(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    owner: McpReadingOwner,
  ): McpPermission {
    const record = this.permissions.get(serverName);
    if (!record) {
      return { allowed: false, reason: `server '${serverName}' is not registered`, verdict: 'deny' };
    }
    if (record.profile.mode === 'blocked') {
      return { allowed: false, reason: `server '${serverName}' is blocked`, verdict: 'deny', profileMode: record.profile.mode };
    }

    const override = record.toolOverrides.get(toolName);
    if (override) {
      const allow = override.verdict === 'allow';
      return {
        allowed: allow,
        reason: `tool '${toolName}' explicitly ${allow ? 'allowed' : 'denied'}${override.note ? ` (${override.note})` : ''}`,
        verdict: allow ? 'allow' : 'deny',
        profileMode: record.profile.mode,
      };
    }

    const profile = record.profile;
    const scoped = readScopedValues(args, { paths: profile.allowedPaths.length > 0, hosts: profile.allowedHosts.length > 0 }, owner.inputSchema);
    const outsidePath = pathOutsideScope(profile.allowedPaths, scoped.paths, owner.workingDirectory);
    const outsideHost = hostOutsideScope(profile.allowedHosts, scoped.hosts);
    const causes = [
      ...(outsidePath ? ['path-out-of-scope' as const] : []),
      ...(outsideHost ? ['host-out-of-scope' as const] : []),
    ];
    const allowed = profile.mode === 'allow-all' || causes.length === 0;
    const details = [
      ...(outsidePath ? [`${describeScoped(outsidePath)} is outside allowedPaths (${profile.allowedPaths.join(', ')})`] : []),
      ...(outsideHost ? [`${describeScoped(outsideHost)} is not an allowed host (${profile.allowedHosts.join(', ')})`] : []),
    ];
    // ask-on-risk: a call outside the scope is the owner's to allow, never refused unasked.
    const asks = !allowed && profile.mode === 'ask-on-risk';
    return {
      allowed, verdict: allowed ? 'allow' : asks ? 'ask' : 'deny', profileMode: profile.mode, causes,
      ...(asks ? { askOwner: `The MCP server '${serverName}' is trusted ask-on-risk and this call to '${toolName}' is outside its configured scope: ${details.join('; ')}.` } : {}),
      reason: allowed
        ? `server '${serverName}' permits this tool`
        : asks
          ? `request exceeds configured scope for server '${serverName}' (ask-on-risk), so the owner decides it: ${details.join('; ')}.`
          : `request exceeds configured scope for server '${serverName}': ${details.join('; ')}. Call it with values inside the scope, or ask the owner to widen the server's scope.`,
    };
  }

  // ── Inspection ────────────────────────────────────────────────────────────

  /**
   * Return a snapshot of permission state for a server, or `null` if not registered.
   *
   * @param serverName - Server identifier
   */
  getServerPermissions(serverName: string): McpServerPermissions | null {
    return this.permissions.get(serverName) ?? null;
  }

  listRecentDecisions(limit = 10): McpDecisionRecord[] {
    return this.recentDecisions.slice(0, Math.max(0, limit));
  }

  buildAttackPathReview(servers: readonly McpSecuritySnapshot[], recentDecisions: readonly McpDecisionRecord[] = []): McpAttackPathReview {
    return buildMcpAttackPathReview({ servers, recentDecisions });
  }

  /** All registered server names. */
  get serverNames(): string[] {
    return Array.from(this.permissions.keys());
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private _getRequired(serverName: string): McpServerPermissions {
    const record = this.permissions.get(serverName);
    if (!record) {
      throw new Error(`McpPermissionManager: server '${serverName}' is not registered`);
    }
    return record;
  }

  private _recordDecision(record: McpDecisionRecord): void {
    this.recentDecisions.unshift(record);
    if (this.recentDecisions.length > MAX_DECISION_HISTORY) {
      this.recentDecisions.length = MAX_DECISION_HISTORY;
    }
    for (const listener of [...this.decisionListeners]) {
      try { listener(); } catch (error) {
        logger.warn('McpPermissionManager: decision listener failed', { error: summarizeError(error) });
      }
    }
  }
}

export function buildMcpAttackPathReview(params: {
  servers: readonly McpSecuritySnapshot[];
  recentDecisions?: readonly McpDecisionRecord[] | undefined;
}): McpAttackPathReview {
  const findings: McpAttackPathFinding[] = [];
  let allowAllServers = 0;
  let askOnRiskServers = 0;
  let constrainedServers = 0;
  let blockedServers = 0;
  let quarantinedServers = 0;

  for (const server of params.servers) {
    if (server.trustMode === 'allow-all') allowAllServers += 1;
    else if (server.trustMode === 'ask-on-risk') askOnRiskServers += 1;
    else if (server.trustMode === 'constrained') constrainedServers += 1;
    else if (server.trustMode === 'blocked') blockedServers += 1;

    if (server.schemaFreshness === 'quarantined') quarantinedServers += 1;

    const severity = severityForPosture(server.trustMode, server.schemaFreshness, server.allowedPaths, server.allowedHosts);
    const verdict = verdictForPosture(server.trustMode, server.schemaFreshness);
    const incoherent = server.schemaFreshness === 'quarantined'
      || server.trustMode === 'allow-all'
      || server.allowedPaths.length === 0
      || server.allowedHosts.length === 0;
    findings.push({
      kind: 'server-posture',
      serverName: server.name,
      route: postureRoute(server.name, server.role, server.trustMode, server.allowedPaths, server.allowedHosts, server.schemaFreshness),
      verdict,
      severity,
      incoherent,
      reason: reasonForPosture(
        server.name,
        server.role,
        server.trustMode,
        server.schemaFreshness,
        server.allowedPaths,
        server.allowedHosts,
        server.quarantineReason,
        server.quarantineDetail,
      ),
      evidence: [
        `role=${server.role}`,
        `trustMode=${server.trustMode}`,
        `paths=${scopeLabel(server.allowedPaths)}`,
        `hosts=${scopeLabel(server.allowedHosts)}`,
        `schema=${server.schemaFreshness}`,
        ...(server.quarantineReason ? [`quarantine=${server.quarantineReason}`] : []),
        ...(server.quarantineDetail ? [`detail=${server.quarantineDetail}`] : []),
        ...(server.connected !== undefined ? [`connected=${server.connected}`] : []),
      ],
    });
  }

  let incoherentFindings = 0;
  for (const decision of params.recentDecisions ?? []) {
    const finding: McpAttackPathFinding = {
      kind: 'recent-decision',
      serverName: decision.serverName,
      toolName: decision.toolName,
      evaluatedAt: decision.evaluatedAt,
      route: `${decision.serverName}:${decision.toolName} -> ${decision.profileMode}`,
      verdict: decision.verdict,
      severity: decision.riskLevel,
      incoherent: decision.incoherent,
      reason: decision.reason,
      evidence: [
        `risk=${decision.riskLevel}`,
        `verdict=${decision.verdict}`,
        `mode=${decision.profileMode}`,
        `incoherent=${decision.incoherent}`,
      ],
    };
    if (decision.incoherent) incoherentFindings += 1;
    findings.push(finding);
  }

  findings.sort(sortFindings);
  const criticalFindings = findings.filter((finding) => finding.severity === 'high' || finding.severity === 'critical').length;
  const summary = findings.length === 0
    ? 'No MCP attack-path findings yet.'
    : `${criticalFindings} high-risk findings across ${params.servers.length} servers${incoherentFindings > 0 ? `, including ${incoherentFindings} incoherent decision${incoherentFindings === 1 ? '' : 's'}` : ''}.`;

  return {
    reviewedAt: Date.now(),
    totalServers: params.servers.length,
    connectedServers: params.servers.filter((server) => server.connected).length,
    allowAllServers,
    askOnRiskServers,
    constrainedServers,
    blockedServers,
    quarantinedServers,
    incoherentFindings,
    criticalFindings,
    findings,
    summary,
  };
}
