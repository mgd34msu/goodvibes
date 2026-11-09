/**
 * error-codes.ts, the canonical {@link EngineErrorCode} union, its runtime-accessible
 * {@link EngineErrorCodes} mirror, and the two membership/narrowing helpers built on it.
 *
 * Split out of index.ts to stay under the repo's 800-line file cap (see
 * scripts/check-line-cap.ts), this block is self-contained (no dependency on
 * GoodVibesError or anything else in index.ts) and index.ts re-exports it
 * unchanged, so this is a pure file-organization move with no API surface change.
 */

/**
 * Exhaustive string-literal union of the canonical error codes produced by the
 * GoodVibes platform. Use this type when you need to pattern-match on `err.code`
 * without losing exhaustiveness checking.
 *
 * The `code` field on {@link GoodVibesError} is typed as
 * `EngineErrorCode | (string & {})` so that:
 * - platform-produced errors surface as one of the known literals (IDE autocomplete
 *   and exhaustive switches work).
 * - Caller-supplied arbitrary string codes still type-check without casting.
 *
 * ### Consumer pattern
 * ```ts
 * import { isErrorCode, EngineErrorCodes } from '@goodvibes-jev/engine/errors';
 *
 * catch (err) {
 *   if (err instanceof GoodVibesError) {
 *     if (isErrorCode(err, EngineErrorCodes.RATE_LIMITED)) {
 *       await delay(err.retryAfterMs ?? 1000);
 *     } else if (isErrorCode(err, EngineErrorCodes.AUTH_REQUIRED)) {
 *       await refreshToken();
 *     } else if (isErrorCode(err, EngineErrorCodes.TOKEN_EXPIRED)) {
 *       await refreshToken();
 *     }
 *   }
 * }
 * ```
 */
export type EngineErrorCode =
  // Authentication / authorization
  | 'AUTH_REQUIRED'
  | 'TOKEN_EXPIRED'
  | 'PERMISSION_DENIED'
  | 'PAYMENT_REQUIRED'
  // Rate limiting
  | 'RATE_LIMITED'
  // Networking
  | 'NETWORK_UNREACHABLE'
  | 'TIMEOUT'
  | 'CANCELLED'
  // Resource
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'SESSION_CLOSED'
  // Gateway method dispatch
  | 'NOT_INVOKABLE'
  | 'METHOD_NOT_FOUND'
  // Validation
  | 'VALIDATION_FAILED'
  // Agent execution
  | 'AGENT_TIMEOUT'
  | 'AGENT_FAILED'
  // Tool execution
  | 'TOOL_EXEC_FAILED'
  // Service-level
  | 'SERVICE_UNAVAILABLE'
  // platform contract / internals
  | 'CONTRACT_MISMATCH'
  | 'PROTOCOL_ERROR'
  | 'INTERNAL_ERROR'
  | 'ENGINE_CONFIGURATION_ERROR'
  | 'ENGINE_CONTRACT_ERROR'
  | 'ENGINE_HTTP_STATUS_ERROR'
  // Catch-all
  | 'UNKNOWN';

/**
 * Runtime-accessible const object mirroring the {@link EngineErrorCode} union.
 * Prefer referencing these constants over raw string literals for refactor safety.
 *
 * @example
 * import { EngineErrorCodes } from '@goodvibes-jev/engine/errors';
 *
 * if (err.code === EngineErrorCodes.RATE_LIMITED) {
 *   await delay(err.retryAfterMs ?? 1000);
 * }
 */
export const EngineErrorCodes = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  PAYMENT_REQUIRED: 'PAYMENT_REQUIRED',
  RATE_LIMITED: 'RATE_LIMITED',
  NETWORK_UNREACHABLE: 'NETWORK_UNREACHABLE',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'CANCELLED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  SESSION_CLOSED: 'SESSION_CLOSED',
  NOT_INVOKABLE: 'NOT_INVOKABLE',
  METHOD_NOT_FOUND: 'METHOD_NOT_FOUND',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  AGENT_TIMEOUT: 'AGENT_TIMEOUT',
  AGENT_FAILED: 'AGENT_FAILED',
  TOOL_EXEC_FAILED: 'TOOL_EXEC_FAILED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  CONTRACT_MISMATCH: 'CONTRACT_MISMATCH',
  PROTOCOL_ERROR: 'PROTOCOL_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  ENGINE_CONFIGURATION_ERROR: 'ENGINE_CONFIGURATION_ERROR',
  ENGINE_CONTRACT_ERROR: 'ENGINE_CONTRACT_ERROR',
  ENGINE_HTTP_STATUS_ERROR: 'ENGINE_HTTP_STATUS_ERROR',
  UNKNOWN: 'UNKNOWN',
} as const satisfies Record<EngineErrorCode, EngineErrorCode>;

/**
 * The set of known {@link EngineErrorCode} values for runtime membership tests.
 * @internal
 */
const ENGINE_ERROR_CODE_SET = new Set<string>(Object.values(EngineErrorCodes));

/**
 * Returns `true` when `err.code` equals the given {@link EngineErrorCode},
 * narrowing the type of `err.code` to the specific literal.
 *
 * Works with any object that has a `code?: string` field, not limited to
 * {@link GoodVibesError} subclasses.
 *
 * @example
 * import { isErrorCode, EngineErrorCodes, GoodVibesError } from '@goodvibes-jev/engine/errors';
 *
 * if (err instanceof GoodVibesError && isErrorCode(err, EngineErrorCodes.RATE_LIMITED)) {
 *   console.log('retry after', err.retryAfterMs);
 * }
 *
 * @param err - Any object with an optional `code` string field.
 * @param code - The {@link EngineErrorCode} literal to match against.
 */
export function isErrorCode<C extends EngineErrorCode>(
  err: { readonly code?: EngineErrorCode | (string & {}) | undefined },
  code: C,
): err is { readonly code: C } {
  return err.code === code;
}

/**
 * Returns `true` when `value` is a known {@link EngineErrorCode} string.
 * Useful for discriminating structured errors received over the wire.
 *
 * @param value - The string to test.
 */
export function isKnownErrorCode(value: string): value is EngineErrorCode {
  return ENGINE_ERROR_CODE_SET.has(value);
}
