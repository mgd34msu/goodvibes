import { RETRYABLE_STATUS_CODES } from '@goodvibes-jev/engine/errors';
import { computeBackoffDelay, normalizeBackoffPolicy, type BackoffPolicy, type ResolvedBackoffPolicy } from './backoff.js';

export interface PerMethodRetryPolicy {
  readonly maxAttempts?: number | undefined;
  readonly baseDelayMs?: number | undefined;
  readonly maxDelayMs?: number | undefined;
  readonly backoffFactor?: number | undefined;
}

export interface HttpRetryPolicy extends BackoffPolicy {
  readonly retryOnStatuses?: readonly number[] | undefined;
  readonly retryOnMethods?: readonly string[] | undefined;
  readonly retryOnNetworkError?: boolean | undefined;
  /**
   * Attempt and delay overrides keyed by method ID. They tune how a call that
   * may be retried is retried. An entry with `maxAttempts` above 1 also marks
   * that method idempotent (the caller states the server deduplicates it): a
   * mutating call is then retried and carries one generated `Idempotency-Key`.
   */
  readonly perMethodPolicy?: Readonly<Record<string, PerMethodRetryPolicy>> | undefined;
}

export interface ResolvedHttpRetryPolicy extends ResolvedBackoffPolicy {
  readonly retryOnStatuses: readonly number[];
  readonly retryOnMethods: readonly string[];
  readonly retryOnNetworkError: boolean;
  /** Per-method retry policy overrides keyed by method ID. */
  readonly perMethodPolicy: Readonly<Record<string, PerMethodRetryPolicy>>;
}

/**
 * Attempts for a call marked idempotent when neither the transport nor the
 * call sets `maxAttempts`: its idempotency key makes a repeat safe, so a lost
 * response or a transient failure is retried instead of failing the call.
 */
export const DEFAULT_IDEMPOTENT_MAX_ATTEMPTS = 3;

export const DEFAULT_HTTP_RETRY_POLICY: ResolvedHttpRetryPolicy = {
  maxAttempts: 1,
  baseDelayMs: 250,
  maxDelayMs: 2_000,
  backoffFactor: 2,
  retryOnStatuses: RETRYABLE_STATUS_CODES,
  retryOnMethods: ['GET', 'HEAD', 'OPTIONS'],
  retryOnNetworkError: true,
  perMethodPolicy: {},
};

export function normalizeHttpRetryPolicy(
  policy?: HttpRetryPolicy,
): ResolvedHttpRetryPolicy {
  const normalized = normalizeBackoffPolicy(policy, DEFAULT_HTTP_RETRY_POLICY);
  return {
    ...normalized,
    retryOnStatuses: [...(policy?.retryOnStatuses ?? DEFAULT_HTTP_RETRY_POLICY.retryOnStatuses)],
    retryOnMethods: [...(policy?.retryOnMethods ?? DEFAULT_HTTP_RETRY_POLICY.retryOnMethods)].map((method) => method.toUpperCase()),
    retryOnNetworkError: policy?.retryOnNetworkError ?? DEFAULT_HTTP_RETRY_POLICY.retryOnNetworkError,
    perMethodPolicy: policy?.perMethodPolicy ?? DEFAULT_HTTP_RETRY_POLICY.perMethodPolicy,
  };
}

export function resolveHttpRetryPolicy(
  defaultPolicy?: HttpRetryPolicy,
  override?: false | HttpRetryPolicy,
): ResolvedHttpRetryPolicy {
  if (override === false) {
    return normalizeHttpRetryPolicy({ maxAttempts: 1 });
  }
  const base = normalizeHttpRetryPolicy(defaultPolicy);
  if (!override) return base;
  return {
    ...base,
    ...normalizeBackoffPolicy(override, base),
    retryOnStatuses: override.retryOnStatuses ? [...override.retryOnStatuses] : base.retryOnStatuses,
    retryOnMethods: override.retryOnMethods ? override.retryOnMethods.map((method) => method.toUpperCase()) : base.retryOnMethods,
    retryOnNetworkError: override.retryOnNetworkError ?? base.retryOnNetworkError,
    perMethodPolicy: override.perMethodPolicy ?? base.perMethodPolicy,
  };
}

/**
 * Resolve a per-method retry policy override by method ID.
 * Returns the base policy with overrides applied, or the base policy unchanged.
 */
export function applyPerMethodPolicy(
  base: ResolvedHttpRetryPolicy,
  methodId: string,
): ResolvedHttpRetryPolicy {
  const override = base.perMethodPolicy[methodId];
  if (!override) return base;
  return {
    ...base,
    maxAttempts: override.maxAttempts ?? base.maxAttempts,
    baseDelayMs: override.baseDelayMs ?? base.baseDelayMs,
    maxDelayMs: override.maxDelayMs ?? base.maxDelayMs,
    backoffFactor: override.backoffFactor ?? base.backoffFactor,
  };
}

export function getHttpRetryDelay(
  attempt: number,
  policy: ResolvedHttpRetryPolicy,
): number {
  return computeBackoffDelay(attempt, policy);
}

const MUTATING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Whether a call may be repeated at all, the one rule: a call marked
 * idempotent (the server recognises a repeat by its idempotency key or replay
 * field) may be, whatever its verb; otherwise only a safe verb listed in
 * `retryOnMethods`. A mutation that is not marked idempotent never is, since
 * a repeat after a lost response would act twice.
 */
export function isRetryableCall(
  method: string,
  policy: ResolvedHttpRetryPolicy,
  idempotent = false,
): boolean {
  if (idempotent) return true;
  const verb = method.toUpperCase();
  return !MUTATING_METHODS.has(verb) && policy.retryOnMethods.includes(verb);
}

export function isRetryableHttpStatus(
  method: string,
  status: number,
  policy: ResolvedHttpRetryPolicy,
  idempotent = false,
): boolean {
  return isRetryableCall(method, policy, idempotent) && policy.retryOnStatuses.includes(status);
}

export function isRetryableNetworkError(
  method: string,
  policy: ResolvedHttpRetryPolicy,
  idempotent = false,
): boolean {
  return isRetryableCall(method, policy, idempotent) && policy.retryOnNetworkError;
}
