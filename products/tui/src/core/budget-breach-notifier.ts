import { isConversationUsageAvailable } from './conversation-usage.ts';
/**
 * budget-breach-notifier, fires an unfocused-user alert the moment session
 * cost crosses the spending alert (behavior.budgetAlertUsd, the daemon's
 * setting, read at the turn's end from this program's copy of its settings).
 *
 * One-shot semantics: fires exactly once on the false→true edge (crossing
 * into breach), never again while still over budget on every subsequent
 * turn. The "already notified" latch resets when the session drops back
 * under budget (so a later re-breach can fire again) or when the threshold
 * itself changes (raising, lowering, or clearing the budget re-arms it
 * against the new value).
 *
 * Delivery mirrors long-task-notifier.ts: desktop notification
 * (notifyNow) + outbound webhook (WebhookNotifier), both gated by
 * the shared focus/config gating in alert-gating.ts. Skips evaluation
 * entirely when the session model is unpriced, a $0 placeholder cost must
 * never be reported as a real breach (mirrors Money, Spending's "unpriced"
 * display convention).
 *
 * Text (owner ruling 2026-09-29, platform runtime/turn-notification.ts): the
 * notice names the budget that tripped (cost against the configured
 * threshold) and the turn during which it tripped. When
 * behavior.notificationsMetadataOnly is not explicitly false the desktop and
 * webhook text carries the numbers only.
 */
import { notifyNow } from '@goodvibes/engine/platform/platform/utils';
import { logger } from '@goodvibes/engine/platform/platform/utils';
import type { ProgramNotices } from '@goodvibes/engine/terminal-shell/places';
import { calcSessionCost, computeBudgetBreach, isModelPriced, type SessionPricing } from '@goodvibes/engine/platform/platform/providers';
import type { FocusTracker } from '@goodvibes/engine/platform/platform/runtime/operations';
import {
  shouldFireAlert,
  buildBudgetNotification,
  readNotificationsMetadataOnly,
  type ConfigGet,
  type BudgetNotificationFacts,
} from '@goodvibes/engine/platform/platform/runtime/operations';

export interface BudgetBreachUsageSnapshot {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /** The session cost as spent, each response at its own model's price; preferred over pricing the totals. */
  readonly costUsd?: number | undefined;
}

export interface BudgetBreachNotifierDeps {
  readonly focusTracker: Pick<FocusTracker, 'shouldAlertWhenUnfocused'>;
  readonly configGet: ConfigGet;
  /** This program's notices, sent through the daemon's one webhook list (terminal-shell program-notices.ts). */
  readonly notices?: Pick<ProgramNotices, 'sendNotification'> | null;
  readonly sessionId: string;
  /** What the session's totals are priced with when no spent figure is given: the runtime's ProviderRegistry. */
  readonly pricing: SessionPricing;
  /** Read at alert time; a resumed or forked session changes the id after the notifier is built. Wins over `sessionId`. */
  readonly getSessionId?: (() => string) | undefined;
  /** The name of the turn that just ended (the one during which the budget tripped). */
  readonly getTurnName?: (() => string | null) | undefined;
  /** Desktop delivery; defaults to the platform notifyNow. Tests pass a spy to read the text. */
  readonly notifyDesktop?: typeof notifyNow | undefined;
}

/** Stateful edge-trigger checker, construct once per session, call on every TURN_COMPLETED. */
export interface BudgetBreachNotifier {
  /**
   * Evaluate current usage against the configured threshold and fire an
   * alert on the false→true breach edge. Returns true when an alert was
   * delivered this call (for tests / observability), false otherwise.
   */
  check(usage: BudgetBreachUsageSnapshot, sessionModel: string, budgetThresholdUsd: number): boolean;
}

export function createBudgetBreachNotifier(deps: BudgetBreachNotifierDeps): BudgetBreachNotifier {
  let lastThreshold: number | null = null;
  let notified = false;

  return {
    check(usage, sessionModel, budgetThresholdUsd) {
      if (!isConversationUsageAvailable(usage) || !Number.isFinite(budgetThresholdUsd)) return false;
      if (budgetThresholdUsd !== lastThreshold) {
        // Threshold raised, lowered, or cleared since the last check, re-arm
        // the latch so a breach against the new threshold can fire again.
        lastThreshold = budgetThresholdUsd;
        notified = false;
      }

      if (budgetThresholdUsd <= 0) return false; // disabled/unknown
      // Unknown usage is not zero and cannot prove a crossing or re-arm a latch.
      if (![usage.input, usage.output, usage.cacheRead, usage.cacheWrite]
        .every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)) return false;
      const spent = typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd) ? usage.costUsd : undefined;
      if (spent === undefined && !isModelPriced(deps.pricing, sessionModel)) return false; // cost would be a placeholder, not real

      const sessionCost = spent ?? calcSessionCost(deps.pricing, usage.input, usage.output, usage.cacheRead, usage.cacheWrite, sessionModel);
      const breached = computeBudgetBreach(sessionCost, budgetThresholdUsd);

      if (!breached) {
        notified = false; // dropped back under budget, can re-fire on the next crossing
        return false;
      }
      if (notified) return false; // already alerted for this crossing

      // The latch is consumed only by an alert that went out: a crossing seen while the
      // terminal is focused must still alert on a later turn once the user is away.
      notified = fireBudgetBreachAlert(deps, sessionCost, budgetThresholdUsd);
      return notified;
    },
  };
}

/** True when the alert was handed to delivery; false when the focus or config gate held it back. */
function fireBudgetBreachAlert(deps: BudgetBreachNotifierDeps, sessionCost: number, budgetThresholdUsd: number): boolean {
  if (!shouldFireAlert(deps.focusTracker, deps.configGet, 'behavior.notifyOnBudgetBreach')) return false;

  const metadataOnly = readNotificationsMetadataOnly(deps.configGet);
  const facts: BudgetNotificationFacts = {
    sessionCostUsd: sessionCost,
    budgetUsd: budgetThresholdUsd,
    sessionId: deps.getSessionId?.() ?? deps.sessionId,
    get turnName() { return metadataOnly ? null : deps.getTurnName?.() ?? null; },
  };
  const notice = buildBudgetNotification(facts, { metadataOnly });

  try {
    (deps.notifyDesktop ?? notifyNow)(notice.title, notice.body);
  } catch (err) {
    logger.debug('budget-breach-notifier: desktop notify error', { error: String(err) });
  }

  // Through the daemon's one webhook list; it knows whether any address is set.
  deps.notices?.sendNotification({ kind: 'budget', facts }, 'budget.reached').catch((err: unknown) => {
    logger.debug('budget-breach-notifier: webhook send error', { error: String(err) });
  });
  return true;
}
