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

/**
 * Read a product-owned boolean setting: the stored boolean, else `defaultValue`.
 * A product that registers the key as a host setting has its manager resolve a
 * value of any other type to the declared default already, so a settings row
 * and this reader agree.
 */
export function readBooleanConfig(configGet: ConfigGet, key: string, defaultValue: boolean): boolean {
  const raw = configGet(key);
  return typeof raw === 'boolean' ? raw : defaultValue;
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

