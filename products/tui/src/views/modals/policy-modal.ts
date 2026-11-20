import { MODAL_TONES } from './modal-theme.ts';
import { runModalCommand } from './modal-surface-helpers.ts';
import { buildPermissionRuleSuggestions } from '@/runtime/index.ts';
import type {
  DivergenceDashboardSnapshot,
  DivergenceStats,
  PermissionAuditEntry,
  PolicyBundleVersion,
  PolicyDiffResult,
  PolicyLintFinding,
  PolicyPreflightReview,
  PolicySimulationSummary,
} from '@/runtime/index.ts';
import { registerThemeRefresh } from '../../renderer/theme.ts';
import type { ModalSectionStyle } from '../../input/config-modal-types.ts';
import type {
  ConfigModalActionContext,
  ConfigModalRow,
  ConfigModalSurface,
  ConfigModalView,
} from '../../input/config-modal-types.ts';

// ---------------------------------------------------------------------------
// Policy → config-modal surface (group-B port). Governance CONTENT view,
// not a selectable list, current/candidate bundle state, diff, divergence
// gate, history, permission audit, lint findings, preflight review, and
// simulation samples render as non-selectable rows (the host windows/scrolls
// them). EVERY dispatchable key in the original view (s/f/l/p/b) already
// routes to a `/security` policy action via executeCommand, none are in-view mutations.
// Promote and rollback change the active enforcement bundle, so they use the
// host's standard second-press confirm (like device revoke and sandbox stop). Determinism:
// timestamps are formatted (fmtTime/fmtRate), never read from the clock.
// ---------------------------------------------------------------------------

export interface PolicyModalSnapshot {
  readonly current: PolicyBundleVersion | null;
  readonly candidate: PolicyBundleVersion | null;
  readonly history: readonly PolicyBundleVersion[];
  readonly diff: PolicyDiffResult | null;
  readonly divergence: DivergenceDashboardSnapshot | null;
  readonly recentPermissionAudit: readonly PermissionAuditEntry[];
  readonly lintFindings: readonly PolicyLintFinding[];
  readonly lastSimulationSummary: PolicySimulationSummary | null;
  readonly lastPreflightReview: PolicyPreflightReview | null;
  readonly capturedAt: string;
}

export interface PolicyModalDeps {
  readonly policyRuntimeState: { getSnapshot(): PolicyModalSnapshot };
}

const BAD: ModalSectionStyle = { fg: MODAL_TONES.bad };
const WARN: ModalSectionStyle = { fg: MODAL_TONES.warn };
const GOOD: ModalSectionStyle = { fg: MODAL_TONES.good };
// Rebuilt in place on theme change (MODAL_TONES refreshes first: it registers at its own module eval).
registerThemeRefresh(() => {
  Object.assign(BAD, { fg: MODAL_TONES.bad });
  Object.assign(WARN, { fg: MODAL_TONES.warn });
  Object.assign(GOOD, { fg: MODAL_TONES.good });
  Object.assign(DIM, { fg: MODAL_TONES.dim });
});
const DIM: ModalSectionStyle = { fg: MODAL_TONES.dim };
const MAX_ROWS = 5;

function fmtTime(value: string | undefined): string {
  if (!value) return 'n/a';
  return value.replace('T', ' ').slice(0, 19);
}

function fmtRate(value: number | undefined): string {
  if (value === undefined) return 'n/a';
  return `${(value * 100).toFixed(1)}%`;
}

function gateColor(status: string | undefined): ModalSectionStyle | undefined {
  switch (status) {
    case 'allowed': return GOOD;
    case 'blocked': return BAD;
    case 'no_data': return WARN;
    default: return DIM;
  }
}

function ruleLine(rule: { id: string; type: string; effect: string }): string {
  return `${rule.id} (${rule.type}, effect=${rule.effect})`;
}

class PolicyModalSurface implements ConfigModalSurface {
  readonly name = 'policy-modal';
  readonly title = 'Policy And Governance';

  constructor(private readonly deps: PolicyModalDeps) {}

