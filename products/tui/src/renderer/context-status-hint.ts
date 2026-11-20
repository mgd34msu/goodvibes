/**
 * Context status hint.
 *
 * Produces a short, dismissible status-line hint when the session maintenance
 * level indicates compaction is recommended or repair is needed.  The hint is
 * passive and non-blocking: it appears in the footer status row and disappears
 * once the pressure signal clears.
 *
 * Honest wording policy:
 *  - suggest-compact → describes the situation and offers /compact
 *  - needs-repair    → names the failure state honestly without alarming
 *  - compacting      → shows in-progress text so the user knows something is running
 *  - watch           → no hint (not yet actionable)
 *  - stable/unknown  → no hint
 *
 * The level comes from `evaluateSessionMaintenance`, which reports the
 * compaction engine's own decision (and `unknown` before any context has been
 * counted), so "auto-compact will run" is said only when the engine will.
 */

import type { ViewSessionMaintenanceLevel } from '../views/session-maintenance.ts';

interface ContextStatusHintOptions {
  /** Maintenance level from evaluateSessionMaintenance. */
  readonly level: ViewSessionMaintenanceLevel;
  /** Whether auto-compaction is active (threshold > 0 in config). */
  readonly autoCompactEnabled: boolean;
  /** Current usage percent 0–100. */
  readonly usagePct: number | null;
}

/**
 * Build the passive status-line hint text for context pressure.
 *
 * Returns null when no hint is warranted (stable / watch / unknown). The
 * caller renders this as a dim informational line, no prompts, no blocking,
 * no confirmation required.
 */
function buildContextStatusHint(options: ContextStatusHintOptions): string | null {
  const { level, autoCompactEnabled, usagePct } = options;

  switch (level) {
    case 'needs-repair':
      return `  Context pressure critical (${usagePct ?? '?'}% used); compaction needs attention. Run /compact or /health check maintenance.`;

    case 'suggest-compact':
      if (autoCompactEnabled) {
        return `  Context high (${usagePct}% used): auto-compact will run before the next turn.`;
      }
      return `  Context high (${usagePct}% used): run /compact to recover headroom.`;

    case 'compacting':
      return `  Compacting context: freeing headroom...`;

    default:
      return null;
  }
}

/** Evaluate session maintenance for the given numbers and turn it into the footer hint. */
export function resolveContextStatusHint(input: {
  readonly evaluate: (args: { readonly currentTokens: number; readonly contextWindow: number }) => {
    readonly level: ViewSessionMaintenanceLevel;
    readonly autoCompactEnabled: boolean;
    readonly usagePct: number | null;
  };
  readonly currentTokens: number;
  readonly contextWindow: number;
}): string | null {
  const status = input.evaluate({ currentTokens: input.currentTokens, contextWindow: input.contextWindow });
  return buildContextStatusHint({
    level: status.level,
    autoCompactEnabled: status.autoCompactEnabled,
    usagePct: status.usagePct,
  });
}
