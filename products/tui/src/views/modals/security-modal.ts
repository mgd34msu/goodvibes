import { MODAL_TONES } from './modal-theme.ts';
import { infoRow, headerRow, runModalCommand } from './modal-surface-helpers.ts';
import type { TokenAuditResult } from '@goodvibes-jev/engine/platform/platform/security';
import { registerThemeRefresh } from '../../renderer/theme.ts';
import type { ModalSectionStyle } from '../../input/config-modal-types.ts';
import type { UiReadModel, UiSecuritySnapshot } from '../../runtime/ui-read-models.ts';
import type {
  ConfigModalActionContext,
  ConfigModalRow,
  ConfigModalSurface,
  ConfigModalTab,
  ConfigModalView,
} from '../../input/config-modal-types.ts';

// ---------------------------------------------------------------------------
// Security → config-modal surface (group-B port). Two tabs: 'Tokens' (the
// token scope/rotation audit list under the governance summary) and
// 'Governance' (policy preflight, MCP/plugin quarantine, latest incident, and
// the MCP attack-path review). Read-model-backed: buildView reads the snapshot,
// which shows the last token audit of record and never audits on a read. 'r'
// runs an audit; 'f' (preflight) routes to `/policy preflight`; 'i' opens the
// latest incident (its agent in /agents when it names one, else /forensics
// latest). Selection-blind port: the earlier view's
// selected-token scope/rotation detail is folded into each token row label.
// Determinism: absolute ISO timestamps (never Date.now()).
// ---------------------------------------------------------------------------

export interface SecurityModalDeps {
  readonly readModel: UiReadModel<UiSecuritySnapshot> & {
    /** Run one token audit of record; absent on a surface that cannot audit. */
    readonly runAudit?: () => { readonly totalTokens: number; readonly findings: number; readonly at: number };
  };
}

const BAD: ModalSectionStyle = { fg: MODAL_TONES.bad };
const WARN: ModalSectionStyle = { fg: MODAL_TONES.warn };
// Rebuilt in place on theme change (MODAL_TONES refreshes first: it registers at its own module eval).
registerThemeRefresh(() => {
  Object.assign(BAD, { fg: MODAL_TONES.bad });
  Object.assign(WARN, { fg: MODAL_TONES.warn });
});
const MAX_FINDINGS_SHOWN = 5;

function resultColor(result: TokenAuditResult): ModalSectionStyle | undefined {
  if (result.blocked) return BAD;
  if (result.scope.outcome === 'violation') return BAD;
  if (result.rotation.outcome === 'overdue') return BAD;
  if (result.rotation.outcome === 'warning') return WARN;
  return undefined;
}

function resultSummary(result: TokenAuditResult): string {
  const parts: string[] = [];
  if (result.scope.outcome === 'violation') parts.push(`scope:${result.scope.excessScopes.join(',')}`);
  if (result.rotation.outcome === 'warning') parts.push('rotation warning');
  if (result.rotation.outcome === 'overdue') parts.push('rotation overdue');
  if (result.blocked) parts.push('blocked');
  return parts.length > 0 ? parts.join(' | ') : 'in policy';
}

function fmtDue(msUntilDue: number): string {
  const overdue = msUntilDue < 0;
  const sec = Math.floor(Math.abs(msUntilDue) / 1000);
  const unit = sec < 3600 ? `${Math.max(1, Math.floor(sec / 60))}m` : sec < 86400 ? `${Math.floor(sec / 3600)}h` : `${Math.floor(sec / 86400)}d`;
  return overdue ? `overdue by ${unit}` : `in ${unit}`;
}

function fmtIso(ts: number | null | undefined): string {
  return ts === null || ts === undefined ? 'never' : new Date(ts).toISOString();
}

function findingColor(severity: string): ModalSectionStyle | undefined {
  return severity === 'critical' || severity === 'high' ? BAD : severity === 'medium' ? WARN : undefined;
}

class SecurityModalSurface implements ConfigModalSurface {
  readonly name = 'security-modal';
  readonly title = 'Security Control Room';
  private requestRender: () => void = () => {};
  private unsub: (() => void) | null = null;

  constructor(private readonly deps: SecurityModalDeps) {}

  readonly actions = [
    { key: 'f', id: 'preflight', label: 'preflight' },
    { key: 'i', id: 'jumpToIncident', label: 'jump to incident', enabledFor: () => Boolean(this.deps.readModel.getSnapshot().latestIncident) },
    { key: 'd', id: 'manageDevices', label: 'manage devices' },
    { key: 'r', id: 'refresh', label: 'run audit', enabledFor: () => typeof this.deps.readModel.runAudit === 'function' },
  ];

