/**
 * schema-types-occasions.ts, the `occasions.*` config domain's types.
 *
 * The shape only: GoodVibesConfig (`schema-types.ts`) imports it as
 * `occasions`, and `ConfigKey` / `ConfigValue` are read off it. The defaults,
 * the descriptions and the editable settings rows are in
 * `schema-domain-occasions.ts`.
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
