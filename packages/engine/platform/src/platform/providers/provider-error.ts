/**
 * Shared provider-error helpers.
 *
 * Consolidated from three verbatim copies in lm-studio-helpers.ts,
 * llama-cpp.ts, and ollama.ts into a single definition.
 */

import { toProviderError } from '../utils/error-display.js';
import type { ProviderError } from '../types/errors.js';

/**
 * Extract an HTTP status code from an error object.
 * Checks `.status` before `.statusCode` to preserve provider-error convention.
 */
export function getErrorStatus(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    const record = err as { status?: unknown; statusCode?: unknown };
    if (typeof record.status === 'number') return record.status;
    if (typeof record.statusCode === 'number') return record.statusCode;
  }
  return undefined;
}

/**
 * Wrap an error into a ProviderError, attaching the HTTP status if present.
 */
export function normalizeProviderError(
  err: unknown,
  provider: string,
  operation: string,
  phase = 'request',
): ProviderError {
  const status = getErrorStatus(err);
  return toProviderError(err, {
    ...(status !== undefined ? { statusCode: status } : {}),
    provider,
    operation,
    phase,
  });
}

/** Statuses that say the endpoint itself is missing or refuses the method. */
const OTHER_API_STATUSES: ReadonlySet<number> = new Set([404, 405, 501]);

/**
 * Whether a local server's failure on one of its APIs means the same request
 * should go through its other API (Ollama native chat or OpenAI-compatible;
 * LM Studio native, responses or OpenAI-compatible). Decided by the status
 * alone: a missing endpoint or method sends the request on, and any other
 * failure is the server's own answer, shown as it wrote it.
 */
export function isOtherApiFailure(err: unknown): boolean {
  const status = getErrorStatus(err);
  return status !== undefined && OTHER_API_STATUSES.has(status);
}