  onOpen(requestRender: () => void): void {
    this.requestRender = requestRender;
    if (!this.unsub) this.unsub = this.deps.readModel.subscribe(() => this.requestRender());
  }

  onClose(): void { this.unsub?.(); this.unsub = null; }

  private governanceHeader(snapshot: UiSecuritySnapshot): string[] {
    const audit = snapshot.audit;
    const quarantinedMcp = snapshot.mcpServers.filter((s) => s.schemaFreshness === 'quarantined');
    const elevatedMcp = snapshot.mcpServers.filter((s) => s.trustMode === 'allow-all');
    return [
      `mode ${audit.managed ? 'MANAGED' : 'ADVISORY'}  tokens ${audit.totalTokens}  blocked ${audit.blocked.length}  scope violations ${audit.scopeViolations.length}  overdue ${audit.rotationOverdue.length}  warnings ${audit.rotationWarnings.length}`,
      `preflight ${snapshot.policy.preflightStatus.toUpperCase()}  issues ${snapshot.policy.preflightIssueCount}  lint ${snapshot.policy.lintFindingCount}  denied permissions ${snapshot.deniedPermissions}`,
      `quarantined MCP ${quarantinedMcp.length}  elevated MCP ${elevatedMcp.length}  quarantined plugins ${snapshot.quarantinedPlugins.length}  untrusted plugins ${snapshot.untrustedPlugins.length}`,
      `incidents ${snapshot.incidents.length}`,
    ];
  }

  private tokensTab(snapshot: UiSecuritySnapshot): ConfigModalTab {
    const audit = snapshot.audit;
    const header = this.governanceHeader(snapshot);
    const rows: ConfigModalRow[] = [];

    if (audit.results.length === 0 && audit.totalTokens > 0) {
      rows.push(infoRow('unaudited', `${audit.totalTokens} token${audit.totalTokens === 1 ? ' is' : 's are'} registered and not audited yet: press Ctrl+R to audit now.`, WARN));
      return { id: 'tokens', label: 'Tokens', header, rows, emptyText: '' };
    }
    if (audit.results.length === 0) {
      const quarantinedMcp = snapshot.mcpServers.filter((s) => s.schemaFreshness === 'quarantined');
      rows.push(infoRow('empty:0', 'No tokens are registered with the security auditor: no device is paired here.'));
      rows.push(infoRow('empty:1', 'Paired devices appear here with their age and rotation due date once paired (d manage devices).', { fg: MODAL_TONES.dim }));
      if (quarantinedMcp.length > 0) rows.push(infoRow('empty:mcp', 'MCP quarantine still active despite no registered tokens.', WARN));
      rows.push(headerRow('empty:title', 'Inspect further'));
      rows.push(infoRow('empty:storage', '/storage review — inspect secure secret storage and environment overrides', { fg: MODAL_TONES.dim }));
      rows.push(infoRow('empty:mcptrust', '/mcp trust      — inspect active MCP trust and quarantine posture', { fg: MODAL_TONES.dim }));
      return { id: 'tokens', label: 'Tokens', header, rows, emptyText: '' };
    }

    for (const result of audit.results) {
      const ageDays = Math.floor(result.rotation.ageMs / (24 * 60 * 60 * 1000));
      rows.push({
        id: result.tokenId,
        label: `${result.label.padEnd(22)} ${result.tokenId.padEnd(14)} ${result.scope.policyId.padEnd(12)} ${resultSummary(result)} · rot ${result.rotation.outcome}/${fmtDue(result.rotation.msUntilDue)} age ${ageDays}d${result.blocked ? ' · BLOCKED' : ''}`,
        ...(resultColor(result) ? { style: resultColor(result)! } : {}),
      });
    }
    rows.push(infoRow('audit:when', `Last audit ${fmtIso(audit.lastAuditAt)}: press Ctrl+R to audit now`, { fg: MODAL_TONES.dim }));
    return { id: 'tokens', label: 'Tokens', header, rows, hints: ['f preflight'] };
  }

