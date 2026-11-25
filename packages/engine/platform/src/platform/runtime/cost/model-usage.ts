/**
 * model-usage.ts, what a model call the daemon runs outside a conversation's own loop cost: an agent's request
 * (agents/orchestrator-runner.ts: a schedule's run, a piece of work's steps, a shared session's answer) and a web chat
 * turn's (companion/companion-chat-manager.ts), each said once, at the point where that turn reads its usage from the
 * provider's answer, with what it was for (`source`).
 *
 * Process-wide like the stores it serves (runtime/list-changes.ts): the daemon's cost records (Money, Spending) listen
 * (control-plane/routes/attribution-ingest.ts); a process with no listener (a terminal program running its own agents,
 * which its own Spending rows count) records nothing. A note costs one call per listener and nothing with none.
 */
import type { CostUsageRecord } from './attribution.js';

/** One model request's usage, with what it was for. */
export interface ModelUsageNote extends CostUsageRecord {
  readonly source: string;
}

const listeners = new Set<(usage: ModelUsageNote) => void>();

/** Told of every model request noted in this process; returns the unsubscribe. */
export function onModelUsage(listener: (usage: ModelUsageNote) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Say what one model request used; never throws into the turn that made it. */
export function noteModelUsage(usage: ModelUsageNote): void {
  for (const listener of [...listeners]) {
    try { listener(usage); } catch { /* A listener cannot fail a turn. */ }
  }
}

/** A name from a record (a schedule's, a session's title), on one line and short enough to read in a row. */
export function spendingName(value: string | undefined | null): string {
  const one = String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return one.length > 60 ? `${one.slice(0, 57)}...` : one;
}

/** What the daemon's own runs cost in the last 24 hours passed the spending alert (said once per crossing). */
export interface SpendingAlertPassed {
  readonly costUsd: number;
  readonly alertUsd: number;
  /** The sentence a person reads. */
  readonly text: string;
}

function alertDollars(value: number): string {
  return `$${value > 0 && value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`;
}

/**
 * The one sentence the daemon's spending alert is said in: through the webhook addresses, as a notice in every
 * connected program and in the web UI (each reads it from `usage.by-source`'s `data.alert.text`).
 */
export function spendingAlertPassedSentence(costUsd: number, alertUsd: number): string {
  return `What the daemon's own runs (schedules, work, web chat) cost in the last 24 hours, ${alertDollars(costUsd)}, is more than your spending alert of ${alertDollars(alertUsd)}. Money, Spending, shows what it went on and changes the alert.`;
}

/** The LIST_CHANGED `spending` id a crossing of the daemon's spending alert is announced with: `alert-passed:<when>`. */
export const SPENDING_ALERT_PASSED_ID_PREFIX = 'alert-passed:';

const alertListeners = new Set<(passed: SpendingAlertPassed) => void>();

/** Told when the daemon's own runs pass the spending alert (the daemon's notifier sends it on); returns the unsubscribe. */
export function onSpendingAlertPassed(listener: (passed: SpendingAlertPassed) => void): () => void {
  alertListeners.add(listener);
  return () => { alertListeners.delete(listener); };
}

export function noteSpendingAlertPassed(passed: SpendingAlertPassed): void {
  for (const listener of [...alertListeners]) {
    try { listener(passed); } catch { /* A listener cannot fail the recording. */ }
  }
}
