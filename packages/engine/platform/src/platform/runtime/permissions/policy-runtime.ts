import { PolicyRegistry } from './policy-registry.js';
import { DivergencePanel } from '../diagnostics/panels/divergence.js';
import type { PolicyPanelSnapshot } from '../diagnostics/panels/policy.js';
import { PolicyPanel as PolicyDiagnosticsPanel } from '../diagnostics/panels/policy.js';
import type { DivergenceDashboard } from './divergence-dashboard.js';
import type { PermissionCheckResult } from '../../permissions/types.js';
import { lintPolicyConfig, type PolicyLintFinding } from './lint.js';
import type { PolicySimulationSummary } from './simulation-scenarios.js';
import type { PolicyPreflightReview } from './preflight.js';

const MAX_PERMISSION_AUDIT = 100;

export interface PermissionAuditEntry {
  readonly autonomousDecision?: PermissionCheckResult['autonomousDecision'];
  readonly callId: string;
  readonly tool: string;
  readonly category: string;
  readonly approved?: boolean | undefined;
  readonly sourceLayer?: string | undefined;
  readonly reasonCode?: string | undefined;
  readonly riskLevel: string;
  readonly classification: string;
  readonly summary: string;
  readonly reasons: readonly string[];
  readonly target?: string | undefined;
  readonly host?: string | undefined;
  readonly requestedAt: number;
  readonly decidedAt?: number | undefined;
  readonly persisted?: boolean | undefined;
}

export class PolicyRuntimeState {
  private readonly _registry: PolicyRegistry;
  private _dashboard: DivergenceDashboard | null = null;
  private _divergencePanel: DivergencePanel | null = null;
  private readonly _recentPermissionAudit: PermissionAuditEntry[] = [];
  private _lastSimulationSummary: PolicySimulationSummary | null = null;
  private _lastPreflightReview: PolicyPreflightReview | null = null;
  private readonly _subscribers = new Set<() => void>();
  private readonly _decisionListeners = new Set<(entry: PermissionAuditEntry) => void>();
  /** The findings of the last lint read of the loaded bundles (refreshLint). */
  private _lintFindings: readonly PolicyLintFinding[] = [];
  /** Why the bundle named by `policy.bundlePath` did not load, or null when it loaded or none is configured. */
  private _configuredBundleFailure: string | null = null;

  public constructor(registry: PolicyRegistry = new PolicyRegistry()) {
    this._registry = registry;
  }

  /** The calls this installation's permission audit recorded, newest first: the evidence a candidate bundle is reviewed against. */
  public getRecentPermissionAudit(): readonly PermissionAuditEntry[] {
    return [...this._recentPermissionAudit];
  }

  public getRegistry(): PolicyRegistry {
    return this._registry;
  }

  public getConfiguredBundleFailure(): string | null {
    return this._configuredBundleFailure;
  }

  public recordConfiguredBundleFailure(reason: string | null): void {
    this._configuredBundleFailure = reason;
    this.notify();
  }

  public getDashboard(): DivergenceDashboard | null {
    return this._dashboard;
  }

  public getDivergencePanel(): DivergencePanel | null {
    return this._divergencePanel;
  }

  public setDashboard(dashboard: DivergenceDashboard | null): void {
    this._divergencePanel?.dispose();
    this._dashboard = dashboard;
    this._divergencePanel = dashboard ? new DivergencePanel(dashboard) : null;
    this.notify();
  }

  public recordTrendEntry(): void {
    this._divergencePanel?.recordTrendEntry();
    this.notify();
  }

  public getSnapshot(): PolicyPanelSnapshot {
    const lintFindings = this._lintFindings;
    const panel = new PolicyDiagnosticsPanel(
      this._registry,
      this._divergencePanel,
      this._recentPermissionAudit,
      lintFindings,
      this._lastSimulationSummary,
      this._lastPreflightReview,
    );
    return { ...panel.getSnapshot(), configuredBundleFailure: this._configuredBundleFailure };
  }

