import { AppError, type AppErrorOptions, type PlatformErrorCategory } from './error-values.js';
export { AppError } from './error-values.js';
export type { AppErrorOptions, PlatformErrorCategory, PlatformErrorSource } from './error-values.js';
import { assertJudgmentInput } from '../gate/judgment-input.js';
import {
  categoryForStatus,
  classifyFailure,
  HttpStatusError,
  readFailure,
  RETRYABLE_STATUS_CODES,
  structuralFailureConclusions,
  structuredTransience,
  type FailureConclusions,
  type FailureEvidence,
} from '@goodvibes-jev/engine/errors';
import { readRetryWaitMs } from './batteries/retry-wait.js';

export { RETRYABLE_STATUS_CODES };

export interface ProviderErrorOptions extends AppErrorOptions {
  readonly statusCode?: number | undefined;
}

function inferProviderGuidance(category: PlatformErrorCategory, statusCode?: number): string | undefined {
  switch (category) {
    case 'rate_limit':
      return 'The provider rate limited this request. GoodVibes will retry automatically when the caller supports retries. If this keeps happening, wait, reduce request volume, or switch models/providers.';
    case 'authentication':
      return 'The provider rejected authentication. Possible causes include invalid or expired credentials, missing account/session state, account restrictions, or the wrong provider/endpoint receiving the request.';
    case 'authorization':
      return 'The provider rejected the request after authentication. Possible causes include missing model access, account permissions, policy restrictions, or provider routing to a service that does not expose this model.';
    case 'billing':
      return 'The provider reported a billing or quota problem. Check credits, subscription status, usage limits, or account entitlements.';
    case 'timeout':
      return 'The request timed out before the provider finished responding. Check network stability, provider latency, and request size.';
    case 'network':
      return 'The request did not complete over the network. Check connectivity, DNS, TLS certificates, base URL, or any local proxy/tunnel.';
    case 'bad_request':
      return 'The provider rejected the request shape. Check model id, parameters, message format, and tool schema.';
    case 'not_found':
      return 'The requested model or endpoint was not found. Check model id, provider selection, and API path.';
    case 'protocol':
      return 'The provider response was incomplete or malformed. Check upstream protocol support, streaming mode, and transport stability.';
    case 'service':
      return statusCode === 503
        ? 'The provider is temporarily unavailable. Retry shortly or switch providers if the issue persists.'
        : 'The provider returned a server-side failure. Retry shortly or switch providers if the issue persists.';
    default:
      return undefined;
  }
}

/** Thrown when configuration is invalid or cannot be loaded. Non-recoverable. */
export class ConfigError extends AppError {
  declare readonly code: 'CONFIG_ERROR';
  constructor(message: string, options: Pick<AppErrorOptions, 'cause'> = {}) {
    super(message, 'CONFIG_ERROR', false, {
      category: 'config',
      source: 'config',
      cause: options.cause,
    });
  }

  override toJSON(): Record<string, unknown> {
    return { name: this.name, message: this.message, kind: this.kind, code: this.code,
      category: this.category, source: this.source, recoverable: this.recoverable };
  }
}

/** Thrown when an LLM provider API call fails. Recoverable when statusCode is in RETRYABLE_STATUS_CODES, or, with no status, when the failure is a network or timeout fault. */
export class ProviderError extends AppError {
  declare readonly code: 'PROVIDER_ERROR';
  constructor(message: string, statusCode?: number);
  constructor(message: string, options?: ProviderErrorOptions);
  constructor(message: string, statusCodeOrOptions?: number | ProviderErrorOptions, maybeOptions: ProviderErrorOptions = {}) {
    const options = typeof statusCodeOrOptions === 'number'
      ? { ...maybeOptions, statusCode: statusCodeOrOptions }
      : (statusCodeOrOptions ?? {});
    const statusCode = options.statusCode;
    // The status fixes a provisional category; whether a 400 or 429 is really a
    // spent account is read from the wording where it matters (readProviderFailure).
    const category = options.category ?? categoryForStatus(statusCode) ?? 'unknown';
    const guidance = options.guidance ?? inferProviderGuidance(category, statusCode);

    // A failure that never reached an HTTP status (a reset, a timeout) is the one a
    // retry most often clears; only a retryable status or a transport fault marks it recoverable.
    const transportFault = statusCode === undefined
      && (category === 'network' || category === 'timeout' || structuredTransience(options.cause)?.basis === 'errno');
    super(message, 'PROVIDER_ERROR', statusCode !== undefined ? RETRYABLE_STATUS_CODES.includes(statusCode) : transportFault, {
      // retryAfterMs passes through as given: only the explicit value (a
      // Retry-After header or a structured field). A wait the message states
      // in words is read by Jev through readRetryWait.
      ...options,
      statusCode,
      category,
      guidance,
      source: options.source ?? 'provider',
      rawMessage: options.rawMessage ?? message,
    });
  }
}

