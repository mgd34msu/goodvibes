import { RECOVERABLE_STATED, structuredTransience, TRANSIENT_STATUS_CODES } from './failure-transience.js';
import { categoryForStatus } from './failure-reading.js';
import { readNextSteps, type Refusal } from './refusal.js';
import type {
  DaemonErrorCategory,
  DaemonErrorSource,
  StructuredDaemonErrorBody,
} from './daemon-error-contract.js';
import { EngineErrorCodes, isErrorCode, isKnownErrorCode, type EngineErrorCode } from './error-codes.js';

export type {
  DaemonErrorSource,
  StructuredDaemonErrorBody,
} from './daemon-error-contract.js';
export { DaemonErrorCategory, MEMORY_RECORD_NOT_FOUND_CODE } from './daemon-error-contract.js';
// Re-exported unchanged from error-codes.ts (split out to stay under the file's
// 800-line cap, see that file's header comment).
export { EngineErrorCodes, isErrorCode, isKnownErrorCode, type EngineErrorCode };

/**
 * `'contract'` is an platform-internal category used when the daemon returns
 * a response that violates the expected contract schema. It is NOT part of the
 * daemon wire schema (`DaemonErrorCategory`) and MUST NOT be marshalled over
 * the wire, doing so will cause the daemon to schema-reject the error envelope.
 * Treat `'contract'` as a local platform sentinel only.
 */
export type ErrorCategory = DaemonErrorCategory | 'contract';

export type ErrorSource = DaemonErrorSource | 'contract';

/**
 * Tagged union discriminant for all platform errors. Use this for exhaustive
 * switch/if-else handling instead of `instanceof` chains.
 *
 * @example
 * if (error instanceof GoodVibesError) {
 *   if (error.kind === 'rate-limit') {
 *     await delay(error.retryAfterMs ?? 1000);
 *   } else if (error.kind === 'auth') {
 *     // refresh credentials
 *   }
 * }
 */
export type EngineErrorKind =
  | 'auth'
  | 'config'
  | 'contract'
  | 'network'
  | 'not-found'
  | 'protocol'
  | 'rate-limit'
  | 'service'
  | 'internal'
  | 'tool'
  | 'validation'
  | 'unknown';

function inferKind(category: ErrorCategory): EngineErrorKind {
  switch (category) {
    case 'authentication':
    case 'authorization':
    case 'billing':
    case 'permission':
      return 'auth';
    case 'config':
      return 'config';
    case 'contract':
      return 'contract';
    case 'network':
    case 'timeout':
      return 'network';
    case 'not_found':
      return 'not-found';
    case 'rate_limit':
      return 'rate-limit';
    case 'protocol':
      return 'protocol';
    case 'internal':
      return 'internal';
    case 'service':
      return 'service';
    case 'bad_request':
      return 'validation';
    case 'tool':
      return 'tool';
    case 'unknown':
    default:
      return 'unknown';
  }
}

/**
 * Infers the canonical {@link EngineErrorCode} from an {@link ErrorCategory}.
 * Used internally to populate `code` when no explicit code is provided.
 * @internal
 */
function inferCodeFromCategory(category: ErrorCategory): EngineErrorCode {
  switch (category) {
    case 'authentication': return 'AUTH_REQUIRED';
    case 'authorization': return 'PERMISSION_DENIED';
    case 'billing': return 'PAYMENT_REQUIRED';
    case 'permission': return 'PERMISSION_DENIED';
    case 'config': return 'ENGINE_CONFIGURATION_ERROR';
    case 'contract': return 'CONTRACT_MISMATCH';
    case 'network': return 'NETWORK_UNREACHABLE';
    case 'timeout': return 'TIMEOUT';
    case 'not_found': return 'NOT_FOUND';
    case 'rate_limit': return 'RATE_LIMITED';
    case 'protocol': return 'PROTOCOL_ERROR';
    case 'internal': return 'INTERNAL_ERROR';
    case 'service': return 'SERVICE_UNAVAILABLE';
    case 'bad_request': return 'VALIDATION_FAILED';
    case 'tool': return 'TOOL_EXEC_FAILED';
    case 'unknown':
    default:
      return 'UNKNOWN';
  }
}

