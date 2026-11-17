/**
 * policy.ts, the effective settings, read live.
 *
 * Every value is read through a predicate at the moment it is used rather than
 * snapshotted at construction, so each one is a real toggle instead of a
 * restart-only one. That is the same treatment the owner-profile composition
 * gives its switches, and for the same reason: a setting that needs a daemon
 * restart to take effect is a setting the owner will believe they changed.
 *
 * The accessor is string-keyed so the feature depends on a narrow get/set
 * surface, not the whole ConfigManager. The `occasions.*` keys are ordinary
 * ConfigKeys (fields of OccasionsConfig), and the daemon adapts its
 * ConfigManager to this interface, the same adaptation the check-in uses.
 */
import { OCCASIONS_CONFIG_KEYS } from './types.js';
import { readConsumerSetting } from '../config/profile-fallback.js';
import { occasionsConfigDefaults } from '../config/schema-domain-occasions.js';
import type { OccasionsPolicy } from './sweep.js';

/** The narrow config surface this feature reads and writes. */
export interface OccasionsConfigAccess {
  get(key: string): unknown;
  /** The profile-filled value of an unset key (the owner's zone); see `ConfigManager.resolveForConsumer`. */
  resolveForConsumer?(key: string): unknown;
  /** Actual configuration incarnation, including no-op and ABA mutation intent. */
  getConfigurationIncarnation?(): number;
  set(key: string, value: string | boolean | number): void;
}

/**
 * The defaults are the settings rows' own (config/schema-domain-occasions.ts),
 * so a narrow embed with no config behaves as the settings describe.
 */
export const OCCASIONS_DEFAULTS = occasionsConfigDefaults.occasions;

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** The settings writer already holds each number to its row's range; only a missing or non-numeric value falls back. */
function int(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/** The whole policy, read fresh. */
export function readOccasionsPolicy(config: OccasionsConfigAccess): OccasionsPolicy {
  const get = (key: string): unknown => config.get(key);
  return {
    enabled: bool(get(OCCASIONS_CONFIG_KEYS.enabled), OCCASIONS_DEFAULTS.enabled),
    leadDays: int(get(OCCASIONS_CONFIG_KEYS.leadDays), OCCASIONS_DEFAULTS.leadDays),
    activeHours: text(get(OCCASIONS_CONFIG_KEYS.activeHours), OCCASIONS_DEFAULTS.activeHours),
    nudgeChannel: text(get(OCCASIONS_CONFIG_KEYS.nudgeChannel), OCCASIONS_DEFAULTS.nudgeChannel),
    cadenceDays: int(get(OCCASIONS_CONFIG_KEYS.cadenceDays), OCCASIONS_DEFAULTS.cadenceDays),
    awayAdjust: bool(get(OCCASIONS_CONFIG_KEYS.awayAdjust), OCCASIONS_DEFAULTS.awayAdjust),
    calendarMirror: bool(get(OCCASIONS_CONFIG_KEYS.calendarMirror), OCCASIONS_DEFAULTS.calendarMirror),
    suppressMirroredNudges: bool(
      get(OCCASIONS_CONFIG_KEYS.suppressMirroredNudges),
      OCCASIONS_DEFAULTS.suppressMirroredNudges,
    ),
    interviewQuestions: int(get(OCCASIONS_CONFIG_KEYS.interviewQuestions), OCCASIONS_DEFAULTS.interviewQuestions),
    giftHistoryYears: int(get(OCCASIONS_CONFIG_KEYS.giftHistoryYears), OCCASIONS_DEFAULTS.giftHistoryYears),
    sweepIntervalMinutes: int(get(OCCASIONS_CONFIG_KEYS.sweepIntervalMinutes), OCCASIONS_DEFAULTS.sweepIntervalMinutes),
  };
}

/**
 * The zone the owner's days and hours are reckoned in.
 *
 * `daemon.timezone` and nothing else. There is deliberately no
 * `occasions.timezone`: the daemon-location setting exists precisely so the
 * next feature needing a calendar day does not add a second one, and two zone
 * settings that disagree is a defect nobody would find until a nudge arrived at
 * 3am.
 */
export function readOccasionsTimezone(config: OccasionsConfigAccess): string {
  const value = readConsumerSetting(config, 'daemon.timezone');
  return typeof value === 'string' ? value : '';
}