/** Thrown when a tool execution fails. Recoverable by default. */
export class ToolError extends AppError {
  declare readonly code: 'TOOL_ERROR';
  constructor(message: string, public readonly toolName: string, options: Pick<AppErrorOptions, 'cause'> = {}) {
    super(message, 'TOOL_ERROR', true, {
      category: 'tool',
      source: 'tool',
      cause: options.cause,
    });
  }
}

/** Thrown for ACP (Agent Control Protocol) errors. Recoverable by default. */
export class AcpError extends AppError {
  declare readonly code: 'ACP_ERROR';
  constructor(message: string) {
    super(message, 'ACP_ERROR', true, {
      source: 'acp',
    });
  }
}

/** Thrown when an operation is denied due to insufficient permissions. Non-recoverable. */
export class PermissionError extends AppError {
  declare readonly code: 'PERMISSION_DENIED';
  constructor(message: string) {
    super(message, 'PERMISSION_DENIED', false, {
      category: 'permission',
      source: 'permission',
    });
  }
}

/** Thrown when the renderer encounters a failure. Recoverable by default. */
export class RenderError extends AppError {
  declare readonly code: 'RENDER_ERROR';
  constructor(message: string) {
    super(message, 'RENDER_ERROR', true, {
      source: 'render',
    });
  }
}

/** The evidence a failure reading is about: the message and the fixed fields around it. */
export function failureEvidence(err: Error): FailureEvidence {
  const structuredCode = (err as { readonly code?: unknown }).code;
  const code = err instanceof AppError
    ? err.providerCode
    : typeof structuredCode === 'string' ? structuredCode : undefined;
  return {
    message: err.message,
    status: err instanceof AppError ? err.statusCode : undefined,
    code,
    errorName: err.name,
  };
}

/**
 * Reads what an error's wording says about the failure (one Jev request per
 * distinct wording). A reading that cannot be made (unavailable, refused
 * input, failed) answers from the status and code tables, so the caller acts
 * on the provider's own error and never on the judgment layer's.
 */
export async function readErrorFailure(err: Error, site: string): Promise<FailureConclusions> {
  const evidence = failureEvidence(err);
  try {
    assertJudgmentInput(evidence);
    return await readFailure(evidence, site);
  } catch {
    return structuralFailureConclusions(evidence);
  }
}

/**
 * Statuses under which a provider reports a spent account, a rate limit or a
 * context-window refusal with wording only (Anthropic a 400 "credit balance is
 * too low", OpenAI a 429 insufficient_quota, a 413 body too large). Any other
 * status answers those questions no without a reading.
 */
const WORDING_DECIDES_STATUS: ReadonlySet<number> = new Set([400, 413, 429]);

/**
 * How long to wait before retrying, in milliseconds: the explicit value the
 * error carries (a Retry-After header or a structured field) when there is
 * one, otherwise the wait the message states, read by Jev
 * (`engine.provider.retry-wait`). Undefined when neither gives one.
 */
export async function readRetryWait(err: unknown, site = 'types.errors.retry-wait'): Promise<number | undefined> {
  if (err instanceof AppError && err.retryAfterMs !== undefined) return err.retryAfterMs;
  if (!(err instanceof Error)) return undefined;
  return readRetryWaitMs({ message: err.message, status: err instanceof AppError ? err.statusCode : undefined }, site);
}

/**
 * Whether the provider rejected the call because the account cannot pay for
 * it: credits exhausted, balance too low, plan quota spent.
 *
 * This is NOT a rate limit and must never be retried on one. An Anthropic 400
 * carrying "Your credit balance is too low" was being reported as
 * "rate limited on turn 1, retrying in 60s" and retried three times.
 *
 * Structure decides first (an explicit `billing` category, a 402); otherwise
 * Jev reads the wording.
 */
export async function isBillingOrCreditError(err: unknown, site = 'types.errors.billing'): Promise<boolean> {
  if (err instanceof AppError && (err.category === 'billing' || err.statusCode === 402)) return true;
  if (!(err instanceof Error)) return false;
  const evidence = failureEvidence(err);
  if (evidence.status !== undefined && !WORDING_DECIDES_STATUS.has(evidence.status)) return false;
  if (evidence.status === undefined) {
    const classified = classifyFailure(err)?.category;
    if (classified !== undefined) return classified === 'billing';
  }
  return (await readErrorFailure(err, site)).billing;
}

/**
 * Whether the error is a rate limit or an exhausted quota. Used by
 * SyntheticProvider and AgentOrchestrator to decide whether to back off and
 * retry or escalate.
 *
 * Callers that decide whether to WAIT AND RETRY the same endpoint must check
 * {@link isBillingOrCreditError} first: a spent account is a quota failure,
 * and waiting does not fix it. Callers that ROTATE to another backend
 * (SyntheticProvider) are right to treat both the same way, since a
 * different account may well have credit.
 */
