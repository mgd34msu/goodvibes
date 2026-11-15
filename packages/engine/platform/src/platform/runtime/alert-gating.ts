/**
 * alert-gating.ts, the config + focus gate every unfocused-user alert class
 * (budget breach, long task, agent/chain failure, awaiting approval) is decided
 * by.
 *
 * Each alert class has its own on/off config key (default true); a single
 * master key, `behavior.notifyOnlyWhenUnfocused` (default true), decides
 * whether any of them additionally require the terminal to be
 * unfocused-or-unknown before firing.
 *
 * One implementation of "should this fire right now", so no alert class
 * re-derives the same two config reads and the same focus check and reaches a
 * different answer.
 */
import type { FocusTracker } from './focus-tracker.js';

/** Minimal config-read surface every gating check needs. */
export type ConfigGet = (key: string) => unknown;

/** Read a host-local synthetic boolean setting, defaulting when absent/invalid. */
export function readBooleanConfig(configGet: ConfigGet, key: string, defaultValue: boolean): boolean {
  const raw = configGet(key);
  if (typeof raw === 'boolean') return raw;
  if (raw === undefined || raw === null) return defaultValue;
  // Tolerate string/number forms the same way the rest of the config layer does
  // (settings-modal writes real booleans, but env/file edits may not).
  if (raw === 'true' || raw === 1) return true;
  if (raw === 'false' || raw === 0) return false;
  return defaultValue;
}

/** `behavior.notifyOnlyWhenUnfocused`, master gate, default on. */
export function readNotifyOnlyWhenUnfocused(configGet: ConfigGet): boolean {
  return readBooleanConfig(configGet, 'behavior.notifyOnlyWhenUnfocused', true);
}

/**
 * Decide whether a given alert class should fire right now. Every terminal
 * product calls this for every alert class, so a setting means the same thing
 * in each.
 *
 * `classConfigKey` is the per-class on/off switch (e.g.
 * 'behavior.notifyOnBudgetBreach'); default true when absent. When that key
 * is off, the class never fires regardless of focus. A class with no switch of
 * its own (the long-task notice, switched by its threshold) passes none. When it's on, the
 * result additionally depends on the master `notifyOnlyWhenUnfocused` gate:
 * if that master gate is off, the class fires unconditionally (today's
 * pre-focus-tracking behavior); if on (the default), it only fires when the
 * terminal is unfocused or focus state was never observed (see
 * FocusTracker.shouldAlertWhenUnfocused).
 */
export function shouldFireAlert(
  focusTracker: Pick<FocusTracker, 'shouldAlertWhenUnfocused'>,
  configGet: ConfigGet,
  classConfigKey?: string,
): boolean {
  if (classConfigKey !== undefined && !readBooleanConfig(configGet, classConfigKey, true)) return false;
  if (!readNotifyOnlyWhenUnfocused(configGet)) return true;
  return focusTracker.shouldAlertWhenUnfocused();
}

/**
 * A duration above both notifyCompletion thresholds, for callers that still
 * pass a duration for a point-in-time alert. New code calls notifyNow
 * (platform/utils), which needs no duration.
 */
export const FORCE_NOTIFY_DURATION_MS = 30_001;