export interface GoodVibesErrorOptions {
  /**
   * A typed error code for programmatic matching. May be an {@link EngineErrorCode}
   * literal or any custom string for caller-supplied codes.
   * When omitted, the platform infers a code from `category` or `status`.
   */
  readonly code?: EngineErrorCode | (string & {}) | undefined;
  readonly category?: ErrorCategory | undefined;
  readonly source?: ErrorSource | undefined;
  readonly recoverable?: boolean | undefined;
  readonly status?: number | undefined;
  readonly url?: string | undefined;
  readonly method?: string | undefined;
  readonly body?: unknown | undefined;
  readonly hint?: string | undefined;
  /** What is true now, when the failure is a refusal (see {@link Refusal}). */
  readonly state?: string | undefined;
  /** Steps that would get past the refusal; `hint` defaults to the first. */
  readonly next?: readonly string[] | undefined;
  readonly provider?: string | undefined;
  readonly operation?: string | undefined;
  readonly phase?: string | undefined;
  readonly requestId?: string | undefined;
  readonly providerCode?: string | undefined;
  readonly providerType?: string | undefined;
  readonly retryAfterMs?: number | undefined;
  readonly cause?: unknown | undefined;
}

/** HTTP statuses a retry can clear; one list shared with the transience decision (failure-transience.ts). */
export const RETRYABLE_STATUS_CODES: readonly number[] = TRANSIENT_STATUS_CODES;

// One status-to-category table (categoryForStatus) serves the errors thrown by
// the transport and the ones normalised from providers, so the same status
// never reads as two categories. 409 Conflict and statuses with no category
// stay 'unknown': the caller supplies one explicitly.
function inferCategory(status?: number): ErrorCategory {
  return categoryForStatus(status) ?? 'unknown';
}

/**
 * Infers the canonical {@link EngineErrorCode} for HTTP status codes that have a
 * direct 1-to-1 mapping, used when no explicit code is present in the response
 * body. Returns `undefined` when the code should fall through to category-based
 * inference (e.g. for structured-body responses that supply their own category).
 * @internal
 */
function inferCodeFromStatus(status: number): EngineErrorCode | undefined {
  switch (status) {
    case 400: return 'VALIDATION_FAILED';
    case 401: return 'AUTH_REQUIRED';
    case 402: return 'PAYMENT_REQUIRED';
    case 403: return 'PERMISSION_DENIED';
    case 404: return 'NOT_FOUND';
    case 408: return 'TIMEOUT';
    case 409: return 'CONFLICT';
    case 429: return 'RATE_LIMITED';
    default:
      if (status >= 500) return 'SERVICE_UNAVAILABLE';
      return undefined;
  }
}

const ERROR_CATEGORIES = new Set<ErrorCategory>([
  'authentication',
  'authorization',
  'bad_request',
  'billing',
  'config',
  'contract',
  'internal',
  'network',
  'not_found',
  'permission',
  'protocol',
  'rate_limit',
  'service',
  'timeout',
  'tool',
  'unknown',
]);

const GOODVIBES_ERROR_BRAND = Symbol.for('goodvibes.engine.error');
const HTTP_STATUS_ERROR_BRAND = Symbol.for('goodvibes.engine.http-status-error');

function readErrorCategory(value: unknown): ErrorCategory | undefined {
  return typeof value === 'string' && ERROR_CATEGORIES.has(value as ErrorCategory)
    ? value as ErrorCategory
    : undefined;
}

const MAX_ERROR_CAUSE_DEPTH = 32;

