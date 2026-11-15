/** Documented request limits for System One (docs.typesafe.ai/api). */
export const LIMITS = {
  /** A Choice accepts at most 255 options. */
  maxChoiceOptions: 255,
  /** A Choice with one option decides nothing; two is the smallest real choice. */
  minChoiceOptions: 2,
  /** A Score needs at least two levels and accepts up to ten. */
  minScoreLevels: 2,
  maxScoreLevels: 10,
  /** Jev 1.13: 64k tokens for the state plus all questions. */
  maxRequestTokens: 64_000,
  /** Jev 1.13: 32k tokens for the state plus the single longest question. */
  maxStateWithQuestionTokens: 32_000,
  /** Hosted long-context mode, enabled per request when needed. */
  maxLongContextTokens: 262_000,
  maxRequestBytes: 32 * 1024 * 1024,
} as const;
