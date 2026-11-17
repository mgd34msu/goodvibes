import { deriveContextUsage } from './context-usage.js';
import { getAutoCompactDecision, readAutoCompactThreshold } from '../core/context-compaction.js';
import type { ConfigManager } from '../config/manager.js';
import type { SessionDomainState } from './store/domains/session.js';

export type GuidanceMode = 'off' | 'minimal' | 'guided';
export type SessionMaintenanceLevel =
  | 'stable'
  | 'watch'
  | 'suggest-compact'
  | 'compacting'
  | 'needs-repair'
  | 'unknown';

export interface SessionMaintenanceStatus {
  readonly level: SessionMaintenanceLevel;
  readonly guidanceMode: GuidanceMode;
  readonly usagePct: number | null;
  readonly remainingTokens: number | null;
  readonly thresholdPct: number;
  readonly autoCompactEnabled: boolean;
  readonly compactRecommended: boolean;
  readonly sessionMemoryCount: number;
  readonly compactionCount: number;
  readonly lastCompactedAt?: number | undefined;
  readonly summary: string;
  readonly reasons: readonly string[];
  readonly nextSteps: readonly string[];
}

export interface SessionMaintenanceInput {
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly currentTokens: number;
  readonly contextWindow: number | null;
  readonly messageCount?: number | undefined;
  readonly sessionMemoryCount?: number | undefined;
  readonly session?: Partial<SessionDomainState> | undefined;
}

export function getGuidanceMode(configManager: Pick<ConfigManager, 'get'>): GuidanceMode {
  return (configManager.get('behavior.guidanceMode') as GuidanceMode | undefined) ?? 'minimal';
}

function compactStateIsActive(state: SessionDomainState['compactionState'] | undefined): boolean {
  return state === 'checking_threshold'
    || state === 'microcompact'
    || state === 'collapse'
    || state === 'autocompact'
    || state === 'reactive_compact'
    || state === 'boundary_commit';
}

/** Below this usage, a long conversation is not a reason to watch context growth. */
const MESSAGE_GROWTH_USAGE_FLOOR_PCT = 50;