function inferCategoryFromCause(cause: unknown, seen = new Set<object>(), depth = 0): ErrorCategory | undefined {
  if (depth >= MAX_ERROR_CAUSE_DEPTH) return undefined;
  if (!cause || typeof cause !== 'object') return undefined;
  const objectCause = cause as object;
  if (seen.has(objectCause)) return undefined;
  seen.add(objectCause);
  const record = cause as {
    readonly category?: unknown | undefined;
    readonly cause?: unknown | undefined;
    readonly originalError?: unknown | undefined;
    readonly error?: unknown | undefined;
  };
  const category = readErrorCategory(record.category);
  if (category && category !== 'unknown') return category;
  return inferCategoryFromCause(record.cause, seen, depth + 1)
    ?? inferCategoryFromCause(record.originalError, seen, depth + 1)
    ?? inferCategoryFromCause(record.error, seen, depth + 1);
}

/**
 * Base error class for all errors thrown by the GoodVibes platform.
 *
 * Every error carries a structured `category`, `source`, and `code` that allow
 * callers to handle specific failure modes without string-matching messages.
 *
 * The `code` field is typed as `EngineErrorCode | (string & {})`, platform-produced
 * errors always carry a known {@link EngineErrorCode}, while caller-supplied codes
 * remain valid arbitrary strings.
 *
 * ### Narrowing by code
 * ```ts
 * import { GoodVibesError, isErrorCode, EngineErrorCodes } from '@goodvibes-jev/engine/errors';
 *
 * catch (err) {
 *   if (err instanceof GoodVibesError) {
 *     if (isErrorCode(err, EngineErrorCodes.RATE_LIMITED)) {
 *       await delay(err.retryAfterMs ?? 1000);
 *     } else if (isErrorCode(err, EngineErrorCodes.TOKEN_EXPIRED)) {
 *       await refreshToken();
 *     }
 *   }
 * }
 * ```
 *
 * ### Narrowing by kind
 * ```ts
 * import { GoodVibesError, HttpStatusError, ConfigurationError } from '@goodvibes-jev/engine/errors';
 *
 * try {
 *   await platform.operator.agents.list();
 * } catch (err) {
 *   if (err instanceof HttpStatusError && err.category === 'rate_limit') {
 *     // Back off and retry after err.retryAfterMs
 *   } else if (err instanceof ConfigurationError) {
 *     // Invalid platform setup, not recoverable
 *   } else if (err instanceof GoodVibesError) {
 *     console.error(err.category, err.hint);
 *   }
 * }
 * ```
 */
export class GoodVibesError extends Error {
  public readonly kind: EngineErrorKind;
  /**
   * Typed error code for programmatic matching. platform-produced errors always set
   * a {@link EngineErrorCode}; caller-supplied codes may be any string.
   *
   * **Note:** `code` and `category` are inferred independently and can diverge.
   * For example, `new GoodVibesError('…', { status: 409 })` yields
   * `code === 'CONFLICT'` (from `inferCodeFromStatus`) while
   * `category === 'unknown'` (because `inferCategory` intentionally returns
   * `'unknown'` for 409, the caller must supply `category` explicitly to get
   * a meaningful category for conflict-style errors).
   */
  public readonly code: EngineErrorCode | (string & {});
  public readonly category: ErrorCategory;
  public readonly source: ErrorSource;
  /**
   * Whether another attempt can succeed. The value passed in when one was;
   * otherwise derived from the error's own fields by the engine's retry
   * decision (`structuredTransience`: Retry-After, status, connection code,
   * timeout class, category), so this field and the engine's retries agree.
   */
  public readonly recoverable: boolean;
  public readonly status?: number | undefined;
  public readonly url?: string | undefined;
  public readonly method?: string | undefined;
  public readonly body?: unknown | undefined;
  public readonly hint?: string | undefined;
  public readonly state?: string | undefined;
  public readonly next?: readonly string[] | undefined;
  public readonly provider?: string | undefined;
  public readonly operation?: string | undefined;
  public readonly phase?: string | undefined;
  public readonly requestId?: string | undefined;
  public readonly providerCode?: string | undefined;
  public readonly providerType?: string | undefined;
  public readonly retryAfterMs?: number | undefined;
  public override readonly cause?: unknown | undefined;

