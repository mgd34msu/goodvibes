import type { DecisionLog } from '@goodvibes-jev/judgment';
import { number, strictObject, unknown } from 'zod/v4';
import {
  captureJudgmentVolumeBudgets,
  judgmentVolumeBreaches,
  type JudgmentVolumeBudget,
  type JudgmentVolumeBreach,
} from './judgment-volume.js';

export interface JudgmentVolumeMonitorSettings {
  readonly budgets: readonly JudgmentVolumeBudget[];
  readonly intervalMs: number;
  readonly windowMs: number;
  readonly limit: number;
}
export type JudgmentVolumeAlert =
  | { readonly kind: 'budget-exceeded'; readonly breaches: readonly JudgmentVolumeBreach[] }
  | { readonly kind: 'incomplete-window'; readonly limit: number }
  | { readonly kind: 'unavailable' }
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

/** Local observation only: budget alerts neither call models nor authorize/stop actions. */
export function startJudgmentVolumeMonitor(options: {
  readonly log: Pick<DecisionLog, 'query'>;
  readonly settings: JudgmentVolumeMonitorSettings;
  readonly notify: (alert: JudgmentVolumeAlert) => void;
  readonly now?: () => number;
}) {
  const settings = captureJudgmentVolumeMonitorSettings(options.settings);
  let disposed = false,
    checking = false;
  let signature: string | undefined;
  const check = (): void => {
    if (disposed || checking) return;
    checking = true;
    let alert: JudgmentVolumeAlert;
    try {
      const now = options.now?.() ?? Date.now();
      const entries = options.log.query({
        since: new Date(now - settings.windowMs).toISOString(),
        until: new Date(now).toISOString(),
        limit: settings.limit + 1,
      });
      if (entries.length > settings.limit) alert = { kind: 'incomplete-window', limit: settings.limit };
      else {
        const breaches = judgmentVolumeBreaches(entries, settings.budgets);
        alert = breaches.length ? { kind: 'budget-exceeded', breaches } : { kind: 'recovered' };
      }
    } catch {
      alert = { kind: 'unavailable' };
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
  return { check, dispose, [Symbol.dispose]: dispose };
}