  /**
   * Reads the loaded bundles' lint findings (pattern breadth is a Jev
   * reading) and keeps them for the snapshot. The /policy load, promote,
   * rollback, lint and preflight commands call it; a JudgmentError propagates.
   */
  public async refreshLint(registry: PolicyRegistry = this._registry): Promise<readonly PolicyLintFinding[]> {
    const current = registry.getCurrent();
    const candidate = registry.getCandidate();
    const findings = [
      ...(current ? await lintPolicyConfig({ mode: 'custom', rules: current.rules }) : []),
      ...(candidate ? await lintPolicyConfig({ mode: 'custom', rules: candidate.rules }) : []),
    ];
    // A newer bundle may have been loaded while a judgment reader was pending.
    // Return this read to its caller, but never replace the newer snapshot.
    if (registry.getCurrent() === current && registry.getCandidate() === candidate) {
      this._lintFindings = findings;
      this.notify();
    }
    return findings;
  }

  public recordSimulationSummary(summary: PolicySimulationSummary): void {
    this._lastSimulationSummary = summary;
    this.notify();
  }

  public recordPreflightReview(review: PolicyPreflightReview): void {
    this._lastPreflightReview = review;
    this.notify();
  }

  public recordPermissionRequest(params: {
    callId: string;
    tool: string;
    category: string;
    analysis: PermissionCheckResult['analysis'];
  }): void {
    this._upsertPermissionAudit({
      callId: params.callId,
      tool: params.tool,
      category: params.category,
      riskLevel: params.analysis.riskLevel,
      classification: params.analysis.classification,
      summary: params.analysis.summary,
      reasons: params.analysis.reasons,
      target: params.analysis.target,
      host: params.analysis.host,
      requestedAt: Date.now(),
    });
    this.notify();
  }

  public recordPermissionDecision(params: {
    callId: string;
    tool: string;
    category: string;
    result: PermissionCheckResult;
  }): void {
    const entry: PermissionAuditEntry = {
      callId: params.callId,
      tool: params.tool,
      category: params.category,
      approved: params.result.approved,
      autonomousDecision: params.result.autonomousDecision,
      sourceLayer: params.result.sourceLayer,
      reasonCode: params.result.reasonCode,
      riskLevel: params.result.analysis.riskLevel,
      classification: params.result.analysis.classification,
      summary: params.result.analysis.summary,
      reasons: params.result.analysis.reasons,
      target: params.result.analysis.target,
      host: params.result.analysis.host,
      requestedAt: Date.now(),
      decidedAt: Date.now(),
      persisted: params.result.persisted,
    };
    this._upsertPermissionAudit(entry);
    for (const listener of this._decisionListeners) {
      try { listener(entry); } catch { /* a listener never breaks the audit */ }
    }
    this.notify();
  }

  /**
   * Told of each call this gate decides, as it is recorded: a terminal program posts them to the daemon's audit
   * (permissions.audit.post), where a candidate policy is reviewed against every program's calls. Returns the stop.
   */
  public onDecision(listener: (entry: PermissionAuditEntry) => void): () => void {
    this._decisionListeners.add(listener);
    return () => { this._decisionListeners.delete(listener); };
  }

  /**
   * The calls a terminal program's gate decided, posted to the daemon (routes/policy-audit.ts): kept beside the
   * daemon's own, each once by its id, so reviewing a candidate decides them again too. Returns how many were kept.
   */
  public recordReportedDecisions(entries: readonly PermissionAuditEntry[]): number {
    for (const entry of entries) this._upsertPermissionAudit(entry);
    if (entries.length > 0) this.notify();
    return entries.length;
  }

  public subscribe(callback: () => void): () => void {
    this._subscribers.add(callback);
    return () => {
      this._subscribers.delete(callback);
    };
  }

  public notify(): void {
    for (const cb of this._subscribers) {
      try {
        cb();
      } catch {
        // Panel/runtime subscribers must not break policy state propagation.
      }
    }
  }

  private _upsertPermissionAudit(entry: PermissionAuditEntry): void {
    const existingIndex = this._recentPermissionAudit.findIndex((candidate) => candidate.callId === entry.callId);
    if (existingIndex >= 0) {
      this._recentPermissionAudit[existingIndex] = {
        ...this._recentPermissionAudit[existingIndex],
        ...entry,
        requestedAt: this._recentPermissionAudit[existingIndex]?.requestedAt ?? entry.requestedAt,
      };
    } else {
      this._recentPermissionAudit.unshift(entry);
      if (this._recentPermissionAudit.length > MAX_PERMISSION_AUDIT) {
        this._recentPermissionAudit.length = MAX_PERMISSION_AUDIT;
      }
    }
  }
}