  private governanceTab(snapshot: UiSecuritySnapshot): ConfigModalTab {
    const rows: ConfigModalRow[] = [];
    const quarantinedMcp = snapshot.mcpServers.filter((s) => s.schemaFreshness === 'quarantined');
    if (quarantinedMcp.length > 0) {
      const server = quarantinedMcp[0]!;
      rows.push(infoRow('mcp:q', `MCP quarantine: ${server.name} ${server.quarantineReason ?? 'unknown'}${server.quarantineDetail ? `; ${server.quarantineDetail}` : ''}`, BAD));
    }
    if (snapshot.quarantinedPlugins.length > 0) {
      const plugin = snapshot.quarantinedPlugins[0]!;
      rows.push(infoRow('plugin:q', `Plugin quarantine: ${plugin.name} (${plugin.trustTier})`, BAD));
    } else if (snapshot.untrustedPlugins.length > 0) {
      const plugin = snapshot.untrustedPlugins[0]!;
      rows.push(infoRow('plugin:u', `Plugin trust warning: ${plugin.name} remains untrusted.`, WARN));
    }
    if (snapshot.latestIncident) {
      rows.push(infoRow('incident', `Latest incident: ${snapshot.latestIncident.classification}; ${snapshot.latestIncident.summary} (${fmtIso(snapshot.latestIncident.generatedAt)})`, WARN));
    }

    const review = snapshot.attackPathReview;
    rows.push(headerRow('atk:title', 'MCP Attack-Path Review'));
    rows.push(infoRow('atk:counts', `critical ${review.criticalFindings}  incoherent ${review.incoherentFindings}`, review.criticalFindings > 0 ? BAD : { fg: MODAL_TONES.dim }));
    rows.push(infoRow('atk:summary', review.summary, { fg: MODAL_TONES.dim }));
    const shown = review.findings.slice(0, MAX_FINDINGS_SHOWN);
    shown.forEach((finding, i) => {
      rows.push(infoRow(`atk:${i}:h`, `${finding.severity.toUpperCase()} ${finding.serverName}: ${finding.route}`, findingColor(finding.severity)));
      rows.push(infoRow(`atk:${i}:r`, `  ${finding.reason}`, { fg: MODAL_TONES.dim }));
      rows.push(infoRow(`atk:${i}:e`, `  evidence: ${finding.evidence.join(' | ')}`, { fg: MODAL_TONES.dim }));
    });
    if (review.findings.length > shown.length) {
      const extra = review.findings.length - shown.length;
      rows.push(infoRow('atk:more', `+${extra} more finding${extra === 1 ? '' : 's'} not shown`, { fg: MODAL_TONES.dim }));
    }
    return { id: 'governance', label: 'Governance', rows, emptyText: 'No governance findings.' };
  }

  buildView(): ConfigModalView {
    const snapshot = this.deps.readModel.getSnapshot();
    return { title: 'Security Control Room', tabs: [this.tokensTab(snapshot), this.governanceTab(snapshot)] };
  }

  onAction(id: string, ctx: ConfigModalActionContext): void {
    if (id === 'refresh') {
      const runAudit = this.deps.readModel.runAudit;
      if (!runAudit) { ctx.setStatus('This surface cannot run a token audit.'); ctx.requestRender(); return; }
      try {
        const run = runAudit();
        ctx.setStatus(`Audited ${run.totalTokens} token${run.totalTokens === 1 ? '' : 's'}: ${run.findings === 0 ? 'all in policy' : `${run.findings} with findings`} (${fmtIso(run.at)}).`);
      } catch (error) {
        ctx.setStatus(`The token audit failed: ${error instanceof Error ? error.message : String(error)}.`);
      }
      ctx.requestRender();
      return;
    }
    if (id === 'preflight') { runModalCommand(ctx, 'policy', ['preflight'], '/policy preflight'); return; }
    const incident = id === 'jumpToIncident' ? this.deps.readModel.getSnapshot().latestIncident : null;
    if (incident) {
      if (incident.agentId) {
        runModalCommand(ctx, 'agents', ['--target', incident.agentId], `/agents --target ${incident.agentId}`, { pending: `Opening Agents on ${incident.agentId}.`, done: `Opened Agents on ${incident.agentId}.` });
      } else {
        runModalCommand(ctx, 'forensics', ['latest'], '/forensics latest', { pending: 'Opening the latest incident report.', done: 'Opened the latest incident report.' });
      }
      return;
    }
    if (id === 'manageDevices') {
      ctx.openModal?.('devices-modal');
      ctx.setStatus('Opened paired-device management.');
    }
  }
}

export function createSecurityModalSurface(deps: SecurityModalDeps): ConfigModalSurface {
  return new SecurityModalSurface(deps);
}
