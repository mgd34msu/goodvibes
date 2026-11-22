import type { JudgmentLineage } from './types.ts';
import { LIMITS } from './limits-table.ts';

/**
 * Why a judgment call failed. Every decision site treats a failure as a
 * failure: there is no heuristic path to fall back to. Configured failover
 * exhausts after one finite chain, including a single configured target.
 */
export type JudgmentErrorKind =
  /** The request broke a documented limit and was never sent. */
  | 'invalid-request'
  /** The endpoint rejected the request (4xx other than rate limiting). */
  | 'rejected'
  /** The endpoint could not answer: rate limit, overload, 5xx, timeout or network failure. Configured chains can exhaust. */
  | 'unavailable'
  /** The caller cancelled the call. */
  | 'aborted'
  /** The endpoint answered with a body that does not match the questions asked. */
  | 'invalid-response'
  /** The local client failed unexpectedly; retrying another provider cannot repair it. */
  | 'internal'
  /** The decision log could not record the call, so its answer must not be used. */
  | 'unrecorded';

/**
 * Why a call was refused or failed, from a closed list. The sentence shown
 * for each is fixed here, so a reason survives the decision log's rule that
 * no text an outside port wrote is kept: the log keeps the code and renders
 * the sentence, never the original message.
 */
export const JUDGMENT_FAILURE_REASONS = {
  'no-questions': 'The judgment request has no questions.',
  'empty-question-name': 'A judgment question has an empty name.',
  'too-many-options': `A choice in the judgment request has more than ${LIMITS.maxChoiceOptions} options; shortlist the candidates first.`,
  'too-few-options': `A choice in the judgment request has fewer than ${LIMITS.minChoiceOptions} options.`,
  'too-many-levels': `A score in the judgment request has more than ${LIMITS.maxScoreLevels} levels.`,
  'too-few-levels': `A score in the judgment request has fewer than ${LIMITS.minScoreLevels} levels.`,
  'body-too-large': `The judgment request is larger than the ${LIMITS.maxRequestBytes}-byte body limit; partition the evidence into separate readings.`,
  'not-serializable': 'The judgment input is not plain JSON.',
  'no-owner-signal': 'The judgment call has no owning AbortSignal on the request or port.',
  'invalid-model': 'The judgment model name is not a valid model identifier.',
  'invalid-deadline': 'The judgment deadline must be whole positive milliseconds, set with deadlineMs.',
  'attempt-refused': 'The caller withdrew authority for this judgment attempt.',
  'invalid-attempt-guard': 'The asynchronous judgment attempt guard returned a value; it must return nothing.',
  'target-capability': 'The complete judgment input exceeds what this decision target accepts; partition the evidence or use a target with a larger limit.',
  'target-configuration': 'The decision target is configured in a way it cannot serve: check its endpoint address, model and server mode.',
  'no-credential': 'The decision model has no API key. Set "Where the decision model key comes from" and "Decision model key name" in Settings, then retry.',
  'truncated-evidence': 'The decision model read only part of the evidence, so its answer was not used; partition the evidence or use a target with a larger context.',
  'malformed-response': 'The decision model sent an answer this client cannot read; check that the target is a supported decision server.',
  'candidate-too-large': 'Every candidate is larger than one judgment request can carry, so nothing was asked; read the content another way.',
  'model-mismatch': 'A different model answered than the one this target is configured for; check the model name set for it.',
  abstained: 'The decision model abstained from answering, so nothing was decided.',
  'endpoint-status': 'The decision endpoint answered with an error status; retry in a moment.',
  unreachable: 'The decision endpoint could not be reached; check that it is running and its address is right, then retry.',
  'endpoint-timeout': 'The decision endpoint did not answer in time; retry in a moment.',
  'deadline-missed': 'The decision model did not answer within the time the caller allowed; retry in a moment.',
  'targets-slow': 'The decision models missed their deadline repeatedly and are skipped for a minute; retry after that.',
  'rate-limited': 'The decision models are rate limited; retry after the wait they asked for.',
} as const;

export type JudgmentFailureReason = keyof typeof JUDGMENT_FAILURE_REASONS;

export const isJudgmentFailureReason = (value: unknown): value is JudgmentFailureReason =>
  typeof value === 'string' && Object.hasOwn(JUDGMENT_FAILURE_REASONS, value);

export class JudgmentError extends Error {
  override readonly name = 'JudgmentError';
  readonly kind: JudgmentErrorKind;
  /** Why, from a closed list; set where the failure was found. */
  readonly reason: JudgmentFailureReason | undefined;
  /** HTTP status when the endpoint answered with one. */
  readonly status: number | undefined;
  /** The endpoint's request id, when it sent one. */
  readonly requestId: string | undefined;

  readonly lineage: JudgmentLineage | undefined;
  /** For `unavailable` failures caused by a provider cooldown: milliseconds until a target may be asked again. */
  readonly retryAfterMs: number | undefined;

  constructor(
    kind: JudgmentErrorKind,
    message: string,
    options: { cause?: unknown; status?: number; requestId?: string; lineage?: JudgmentLineage; retryAfterMs?: number; reason?: JudgmentFailureReason } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.reason = options.reason;
    this.lineage = options.lineage;
    this.retryAfterMs = options.retryAfterMs;
    this.kind = kind;
    this.status = options.status;
    this.requestId = options.requestId;
  }
}

/** A whitelisted provider refusal, retained without its response body. */
export class JudgmentContextLimitError extends JudgmentError {
  constructor(options: { requestId?: string; lineage?: JudgmentLineage } = {}) {
    super('rejected', 'The judgment request exceeds the endpoint token limit.', { status: 400, ...options });
  }
}
