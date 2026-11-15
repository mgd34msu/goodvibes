/**
 * schema-types-occasions.ts, the `occasions.*` config domain's types.
 *
 * Split the same way `schema-types-owner-profile.ts` is: the shape, the key
 * union and the key→value map live beside each other here, and `schema-types.ts`
 * folds them into `ConfigKey` and `ConfigValue` with one arm each.
 *
 * Types only. The defaults, the descriptions and the editable settings rows are
 * in `schema-domain-occasions.ts`, which is also where the `declare module`
 * merge into `GoodVibesConfig` lives.
 */

/**
 * The proactive occasions feature's operator-editable policy (`occasions.*`).
 * What each key does is stated once, in its settings row's description
 * (schema-domain-occasions.ts).
 */
export interface OccasionsConfig {
  enabled: boolean;
  leadDays: number;
  activeHours: string;
  nudgeChannel: string;
  cadenceDays: number;
  awayAdjust: boolean;
  calendarMirror: boolean;
  suppressMirroredNudges: boolean;
  interviewQuestions: number;
  giftHistoryYears: number;
  sweepIntervalMinutes: number;
}

/** Dot-path keys for the `occasions.*` domain. */
export type OccasionsConfigKey =
  | 'occasions.enabled'
  | 'occasions.leadDays'
  | 'occasions.activeHours'
  | 'occasions.nudgeChannel'
  | 'occasions.cadenceDays'
  | 'occasions.awayAdjust'
  | 'occasions.calendarMirror'
  | 'occasions.suppressMirroredNudges'
  | 'occasions.interviewQuestions'
  | 'occasions.giftHistoryYears'
  | 'occasions.sweepIntervalMinutes';

/**
 * Maps an `occasions.*` key to its value type.
 *
 * Every key is written out, terminating in `never`, rather than collapsing the
 * booleans into a default arm. The completeness gate reads these clauses out of
 * the source to prove no schema key is missing a typed accessor, and a default
 * arm would make most of them invisible to it, a gate that passes because it
 * stopped looking is worse than no gate.
 */
export type OccasionsConfigValue<K extends OccasionsConfigKey> =
  K extends 'occasions.enabled' ? boolean :
  K extends 'occasions.leadDays' ? number :
  K extends 'occasions.activeHours' ? string :
  K extends 'occasions.nudgeChannel' ? string :
  K extends 'occasions.cadenceDays' ? number :
  K extends 'occasions.awayAdjust' ? boolean :
  K extends 'occasions.calendarMirror' ? boolean :
  K extends 'occasions.suppressMirroredNudges' ? boolean :
  K extends 'occasions.interviewQuestions' ? number :
  K extends 'occasions.giftHistoryYears' ? number :
  K extends 'occasions.sweepIntervalMinutes' ? number :
  never;
