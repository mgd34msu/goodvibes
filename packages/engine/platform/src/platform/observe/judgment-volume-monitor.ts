import type { DecisionLog } from '@goodvibes/judgment';
import { boolean, number, strictObject, unknown } from 'zod/v4';
import {
  captureJudgmentVolumeBudgets,
  judgmentVolumeBreaches,
  type JudgmentVolumeBudget,
  type JudgmentVolumeBreach,
} from './judgment-volume.js';

export type JudgmentVolumeLog = Pick<DecisionLog, 'query'> & Partial<Pick<DecisionLog, 'queryVolume'>>;

export interface JudgmentVolumeMonitorSettings {
  readonly budgets: readonly JudgmentVolumeBudget[];
  readonly intervalMs: number;
  readonly windowMs: number;
  readonly limit: number;
}
export interface JudgmentVolumeMonitorControl extends JudgmentVolumeMonitorSettings {
  readonly enabled: boolean;
}
export type JudgmentVolumeAlert =
  | { readonly kind: 'budget-exceeded'; readonly breaches: readonly JudgmentVolumeBreach[] }
  | { readonly kind: 'incomplete-window'; readonly limit: number }
  /** The decision log could not be read; `reason` is the failure's summary, so the cause is not lost. */
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'recovered' };
const settingsSchema = strictObject({
  budgets: unknown(),
  intervalMs: number().int().min(1000).max(86_400_000).default(60_000),
  windowMs: number()
    .int()
    .min(1000)
    .max(30 * 86_400_000)
    .default(3_600_000),
  limit: number().int().min(1).max(100_000).default(10_000),
});
export function captureJudgmentVolumeMonitorSettings(value: unknown): JudgmentVolumeMonitorSettings {
  const settings = settingsSchema.parse(value);
  const budgets = captureJudgmentVolumeBudgets(settings.budgets);
  if (budgets.length === 0 || budgets.length > 100) throw new Error('Judgment monitoring requires between one and 100 budgets.');
  return { ...settings, budgets };
}

/** Product settings can remain disabled until the owner supplies a budget. */
export function captureJudgmentVolumeMonitorControl(value: unknown): JudgmentVolumeMonitorControl {
  const parsed = settingsSchema.extend({ enabled: boolean().default(false), budgets: unknown().default([]) }).parse(value === undefined ? {} : value);
  const budgets = captureJudgmentVolumeBudgets(parsed.budgets);
  if (budgets.length > 100 || parsed.enabled && budgets.length === 0) throw new Error('Enabled judgment monitoring requires between one and 100 budgets.');
  return Object.freeze({ ...parsed, budgets: Object.freeze(budgets.map(budget => Object.freeze(budget))) });
}

/**
 * What can be said about an unreadable log without repeating its message: a
 * machine code such as SQLITE_BUSY when the failure carries one, else its class.
 * Messages can quote paths and values, so they are never echoed. Kept local:
 * this module is loaded by the config schema, so it cannot import the shared
 * error helpers.
 */
function failureReason(error: unknown): string {
  if (!(error instanceof Error)) return 'non-error failure';
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Z0-9_]{3,40}$/.test(code) ? code : error.name;
}

/** Local observation only: budget alerts neither call models nor authorize/stop actions. */
export function startJudgmentVolumeMonitor(options: {
  readonly log: JudgmentVolumeLog;
  readonly settings: JudgmentVolumeMonitorSettings;
  readonly notify: (alert: JudgmentVolumeAlert) => void;
  readonly now?: () => number;
}) {
  const settings = captureJudgmentVolumeMonitorSettings(options.settings);
  let disposed = false,
    checking = false;
  let signature: string | undefined;
  let latest: JudgmentVolumeAlert | undefined;
  const check = (): void => {
    if (disposed || checking) return;
    checking = true;
    let alert: JudgmentVolumeAlert;
    try {
      const now = options.now?.() ?? Date.now();
      const query = {
        since: new Date(now - settings.windowMs).toISOString(),
        until: new Date(now).toISOString(),
        limit: settings.limit + 1,
      };
      // Native logs return only context and dispatch counters. The bounded
      // full-entry path remains for older/custom DecisionLog implementations.
      const entries = options.log.queryVolume ? options.log.queryVolume(query) : options.log.query(query);
      if (entries.length > settings.limit) alert = { kind: 'incomplete-window', limit: settings.limit };
      else {
        const breaches = judgmentVolumeBreaches(entries, settings.budgets);
        alert = breaches.length ? { kind: 'budget-exceeded', breaches } : { kind: 'recovered' };
      }
    } catch (error) {
      alert = { kind: 'unavailable', reason: failureReason(error) };
    }
    // Keep the reentrancy fence through notification; an observer can dispose
    // this owner, invoke another check, or throw without restarting its timer.
    try {
      if (disposed) return;
      const next =
        alert.kind === 'budget-exceeded'
          ? JSON.stringify(alert.breaches.map((breach) => [breach.budget, breach.kind, breach.maximum]).sort())
          : alert.kind;
      if (next === signature) return;
      const previous = signature;
      signature = next;
      latest = alert;
      if (alert.kind === 'recovered' && previous === undefined) return;
      try {
        options.notify(alert);
      } catch {
        signature = undefined;
      } // Retry a failed local delivery at the next scheduled check.
    } finally {
      checking = false;
    }
  };
  const timer = setInterval(check, settings.intervalMs);
  timer.unref();
  const dispose = (): void => {
    disposed = true;
    clearInterval(timer);
  };
  return {
    check,
    dispose,
    /** The most recent alert state change (budget breach, unreadable log, recovery), for a status read. */
    lastAlert: (): JudgmentVolumeAlert | undefined => latest,
    [Symbol.dispose]: dispose,
  };
}
