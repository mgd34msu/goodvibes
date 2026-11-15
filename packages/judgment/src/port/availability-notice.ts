/** Static recovery advice shared by native transport and sanitized recording. */
export const DECISION_MODELS_UNAVAILABLE_NOTICE = 'No decision models are currently available. Check API keys, endpoint addresses, model names and local model services, then retry. The operation has stopped.';

/** Advice when every configured target is cooling down after a rate-limit response. */
export const rateLimitedNotice = (retryAfterMs: number): string =>
  `The decision models are rate limited; retry in about ${Math.max(1, Math.ceil(retryAfterMs / 1000))} s. The operation has stopped.`;