export async function isRateLimitOrQuotaError(err: unknown, site = 'types.errors.rate-limit'): Promise<boolean> {
  if (err instanceof ProviderError && (err.statusCode === 429 || err.statusCode === 402)) return true;
  if (!(err instanceof Error)) return false;
  const evidence = failureEvidence(err);
  if (evidence.status === 429 || evidence.status === 402) return true;
  if (evidence.status !== undefined && !WORDING_DECIDES_STATUS.has(evidence.status)) return false;
  if (evidence.status === undefined) {
    const classified = classifyFailure(err)?.category;
    if (classified !== undefined) return classified === 'rate_limit' || classified === 'billing';
  }
  return (await readErrorFailure(err, site)).rateLimited;
}

/** Statuses a context-window refusal comes back with; any other status answers no without a reading. */
const CONTEXT_REFUSAL_STATUS: ReadonlySet<number> = new Set([400, 413, 422]);
/** Provider codes that name a context-window refusal outright. */
const CONTEXT_REFUSAL_CODES: ReadonlySet<string> = new Set(['context_length_exceeded', 'request_too_large', 'string_above_max_length']);

/**
 * Whether the error says the model's context window was exceeded. Structure
 * decides first: a code that names it, or a status or errno that cannot mean
 * it. Only a 400-class refusal with no telling code, or an error with no
 * structure at all, is read by Jev. A failed reading answers no, so the
 * caller reports the original error.
 */
export async function isContextSizeExceededError(err: unknown, site = 'types.errors.context-exceeded'): Promise<boolean> {
  if (!(err instanceof Error)) return false;
  const evidence = failureEvidence(err);
  if (evidence.code !== undefined && CONTEXT_REFUSAL_CODES.has(evidence.code)) return true;
  if (evidence.status !== undefined && !CONTEXT_REFUSAL_STATUS.has(evidence.status)) return false;
  if (evidence.status === undefined && classifyFailure(err) !== undefined) return false;
  return (await readErrorFailure(err, site)).contextExceeded;
}

/**
 * The facts a stream retry carries for its readers, from the error's own
 * fields: its status, whether it was a rate or quota refusal, and the wait the
 * provider asked for. No model reads the message.
 */
export function streamRetryFacts(err: unknown): { status?: number; rateLimited: boolean; retryAfterMs?: number } {
  const status = err instanceof AppError ? err.statusCode : undefined;
  const classified = classifyFailure(err);
  const retryAfterMs = (err instanceof AppError ? err.retryAfterMs : undefined) ?? classified?.retryAfterMs;
  const rateLimited = status === 429 || (err instanceof AppError && err.category === 'rate_limit') || classified?.category === 'rate_limit';
  return { ...(status === undefined ? {} : { status }), rateLimited, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
}

/**
 * Whether the error is a transient network or transport failure (as opposed
 * to a programmer error or a permanent provider rejection).
 *
 * An `HttpStatusError` (e.g. from `createNetworkTransportError` in the HTTP
 * transport) is trusted on its structured `category`/`recoverable` fields,
 * which already account for TypeErrors, POSIX errno codes and undici
 * `UND_ERR_*` codes. The `instanceof` check is branded (see HttpStatusError's
 * Symbol.hasInstance), so a plain object carrying those properties is not
 * mistaken for one. Other errors are read by Jev.
 */
export async function isNetworkTransportError(err: unknown, site = 'types.errors.network-transport'): Promise<boolean> {
  if (err instanceof HttpStatusError) {
    return err.category === 'network' && err.recoverable === true;
  }
  if (!(err instanceof Error)) return false;
  // A response came back, so the transport carried it; a code in the connection table answers on its own.
  const evidence = failureEvidence(err);
  if (evidence.status !== undefined) return false;
  const classified = classifyFailure(err);
  if (classified !== undefined) return classified.category === 'network' || classified.category === 'timeout';
  return (await readErrorFailure(err, site)).transientNetwork;
}

/**
 * Whether the provider cannot serve requests as configured (credentials
 * rejected, no credit, access denied, or unreachable), as opposed to a
 * transient failure. 500 and 503 are not non-transient: server errors are
 * eligible for retry. Used to trigger graceful degradation and alternative
 * model suggestions.
 */
export async function isNonTransientProviderFailure(err: unknown, site = 'types.errors.non-transient'): Promise<boolean> {
  if (!(err instanceof Error)) return false;
  // A status or a category answers it: only a failure with neither is read, and a failed reading answers no.
  const status = err instanceof AppError ? err.statusCode : undefined;
  if (status !== undefined) return NON_TRANSIENT_STATUS.has(status);
  const category = err instanceof AppError && err.category !== 'unknown' ? err.category : classifyFailure(err)?.category;
  if (category !== undefined) return NON_TRANSIENT_CATEGORIES.has(category);
  return (await readErrorFailure(err, site)).providerUnusable;
}

const NON_TRANSIENT_CATEGORIES: ReadonlySet<string> = new Set(['authentication', 'authorization', 'billing']);

const NON_TRANSIENT_STATUS: ReadonlySet<number> = new Set([401, 402, 403]);