  static override [Symbol.hasInstance](value: unknown): boolean {
    if (this !== GoodVibesError) {
      return typeof value === 'object'
        && value !== null
        && this.prototype.isPrototypeOf(value);
    }
    if (typeof value !== 'object' || value === null) return false;
    const record = value as Record<PropertyKey, unknown>;
    return record[GOODVIBES_ERROR_BRAND] === true;
  }

  constructor(message: string, options: GoodVibesErrorOptions = {}) {
    const category = options.category
      ?? inferCategoryFromCause(options.cause)
      ?? inferCategory(options.status);
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = this.constructor.name;
    Object.defineProperty(this, GOODVIBES_ERROR_BRAND, {
      value: true,
      enumerable: false,
      configurable: false,
    });
    // Infer code from status first (most specific), then from category.
    // Explicit caller-supplied code always wins.
    this.code = options.code
      ?? (options.status !== undefined ? inferCodeFromStatus(options.status) : undefined)
      ?? inferCodeFromCategory(category);
    this.category = category;
    this.kind = inferKind(this.category);
    this.source = options.source ?? 'unknown';
    this.status = options.status;
    this.url = options.url;
    this.method = options.method;
    this.body = options.body;
    this.state = options.state;
    this.next = options.next === undefined ? undefined : Object.freeze([...options.next]);
    this.hint = options.hint ?? options.next?.[0];
    this.provider = options.provider;
    this.operation = options.operation;
    this.phase = options.phase;
    this.requestId = options.requestId;
    this.providerCode = options.providerCode;
    this.providerType = options.providerType;
    this.retryAfterMs = options.retryAfterMs;
    this.cause = options.cause;
    if (options.recoverable !== undefined) {
      Object.defineProperty(this, RECOVERABLE_STATED, { value: true, enumerable: false, configurable: false });
    }
    this.recoverable = options.recoverable ?? structuredTransience(this)?.failureClass === 'retryable';
  }

  toJSON(): Record<string, unknown> {
    return omitUndefined({
      name: this.name,
      message: this.message,
      kind: this.kind,
      code: this.code,
      category: this.category,
      source: this.source,
      recoverable: this.recoverable,
      status: this.status,
      url: this.url,
      method: this.method,
      body: this.body,
      hint: this.hint,
      state: this.state,
      next: this.next,
      provider: this.provider,
      operation: this.operation,
      phase: this.phase,
      requestId: this.requestId,
      providerCode: this.providerCode,
      providerType: this.providerType,
      retryAfterMs: this.retryAfterMs,
      cause: serializeCause(this.cause),
    });
  }
}

function serializeCause(cause: unknown, seen = new Set<object>(), depth = 0): unknown {
  if (cause === undefined) return undefined;
  if (depth >= MAX_ERROR_CAUSE_DEPTH) return undefined;
  if (cause instanceof Error) {
    const record: Record<string, unknown> = { name: cause.name, message: cause.message };
    // Walk .cause, .originalError, .error chains symmetrically with inferCategoryFromCause.
    const causeRecord = cause as { readonly cause?: unknown; readonly originalError?: unknown; readonly error?: unknown };
    const nestedCause = causeRecord.cause ?? causeRecord.originalError ?? causeRecord.error;
    if (nestedCause !== undefined) {
      const objectKey = causeRecord.cause !== undefined ? 'cause' : causeRecord.originalError !== undefined ? 'originalError' : 'error';
      const serialized = typeof nestedCause === 'object' && nestedCause !== null
        ? (seen.has(nestedCause as object) ? '[Circular]' : serializeCause(nestedCause, new Set([...seen, nestedCause as object]), depth + 1))
        : serializeCause(nestedCause, seen, depth + 1);
      if (serialized !== undefined) record[objectKey] = serialized;
    }
    return omitUndefined(record as Record<string, unknown>);
  }
  if (typeof cause === 'object' && cause !== null) {
    if (seen.has(cause as object)) return '[Circular]';
    // Serialize plain-object causes (e.g. from transport error payloads) as-is.
    return cause;
  }
  return cause;
}

function omitUndefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

/**
 * Thrown when the platform is misconfigured (e.g. missing `baseUrl`, no fetch
 * implementation available, or calling a mutation on a read-only auth resolver).
 *
 * Always non-recoverable (`recoverable: false`).
 * Category: `'config'`. Kind: `'config'`. Code: `'ENGINE_CONFIGURATION_ERROR'`.
 *
 * @example
 * import { ConfigurationError } from '@goodvibes-jev/engine/errors';
 *
 * try {
 *   await platform.auth.setToken('x');
 * } catch (err) {
 *   if (err instanceof ConfigurationError) {
 *     // platform was constructed with getAuthToken, token mutation not supported
 *   }
 * }
 */
export class ConfigurationError extends GoodVibesError {
  /**
   * Brand contract, `code` is the source of truth, not the prototype chain.
   * A `GoodVibesError` constructed directly with `code: 'ENGINE_CONFIGURATION_ERROR'`
   * will pass `instanceof ConfigurationError` even if its prototype is only
   * `GoodVibesError`. Callers that need strict prototype checking should use
   * `Object.getPrototypeOf(err) === ConfigurationError.prototype` instead.
   */
  static override [Symbol.hasInstance](value: unknown): boolean {
    if (this !== ConfigurationError) {
      return typeof value === 'object'
        && value !== null
        && this.prototype.isPrototypeOf(value);
    }
    // Require both the brand (real platform error instance) and matching code
    // to prevent plain objects like { code: 'ENGINE_CONFIGURATION_ERROR' } from passing.
    return GoodVibesError[Symbol.hasInstance](value)
      && (value as Record<PropertyKey, unknown>).code === 'ENGINE_CONFIGURATION_ERROR';
  }

  constructor(message: string, options: GoodVibesErrorOptions = {}) {
    super(message, {
      ...options,
      code: options.code ?? 'ENGINE_CONFIGURATION_ERROR',
      category: 'config',
      source: options.source ?? 'config',
      recoverable: false,
    });
  }
}

/**
 * Thrown when a response from the daemon violates the expected contract
 * (unexpected shape, missing required fields, etc.).
 *
 * Always non-recoverable (`recoverable: false`).
 * Category: `'contract'`. Kind: `'contract'`. Code: `'ENGINE_CONTRACT_ERROR'`.
 *
 * @example
 * import { ContractError } from '@goodvibes-jev/engine/errors';
 *
 * try {
 *   const result = await platform.operator.agents.get({ id: agentId });
 * } catch (err) {
 *   if (err instanceof ContractError) {
 *     // Daemon returned an unexpected shape, platform version mismatch?
 *     console.error('Contract violation:', err.message);
 *   }
 * }
 */
export class ContractError extends GoodVibesError {
  /**
   * Brand contract, `code` is the source of truth, not the prototype chain.
   * A `GoodVibesError` constructed directly with `code: 'ENGINE_CONTRACT_ERROR'`
   * will pass `instanceof ContractError` even if its prototype is only
   * `GoodVibesError`. Callers that need strict prototype checking should use
   * `Object.getPrototypeOf(err) === ContractError.prototype` instead.
   */
  static override [Symbol.hasInstance](value: unknown): boolean {
    if (this !== ContractError) {
      return typeof value === 'object'
        && value !== null
        && this.prototype.isPrototypeOf(value);
    }
    // Require both the brand (real platform error instance) and matching code
    // to prevent plain objects like { code: 'ENGINE_CONTRACT_ERROR' } from passing.
    return GoodVibesError[Symbol.hasInstance](value)
      && (value as Record<PropertyKey, unknown>).code === 'ENGINE_CONTRACT_ERROR';
  }

  constructor(message: string, options: GoodVibesErrorOptions = {}) {
    super(message, {
      ...options,
      code: options.code ?? 'ENGINE_CONTRACT_ERROR',
      category: 'contract',
      source: options.source ?? 'contract',
      recoverable: false,
    });
  }
}