function formatAge(ts: number | undefined): string {
  if (!ts) return 'never';
  const ageMs = Date.now() - ts;
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function evaluateSessionMaintenance(input: SessionMaintenanceInput): SessionMaintenanceStatus {
  const guidanceMode = getGuidanceMode(input.configManager);
  // The same threshold the orchestrator compacts at (0 when auto-compaction is off).
  const thresholdPct = Math.max(0, readAutoCompactThreshold(input.configManager));
  const autoCompactEnabled = thresholdPct > 0;
  const currentTokens = Math.max(0, input.currentTokens);
  const { contextUsagePct: usagePct, contextRemainingTokens: remainingTokens } = deriveContextUsage(currentTokens, input.contextWindow);
  const sessionMemoryCount = Math.max(0, input.sessionMemoryCount ?? 0);
  const compactionCount = Math.max(0, input.session?.lineage?.filter((entry) => entry.branchReason === 'compaction').length ?? 0);
  const lastCompactedAt = input.session?.lastCompactedAt;
  const messageCount = Math.max(0, input.messageCount ?? 0);
  const warningsEnabled = Boolean(input.configManager.get('behavior.staleContextWarnings'));

  // Nothing counted yet: there is no pressure to report, whatever the window says.
  if (usagePct === null || remainingTokens === null || currentTokens === 0) {
    return {
      level: 'unknown',
      guidanceMode,
      usagePct,
      remainingTokens,
      thresholdPct,
      autoCompactEnabled,
      compactRecommended: false,
      sessionMemoryCount,
      compactionCount,
      lastCompactedAt,
      summary: usagePct === null ? 'Context window unavailable.' : 'No context counted yet.',
      reasons: [usagePct === null ? 'Current model does not expose a known context limit yet.' : 'Context usage is known after the first model response.'],
      nextSteps: guidanceMode === 'off' ? [] : ['/provider', '/context'],
    };
  }

  // The engine's own rule (core/context-compaction.ts), with the inputs the orchestrator gives it.
  const decision = getAutoCompactDecision({ currentTokens, contextWindow: input.contextWindow ?? 0, isCompacting: false, thresholdPercent: thresholdPct });
  // With auto-compaction off nothing compacts on its own: recommend /compact past the configured
  // threshold (kept even while compaction is off) or inside the engine's safety buffer.
  const configuredThreshold = Math.max(0, Number(input.configManager.get('behavior.autoCompactThreshold') ?? 0));
  const compactNeeded = autoCompactEnabled
    ? decision.shouldCompact
    : decision.reason === 'safety-buffer' || (configuredThreshold > 0 && usagePct >= configuredThreshold);
  // Message growth alone says nothing while the window is mostly empty.
  const staleByMessageGrowth = usagePct >= MESSAGE_GROWTH_USAGE_FLOOR_PCT && (
    (input.session?.compactionMessageCount ?? 0) > 0
      ? messageCount - (input.session?.compactionMessageCount ?? 0) >= 12
      : messageCount >= 24);

  const reasons: string[] = [];
  const nextSteps: string[] = [];
  let level: SessionMaintenanceLevel = 'stable';

  if (input.session?.compactionState === 'failed') {
    level = 'needs-repair';
    reasons.push('Compaction failed and the session may need manual recovery.');
    nextSteps.push('/compact', '/health review');
  } else if (compactStateIsActive(input.session?.compactionState)) {
    level = 'compacting';
    reasons.push('Compaction is currently running.');
  } else if (compactNeeded) {
    level = 'suggest-compact';
    reasons.push(`Context pressure is high at ${usagePct}% usage.`);
    if (decision.reason === 'safety-buffer') {
      reasons.push(`Only ${remainingTokens.toLocaleString()} tokens remain before the window edge.`);
    }
    if (autoCompactEnabled) reasons.push('Auto-compact runs before the next turn.');
    nextSteps.push('/compact', '/panel tokens');
  } else if ((warningsEnabled && usagePct >= Math.max(70, autoCompactEnabled ? thresholdPct - 10 : 70)) || staleByMessageGrowth) {
    level = 'watch';
    reasons.push(staleByMessageGrowth
      ? `Conversation has grown ${messageCount.toLocaleString()} messages since the last maintenance checkpoint.`
      : autoCompactEnabled
        ? `Context usage is climbing toward the ${thresholdPct}% auto-compact threshold.`
        : `Context usage is high (${usagePct}%) and auto-compaction is off.`);
    nextSteps.push('/panel tokens');
    if (guidanceMode === 'guided') nextSteps.push('/context');
  } else {
    reasons.push('Context pressure is currently within the stable operating band.');
  }

  if (sessionMemoryCount > 0) {
    reasons.push(`${sessionMemoryCount} pinned session memor${sessionMemoryCount === 1 ? 'y is' : 'ies are'} preserved during compaction.`);
  }
  if (compactionCount > 0) {
    reasons.push(`Last compaction ran ${formatAge(lastCompactedAt)}.`);
  }
  if (!autoCompactEnabled) {
    reasons.push('Auto-compaction is disabled; maintenance stays fully manual.');
    if (guidanceMode !== 'off') nextSteps.push('/settings');
  }

  const compactRecommended = level === 'suggest-compact' || level === 'needs-repair';
  const summary =
    level === 'needs-repair'
      ? 'Compaction needs operator repair.'
      : level === 'compacting'
        ? 'Compaction in progress.'
        : level === 'suggest-compact'
          ? (autoCompactEnabled
            ? `Context high (${usagePct}% used): auto-compact runs before the next turn.`
            : `Compact now to recover context headroom (${usagePct}% used).`)
          : level === 'watch'
            ? (autoCompactEnabled
              ? `Watch context growth (${usagePct}% used, threshold ${thresholdPct}%).`
              : `Watch context growth (${usagePct}% used, auto-compaction off).`)
            : 'Session maintenance is stable.';

  return {
    level,
    guidanceMode,
    usagePct,
    remainingTokens,
    thresholdPct,
    autoCompactEnabled,
    compactRecommended,
    sessionMemoryCount,
    compactionCount,
    lastCompactedAt,
    summary,
    reasons,
    nextSteps: [...new Set(nextSteps)],
  };
}

export function formatSessionMaintenanceLines(
  status: SessionMaintenanceStatus,
  detail: 'minimal' | 'guided' = 'minimal',
): string[] {
  const lines = [
    `Maintenance: ${status.summary}`,
  ];
  if (detail === 'guided') {
    for (const reason of status.reasons) lines.push(`  ${reason}`);
  } else if (status.reasons[0]) {
    lines.push(`  ${status.reasons[0]}`);
  }
  const nextSteps = status.nextSteps.length > 0
    ? status.nextSteps
    : detail === 'guided'
      ? ['/context']
      : [];
  if ((detail === 'guided' || status.guidanceMode !== 'off') && nextSteps.length > 0) {
    lines.push(`  Next: ${nextSteps.join('  |  ')}`);
  }
  return lines;
}