  readonly actions = [
    { key: 's', id: 'simulate', label: 'simulate' },
    { key: 'f', id: 'preflight', label: 'preflight' },
    { key: 'l', id: 'lint', label: 'lint' },
    { key: 'p', id: 'promote', label: 'promote', confirm: true },
    { key: 'b', id: 'rollback', label: 'rollback', confirm: true },
  ];

  buildView(): ConfigModalView {
    const snapshot = this.deps.policyRuntimeState.getSnapshot();
    const preflight = snapshot.lastPreflightReview;
    const divergence = snapshot.divergence;
    const lintCount = snapshot.lintFindings.length;
    const preflightStatus = preflight ? preflight.status : 'none';
    const gateStatus = divergence?.gate.status ?? 'n/a';

    const header = [`bundles ${snapshot.current ? 1 : 0}+${snapshot.candidate ? 1 : 0}c  preflight ${preflightStatus.toUpperCase()}  gate ${gateStatus}  lint ${lintCount}`];

    const rows: ConfigModalRow[] = [];
    let n = 0;
    const push = (label: string, style?: ModalSectionStyle): void => { rows.push({ id: `row:${n++}`, label, selectable: false, ...(style ? { style } : {}) }); };

    const nothingRecorded = !snapshot.current && !snapshot.candidate && !divergence
      && snapshot.history.length === 0 && snapshot.recentPermissionAudit.length === 0
      && snapshot.lintFindings.length === 0 && !snapshot.lastSimulationSummary && !preflight;

    if (nothingRecorded) {
      push('No policy bundles loaded.');
      push('Bundle: none active, none candidate. Gate: n/a.', DIM);
      push('Get started');
      push('/security load-policy <file>: load a policy bundle to begin governance review', DIM);
      return { title: 'Policy And Governance', tabs: [{ id: 'governance', label: 'Governance', header, rows, emptyText: '' }] };
    }

    if (snapshot.current) {
      push('Current');
      push(`Bundle ${snapshot.current.bundle.bundleId}  State ${snapshot.current.state}`);
      push(`Loaded ${fmtTime(snapshot.current.loadedAt)}  Active ${fmtTime(snapshot.current.activatedAt)}`, DIM);
    }
    if (snapshot.candidate) {
      push('Candidate');
      push(`Bundle ${snapshot.candidate.bundle.bundleId}  State ${snapshot.candidate.state}`);
      push(`Loaded ${fmtTime(snapshot.candidate.loadedAt)}  Rules ${snapshot.candidate.rules.length}`, DIM);
    }
    if (snapshot.diff) {
      const diff = snapshot.diff;
      push('Diff');
      push(`${diff.fromBundleId} -> ${diff.toBundleId}  changes ${diff.totalChanges}`);
      if (diff.added.length > 0) { push('Added', GOOD); for (const r of diff.added.slice(0, MAX_ROWS)) push(`  + ${ruleLine(r)}`, DIM); }
      if (diff.removed.length > 0) { push('Removed', BAD); for (const r of diff.removed.slice(0, MAX_ROWS)) push(`  - ${ruleLine(r)}`, DIM); }
      if (diff.changed.length > 0) { push('Changed', WARN); for (const c of diff.changed.slice(0, MAX_ROWS)) push(`  ~ ${c.ruleId}`, DIM); }
    }
    if (divergence) {
      push('Governance Gate');
      push(`Mode ${divergence.mode}  Gate ${divergence.gate.status}  Divergence ${fmtRate(divergence.gate.divergenceRate ?? divergence.report.overall.divergenceRate)}`, gateColor(divergence.gate.status));
      push(`Evaluations ${divergence.report.overall.totalEvaluations}  Trend points ${divergence.trend.length}`, DIM);
      const prefixEntries = Object.entries(divergence.report.byCommandPrefix);
      if (prefixEntries.length > 0) {
        push('Divergence by command prefix', DIM);
        for (const [prefix, stats] of prefixEntries.slice(0, MAX_ROWS)) push(`  ${prefix}  ${fmtRate(stats.divergenceRate)}  ${stats.total}/${stats.totalEvaluations}`, stats.divergenceRate > 0 ? WARN : undefined);
      }
      const classEntries = Object.entries(divergence.report.byToolClass).filter((e): e is [string, DivergenceStats] => e[1] !== undefined);
      if (classEntries.length > 0) {
        push('Divergence by tool class', DIM);
        for (const [cls, stats] of classEntries.slice(0, MAX_ROWS)) push(`  ${cls}  ${fmtRate(stats.divergenceRate)}  ${stats.total}/${stats.totalEvaluations}`, stats.divergenceRate > 0 ? WARN : undefined);
      }
    }
    if (snapshot.history.length > 0) {
      push('History');
      for (const v of snapshot.history.slice(0, MAX_ROWS)) push(`${v.bundle.bundleId}  ${v.state}  ${fmtTime(v.activatedAt ?? v.loadedAt)}`, DIM);
    }
    if (snapshot.recentPermissionAudit.length > 0) {
      push('Permission Audit');
      for (const entry of snapshot.recentPermissionAudit.slice(0, MAX_ROWS)) {
        const outcome = entry.approved === undefined ? 'pending' : entry.approved ? 'approved' : 'denied';
        push(`${entry.tool}  ${entry.riskLevel.toUpperCase()}  ${outcome}`, entry.approved === undefined ? WARN : entry.approved ? undefined : BAD);
        push(`  ${entry.summary}`, DIM);
      }
      // Two or more denials of the same tool and target point at a rule worth storing or reviewing.
      const suggestions = buildPermissionRuleSuggestions(snapshot.recentPermissionAudit);
      if (suggestions.length > 0) {
        push('Suggested Rules');
        for (const suggestion of suggestions.slice(0, MAX_ROWS)) {
          push(suggestion.summary, WARN);
          push(`  ${suggestion.reason} (${suggestion.command})`, DIM);
        }
      }
    }
    if (snapshot.lintFindings.length > 0) {
      push('Policy Lint');
      for (const f of snapshot.lintFindings.slice(0, MAX_ROWS)) push(`${f.severity.toUpperCase()} ${f.message}`, f.severity === 'error' ? BAD : f.severity === 'warn' ? WARN : undefined);
    }
    if (preflight) {
      push('Preflight Review');
      push(`Status ${preflight.status.toUpperCase()}  Issues ${preflight.issueCount}  Generated ${fmtTime(preflight.generatedAt)}`, preflight.status === 'pass' ? GOOD : preflight.status === 'warn' ? WARN : BAD);
      push(preflight.summary, DIM);
      for (const issue of preflight.issues.slice(0, 4)) push(`${issue.severity.toUpperCase()} ${issue.message}`, issue.severity === 'error' ? BAD : issue.severity === 'warn' ? WARN : undefined);
    }
    if (snapshot.lastSimulationSummary) {
      const sim = snapshot.lastSimulationSummary;
      push('Simulation Samples');
      push(`Mode ${sim.mode}  Diverged ${sim.divergentScenarios}/${sim.totalScenarios}  Allowed(actual/sim) ${sim.allowedByActual}/${sim.allowedBySimulated}`, sim.divergentScenarios > 0 ? WARN : GOOD);
      for (const result of sim.results.slice(0, 4)) push(`${result.scenario.label}  ${(result.authoritativeDecision.allowed ? 'allow' : 'deny').toUpperCase()}  ${result.diverged ? (result.divergenceType ?? 'diverged') : 'aligned'}`, result.diverged ? WARN : (result.authoritativeDecision.allowed ? GOOD : BAD));
    }

    return { title: 'Policy And Governance', tabs: [{ id: 'governance', label: 'Governance', header, rows }] };
  }

  onAction(id: string, ctx: ConfigModalActionContext): void {
    // Each key runs the matching `/security` policy action. Enforce and go
    // back change the policy in force, so they use the host's second-press
    // confirm; that confirmation is the operator's yes to what simulate showed.
    const word: Readonly<Record<string, string>> = {
      simulate: 'simulate-policy', preflight: 'preflight', lint: 'lint-policy', promote: 'enforce-policy', rollback: 'restore-policy',
    };
    const action = word[id];
    if (!action) return;
    const args = id === 'promote' || id === 'rollback' ? [action, '--yes'] : [action];
    runModalCommand(ctx, 'security', args, `/security ${args.join(' ')}`);
  }
}

export function createPolicyModalSurface(deps: PolicyModalDeps): ConfigModalSurface {
  return new PolicyModalSurface(deps);
}
