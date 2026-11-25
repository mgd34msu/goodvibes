/**
 * The provider error codes a refusal is read by, with no other import, so the failure reading (turn-failure.ts, which
 * the web UI loads) and the error guidance (types/errors.ts) read one list.
 */

/** Provider codes that name a context-window refusal outright: the conversation is too long for the model. */
export const CONTEXT_REFUSAL_CODES: ReadonlySet<string> = new Set(['context_length_exceeded', 'request_too_large', 'string_above_max_length']);

/** Provider codes that say the provider's content filter refused the request. */
export const CONTENT_FILTER_CODES: ReadonlySet<string> = new Set(['content_filter', 'content_policy_violation']);

/** The provider code that says the provider does not have the model asked for. */
export const MODEL_NOT_FOUND_CODE = 'model_not_found';

/** True when a provider's error code says the conversation is too long for the model (a context-window refusal). */
export function isContextRefusalCode(code: string | undefined): boolean {
  return code !== undefined && CONTEXT_REFUSAL_CODES.has(code);
}
