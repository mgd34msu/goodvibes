/** Static recovery advice shared by native transport and sanitized recording. */
export const DECISION_MODELS_UNAVAILABLE_NOTICE = 'No decision models are currently available. Check API keys, endpoint addresses, model names and local model services, then retry. The operation has stopped.';

/** A call that ran past its total deadline. */
export const missedDeadlineNotice = (deadlineMs: number | undefined): string =>
  deadlineMs === undefined ? 'The decision model did not answer within the deadline.' : `The decision model did not answer within ${deadlineMs} ms.`;

/** Every target is being skipped, at least one after missing its deadline repeatedly. */
export const slowTargetsNotice = (retryAfterMs: number): string =>
  `The decision models missed their deadline repeatedly and are skipped for about ${Math.max(1, Math.ceil(retryAfterMs / 1000))} s.`;

/** Advice when every configured target is cooling down after a rate-limit response. */
export const rateLimitedNotice = (retryAfterMs: number): string =>
  `The decision models are rate limited; retry in about ${Math.max(1, Math.ceil(retryAfterMs / 1000))} s. The operation has stopped.`;