/**
 * Thrown when the daemon returns a non-2xx HTTP status code.
 *
 * The `category` field is inferred from the status code:
 * - `401` → `'authentication'`  `402` → `'billing'`  `403` → `'authorization'`
 * - `404` → `'not_found'`  `408` → `'timeout'`  `429` → `'rate_limit'`
 * - `5xx` → `'service'`
 * - Any other status (or when constructed without a `status`) → `'unknown'`
 *
 * The `code` field is inferred from `status` automatically:
 * - `400` → `'VALIDATION_FAILED'`
 * - `401` → `'AUTH_REQUIRED'`
 * - `402` → `'PAYMENT_REQUIRED'`
 * - `403` → `'PERMISSION_DENIED'`
 * - `404` → `'NOT_FOUND'`
 * - `408` → `'TIMEOUT'`
 * - `409` → `'CONFLICT'`
 * - `429` → `'RATE_LIMITED'`
 * - `5xx` → `'SERVICE_UNAVAILABLE'`
 *
 * When constructed without a `status` argument (e.g. as a typed
 * wrapper around a structured daemon error that provides its own `category`),
 * the category defaults to `'unknown'`. Callers relying on category-based
 * routing should always prefer the structured-body factory
 * (`createHttpStatusError`) or check `err.category` directly rather than
 * assuming a specific category from constructor arguments alone.
 *
 * Use `recoverable` to decide whether to retry (it is the engine's own retry
 * decision, or the daemon's stated value), and `retryAfterMs` for the backoff
 * hint on rate-limit responses.
 *
 * @example
 * import { HttpStatusError } from '@goodvibes-jev/engine/errors';
 *
 * try {
 *   await platform.operator.agents.list();
 * } catch (err) {
 *   if (err instanceof HttpStatusError) {
 *     if (err.category === 'rate_limit') {
 *       await delay(err.retryAfterMs ?? 1000);
 *     } else if (!err.recoverable) {
 *       throw err; // Surface non-retryable errors immediately
 *     }
 *   }
 * }
 */
export class HttpStatusError extends GoodVibesError {
  /**
   * Brand contract: `instanceof HttpStatusError` relies on a dedicated Symbol
   * brand stamped in the constructor, enabling cross-realm identity checks that
   * are independent of the `code` field.
   *
   * A `GoodVibesError` constructed directly with `code: 'ENGINE_HTTP_STATUS_ERROR'`
   * will also pass `instanceof HttpStatusError` for backward compatibility with
   * callers that serialise/deserialise errors by code. Callers that need strict
   * prototype checking should use
   * `Object.getPrototypeOf(err) === HttpStatusError.prototype` instead.
   */
  static override [Symbol.hasInstance](value: unknown): boolean {
    if (this !== HttpStatusError) {
      return typeof value === 'object'
        && value !== null
        && this.prototype.isPrototypeOf(value);
    }
    if (!GoodVibesError[Symbol.hasInstance](value)) return false;
    const record = value as Record<PropertyKey, unknown>;
    // Primary: dedicated brand symbol (set in constructor, works in same realm).
    if (record[HTTP_STATUS_ERROR_BRAND] === true) return true;
    // Fallback: code-based brand for cross-realm / serialised-error compat.
    return record.code === 'ENGINE_HTTP_STATUS_ERROR';
  }

  constructor(message: string, options: GoodVibesErrorOptions = {}) {
    super(message, {
      ...options,
      // Default code retains 'ENGINE_HTTP_STATUS_ERROR' when no explicit code is
      // supplied. Use createHttpStatusError() for status-specific semantic codes.
      code: options.code ?? 'ENGINE_HTTP_STATUS_ERROR',
      source: options.source ?? 'transport',
    });
    // Stamp the brand AFTER super() so the symbol is always present on instances
    // produced by this constructor (regardless of which code was stored).
    Object.defineProperty(this, HTTP_STATUS_ERROR_BRAND, {
      value: true,
      enumerable: false,
      configurable: false,
    });
  }
}

const WIRE_SOURCES: ReadonlySet<string> = new Set(['provider', 'tool', 'transport', 'config', 'permission', 'runtime', 'render', 'acp', 'unknown']);

function readWireSource(value: unknown): DaemonErrorSource | undefined {
  return typeof value === 'string' && WIRE_SOURCES.has(value) ? value as DaemonErrorSource : undefined;
}

export function isStructuredDaemonErrorBody(value: unknown): value is StructuredDaemonErrorBody {
  return typeof value === 'object' && value !== null && typeof (value as { error?: unknown }).error === 'string';
}

/**
 * Creates an {@link HttpStatusError} from an HTTP response.
 *
 * When `body` is a {@link StructuredDaemonErrorBody}, its fields are used
 * directly (including any explicit `code`). When the body is unstructured,
 * the `code` is inferred from `status` via status-based inference (`inferCodeFromStatus`).
 *
 * The structured body path respects the body-supplied `code` over status
 * inference, preserving full backward compatibility for callers that supply
 * custom codes in the daemon response.
 *
 * @param status - HTTP status code.
 * @param url - Request URL.
 * @param method - HTTP method.
 * @param body - Parsed response body (may be structured or unstructured).
 * @param fallbackHint - Human-readable hint when the body provides none.
 */
export function createHttpStatusError(
  status: number,
  url: string,
  method: string,
  body: unknown,
  fallbackHint?: string,
): HttpStatusError {
  if (isStructuredDaemonErrorBody(body)) {
    // The body comes off the wire: keep only fields of the declared type. A
    // category outside the wire set (including the local-only 'contract'), a
    // string where a number or boolean belongs, or a non-string label is
    // dropped, so the category falls back to what the status implies.
    const rawCategory: unknown = body.category;
    const wireCategory = rawCategory !== 'contract' ? readErrorCategory(rawCategory) as DaemonErrorCategory | undefined : undefined;
    const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
    const wireCode = typeof body.code === 'string' && body.code.length > 0 ? body.code : undefined;
    const wireRetryAfterMs = typeof body.retryAfterMs === 'number' && Number.isFinite(body.retryAfterMs) && body.retryAfterMs >= 0
      ? body.retryAfterMs
      : undefined;
    // Code precedence (highest to lowest):
    //   1. Explicit code in the body (daemon-supplied)
    //   2. Category-derived code when body supplies a category (category is
    //      more semantically specific than the HTTP status in this case)
    //   3. Status-derived code as final fallback
    const structuredCode =
      wireCode
      ?? (wireCategory !== undefined ? inferCodeFromCategory(wireCategory) : undefined)
      ?? inferCodeFromStatus(status)
      ?? 'UNKNOWN';
    return new HttpStatusError(body.error, {
      code: structuredCode,
      category: wireCategory,
      source: readWireSource(body.source) ?? 'transport',
      recoverable: typeof body.recoverable === 'boolean' ? body.recoverable : undefined,
      status,
      url,
      method,
      body,
      hint: text(body.hint) ?? fallbackHint,
      state: text(body.state),
      next: readNextSteps(body.next),
      provider: text(body.provider),
      operation: text(body.operation),
      phase: text(body.phase),
      requestId: text(body.requestId),
      providerCode: text(body.providerCode),
      providerType: text(body.providerType),
      retryAfterMs: wireRetryAfterMs,
    });
  }

  // Some routes answer `{ status, error: { code, message } }` rather than a
  // flat `{ error: string }`; read the nested pair so the code and message the
  // server chose survive instead of the status-derived defaults.
  const nested = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
  const nestedFields = typeof nested === 'object' && nested !== null ? nested as { code?: unknown; message?: unknown } : undefined;
  const nestedMessage = typeof nestedFields?.message === 'string' && nestedFields.message.trim() ? nestedFields.message.trim() : undefined;
  const nestedCode = typeof nestedFields?.code === 'string' && nestedFields.code.length > 0 ? nestedFields.code : undefined;

  const message = typeof body === 'string' && body.trim()
    ? body.trim()
    : nestedMessage ?? `Request failed with status ${status}`;

  return new HttpStatusError(message, {
    // Explicitly inject the status-inferred code so HttpStatusError's own
    // default ('ENGINE_HTTP_STATUS_ERROR') does not suppress the specific code.
    code: nestedCode ?? inferCodeFromStatus(status) ?? 'ENGINE_HTTP_STATUS_ERROR',
    status,
    url,
    method,
    body,
    hint: fallbackHint,
  });
}

/**
 * A failure that is a {@link Refusal}: thrown where the code that refuses is
 * not the code that answers (a route handler, a tool, a command). It is a
 * `GoodVibesError` with `state` and `next` set, so the daemon's error body,
 * `toJSON` and `readRefusal` carry the three fields without reading wording.
 */
export class RefusalError extends GoodVibesError {
  public readonly refusal: Refusal;
  public readonly retryable: boolean;

  static override [Symbol.hasInstance](value: unknown): boolean {
    if (this !== RefusalError) return typeof value === 'object' && value !== null && this.prototype.isPrototypeOf(value);
    if (!GoodVibesError[Symbol.hasInstance](value)) return false;
    const refusal = (value as { readonly refusal?: unknown }).refusal;
    return typeof refusal === 'object' && refusal !== null;
  }

  constructor(refusal: Refusal, options: Pick<GoodVibesErrorOptions, 'category' | 'source' | 'cause'> = {}) {
    super(refusal.reason, {
      ...options,
      code: refusal.code,
      status: refusal.status,
      recoverable: refusal.retryable,
      state: refusal.state,
      next: refusal.next,
      retryAfterMs: refusal.retryAfterMs,
    });
    this.refusal = refusal;
    this.retryable = refusal.retryable;
  }
}

export {
  commandOk, commandRefused, formatRefusal, isRefusal, readNextSteps, readRefusal, refusal, refusalErrorBody, toRefusal,
  type CommandResult, type Refusal, type RefusalInit,
} from './refusal.js';
export { installJudgmentPort, judgmentPort, restoreJudgmentPort, JudgmentPortMissingError } from './judgment-port.js';
export { assertDecisionModelsEnabled, decisionModelPolicyState, installDecisionModelPolicyObserver, DecisionModelsDisabledError,
  tryClassicDecisionFallback, runDecisionOrClassic, DECISION_MODEL_POLICIES, parseDecisionModelPolicy, DECISION_MODEL_POLICY_HEADER,
  readDecisionModelPolicyHeader, type DecisionModelPolicy, type DecisionModelPolicyState } from './decision-policy.js';
export { bindJudgmentPortAuthority, captureJudgmentPort, JudgmentAuthorityRetiredError,
  type JudgmentAuthorityFrame, type JudgmentEffectRestriction, type JudgmentPortCapture, type JudgmentReadingOptions } from './judgment-authority.js';
export {
  categoryDependsOnWording,
  categoryForCode,
  categoryForStatus,
  connectionForCode,
  connectionSummary,
  failureReading,
  failureState,
  settleCategory,
  summaryDependsOnWording,
  forgetFailureReadings,
  readFailure,
  structuralFailureConclusions,
  type ConnectionFailure,
  type FailureCategory,
  type FailureConclusions,
  type FailureEvidence,
  type FailureReadOptions,
  type FailureQuestion,
} from './failure-reading.js';
export {
  classifyFailure,
  httpStatusOf,
  readFailureTransience,
  statedRetryable,
  structuredTransience,
  transienceFromReading,
  TRANSIENT_STATUS_CODES,
  type FailureClass,
  type FailureClassification,
  type FailureTransience,
  type TransienceBasis,
  type TransienceOptions,
} from './failure-transience.js';

export { admitRegex, compileLegacyRegex, createSharedRegexTester, RegexAdmissionError,
  type AdmittedRegex, type SharedRegexTester, type RegexAdmissionOptions, type RegexReadingCapability, type ContractRegexReadingContext, type ContractRegexReadingFactory, type RegexMatch } from './regex-admission.js';
