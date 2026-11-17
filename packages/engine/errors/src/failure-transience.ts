import { JudgmentAuthorityRetiredError } from './judgment-authority.js';
import { DaemonErrorCategory } from './daemon-error-contract.js';
import {
  categoryForCode,
  categoryForStatus,
  readFailure,
  type FailureCategory,
  type FailureConclusions,
  type FailureEvidence,
  type FailureReadOptions,
} from './failure-reading.js';

/**
 * Whether a failure is worth another attempt: the one transience decision the
 * engine's retry, cooldown and dead-letter sites share (integration delivery,
 * automation runs, provider batches). Structure decides first; only when
 * structure is silent is the wording read through the engine failure battery
 * (`readFailure`). Code with no judgment port (the client platform's token
 * refresh) uses {@link structuredTransience} alone and treats its silence as
 * "keep trying".
 */
export type FailureClass = 'retryable' | 'terminal';

/**
 * What a transience decision rested on: an explicit classification the error
 * carries (a stated `retryable` or `recoverable`, or its own category), a
 * structured fact (a Retry-After, an HTTP status, an errno code, a timeout
 * error class), a cancellation, Jev's reading of the wording, or no wording
 * at all.
 */
export type TransienceBasis = 'explicit' | 'retry-after' | 'status' | 'errno' | 'error-type' | 'cancelled' | 'reading' | 'classic' | 'no-wording';

/** Whether a failure is worth another attempt, and why. */
export interface FailureTransience {
  readonly failureClass: FailureClass;
  readonly basis: TransienceBasis;
  /** The fact or reading behind the decision, for logs and the decision trail. */
  readonly detail: string;
}

export interface TransienceOptions {
  /** Owned port, cancellation and current-source checks; bypasses shared wording memoization. */
  readonly reading?: FailureReadOptions;
  /**
   * The failure came from an LLM provider's API. Providers report a spent
   * account under a 429 (OpenAI `insufficient_quota`), which its status alone
   * calls retryable, so a provider's 429 is also read for billing.
   */
  readonly fromProvider?: boolean;
  /** Renders a failure that is neither an Error nor a string as text for the reading. */
  readonly describe?: (error: unknown) => string;
}

/** HTTP statuses a retry can clear: request timeout, rate limit, server failures. */
export const TRANSIENT_STATUS_CODES: readonly number[] = [408, 429, 500, 502, 503, 504, 529];
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set(TRANSIENT_STATUS_CODES);

/** Error class names a deadline produces (AbortSignal.timeout, fetch and socket timeouts). */
const TIMEOUT_ERROR_NAMES: ReadonlySet<string> = new Set(['TimeoutError']);

/**
 * The reading's categories, split by whether sending the same thing again
 * could succeed. The rest ('unknown') leave the wording unsettled.
 */
const TRANSIENT_CATEGORIES: ReadonlySet<FailureCategory> = new Set(['rate_limit', 'timeout', 'network', 'service', 'protocol']);
const PERMANENT_CATEGORIES: ReadonlySet<FailureCategory> = new Set(['authentication', 'authorization', 'billing', 'not_found', 'bad_request']);

/** Categories an error may carry that a retry cannot clear; the reading's permanent ones plus the platform's own. */
const PERMANENT_OWN_CATEGORIES: ReadonlySet<string> = new Set([...PERMANENT_CATEGORIES, 'permission', 'config', 'contract']);

const GOODVIBES_ERROR_BRAND = Symbol.for('goodvibes.engine.error');

/**
 * Stamped by `GoodVibesError` when its creator passed `recoverable`. Every
 * GoodVibesError carries the field, so only a stated one is a classification;
 * an unstated one is derived from this module's own decision.
 */
export const RECOVERABLE_STATED = Symbol.for('goodvibes.engine.error.recoverable-stated');

function numberField(value: object, key: string): number | undefined {
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' && field.length > 0 ? field : undefined;
}

/** The HTTP status an error carries as a field (`status`, or `statusCode` as AppError and DeliveryError name it). */
export function httpStatusOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  for (const key of ['status', 'statusCode']) {
    const status = numberField(error, key);
    if (status !== undefined && status >= 100 && status <= 599) return status;
  }
  return undefined;
}

/**
 * Whether the error states its own retryability: a `retryable` boolean (a
 * refusal, a wire body), or a `recoverable` boolean its creator set. A
 * GoodVibesError's `recoverable` counts only when it was passed in.
 */
export function statedRetryable(error: unknown): boolean | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as Record<PropertyKey, unknown>;
  if (typeof record.retryable === 'boolean') return record.retryable;
  if (typeof record.recoverable !== 'boolean') return undefined;
  if (record[GOODVIBES_ERROR_BRAND] === true && record[RECOVERABLE_STATED] !== true) return undefined;
  return record.recoverable;
}

/** Whether the error is a deadline: a timeout class, or an abort whose cause or reason is one. */
function isTimeout(error: object, name: string | undefined): boolean {
  if (name !== undefined && TIMEOUT_ERROR_NAMES.has(name)) return true;
  if (name !== 'AbortError') return false;
  const cause = stringField((error as { readonly cause?: unknown }).cause, 'name');
  return cause !== undefined && TIMEOUT_ERROR_NAMES.has(cause);
}

/**
 * The transience a failure's structure fixes on its own, or undefined when
 * only its wording can say. This is the one owner of "can this failure be
 * retried": `GoodVibesError` derives its default `recoverable` from it, and an
 * explicit `recoverable` or `retryable` is honoured first. Order: that stated
 * value; an explicit Retry-After (a server naming when to come back, which
 * also covers a 403 secondary rate limit); the HTTP status against the
 * transient-status table; a connection-failure code (on the error or its
 * cause); a timeout class; an abort that is not a timeout, which is a
 * cancellation and terminal; the error's own category.
 */
export function structuredTransience(error: unknown): FailureTransience | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const stated = statedRetryable(error);
  if (stated !== undefined) {
    return { failureClass: stated ? 'retryable' : 'terminal', basis: 'explicit', detail: `the error states it is ${stated ? '' : 'not '}retryable` };
  }
  const retryAfterMs = numberField(error, 'retryAfterMs');
  if (retryAfterMs !== undefined && retryAfterMs >= 0) {
    return { failureClass: 'retryable', basis: 'retry-after', detail: `server asked for a retry after ${retryAfterMs}ms` };
  }
  const status = httpStatusOf(error);
  if (status !== undefined) {
    const failureClass = TRANSIENT_STATUSES.has(status) ? 'retryable' : 'terminal';
    return { failureClass, basis: 'status', detail: `HTTP ${status}` };
  }
  const cause = (error as { readonly cause?: unknown }).cause;
  for (const code of [stringField(error, 'code'), stringField(cause, 'code')]) {
    const category = categoryForCode(code);
    if (category !== undefined) return { failureClass: 'retryable', basis: 'errno', detail: `${code} (${category})` };
  }
  const name = stringField(error, 'name');
  if (isTimeout(error, name)) return { failureClass: 'retryable', basis: 'error-type', detail: name! };
  if (name === 'AbortError') return { failureClass: 'terminal', basis: 'cancelled', detail: 'the operation was cancelled' };
  const category = stringField(error, 'category');
  if (category !== undefined && TRANSIENT_CATEGORIES.has(category as FailureCategory)) {
    return { failureClass: 'retryable', basis: 'explicit', detail: `category ${category}` };
  }
  if (category !== undefined && PERMANENT_OWN_CATEGORIES.has(category)) {
    return { failureClass: 'terminal', basis: 'explicit', detail: `category ${category}` };
  }
  return undefined;
}

/** What structure alone says about a failure: its category, whether a retry can clear it, and any wait the server named. */
export interface FailureClassification {
  readonly category: DaemonErrorCategory;
  readonly retryable: boolean;
  readonly retryAfterMs?: number | undefined;
}

const WIRE_CATEGORIES: ReadonlySet<string> = new Set(Object.values(DaemonErrorCategory));
const RETRYABLE_CATEGORIES: ReadonlySet<DaemonErrorCategory> = new Set(['rate_limit', 'timeout', 'network', 'service', 'protocol']);

/**
 * Classifies a failure from its fields and the status, errno and error-class
 * tables, with no model and no I/O; undefined when the failure carries none
 * of them (no category, status, Retry-After, errno code or timeout class), the
 * one case where its wording is all there is to read. Category: the error's
 * own category, then its HTTP status, then a connection code on it or its cause,
 * then a timeout class; a status outside the status table, and a
 * cancellation, are `unknown`. Retryable: {@link structuredTransience} (a
 * stated `retryable` or `recoverable`, a Retry-After, the transient-status
 * table, a connection code, a timeout class, a cancellation), then the
 * category.
 */
export function classifyFailure(error: unknown): FailureClassification | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const explicit = stringField(error, 'category');
  const ownCategory = explicit !== undefined && explicit !== 'unknown' && WIRE_CATEGORIES.has(explicit) ? explicit as DaemonErrorCategory : undefined;
  const status = httpStatusOf(error);
  const delay = numberField(error, 'retryAfterMs');
  const retryAfterMs = delay !== undefined && delay >= 0 ? delay : undefined;
  const cause = (error as { readonly cause?: unknown }).cause;
  const errnoCategory = categoryForCode(stringField(error, 'code')) ?? categoryForCode(stringField(cause, 'code'));
  const name = stringField(error, 'name');
  const cancelled = name === 'AbortError' && !isTimeout(error, name);
  const category = ownCategory
    ?? categoryForStatus(status)
    ?? errnoCategory
    ?? (isTimeout(error, name) ? 'timeout' : undefined)
    ?? (status !== undefined || retryAfterMs !== undefined || cancelled ? 'unknown' : undefined);
  if (category === undefined) return undefined;
  const decided = structuredTransience(error);
  const retryable = decided !== undefined ? decided.failureClass === 'retryable' : RETRYABLE_CATEGORIES.has(category);
  return retryAfterMs === undefined ? { category, retryable } : { category, retryable, retryAfterMs };
}

function describeFallback(error: unknown): string {
  const message = stringField(error, 'message');
  if (message !== undefined) return message;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/** The wording a reading is given: the error's message, and its cause's when it has one. */
function failureWording(error: unknown, describe: (error: unknown) => string): FailureEvidence {
  if (error instanceof Error) {
    const causeMessage = error.cause instanceof Error ? error.cause.message : stringField(error.cause, 'message');
    const message = causeMessage !== undefined && causeMessage !== error.message
      ? `${error.message}\nCaused by: ${causeMessage}`
      : error.message;
    return { message, code: stringField(error, 'code') ?? stringField(error.cause, 'code'), errorName: error.name };
  }
  return { message: typeof error === 'string' ? error : describe(error) };
}

/**
 * Composes the failure reading into a transience decision. A spent account is
 * permanent even when it arrives as a rate limit; a transient network fault
 * is worth another attempt; otherwise the category decides. A reading that
 * settles nothing is retried: each caller's attempt budget bounds it and the
 * failure stays observable, where a give-up would drop it silently.
 */
export function transienceFromReading(failure: FailureConclusions): FailureTransience {
  const basis = failure.source === 'classic' ? 'classic' : 'reading';
  const categoryDetail = failure.source === 'classic' ? `structured category ${failure.category}` : `read as ${failure.category}`;
  if (failure.billing) return { failureClass: 'terminal', basis, detail: 'the account cannot pay for the request' };
  if (failure.transientNetwork) return { failureClass: 'retryable', basis, detail: 'a transient network fault' };
  if (PERMANENT_CATEGORIES.has(failure.category)) return { failureClass: 'terminal', basis, detail: categoryDetail };
  if (TRANSIENT_CATEGORIES.has(failure.category)) return { failureClass: 'retryable', basis, detail: categoryDetail };
  if (failure.rateLimited) return { failureClass: 'retryable', basis, detail: 'a rate limit' };
  return { failureClass: 'retryable', basis, detail: failure.source === 'classic' ? 'no structured failure category; use the existing bounded retry policy' : 'the wording does not settle it' };
}

/**
 * Decides whether a failure is worth another attempt: structure first
 * ({@link structuredTransience}), then one Jev reading of the wording through
 * the engine failure battery (`readFailure`, memoized per wording). A
 * provider's retryable 429 is also read for billing when `fromProvider` is
 * set. A failure with no wording at all is retried, and so is one whose
 * wording cannot be read (no decision model, the model unreachable or
 * unsure): the caller's attempt budget bounds it, as it bounds a reading that
 * settles nothing. Only the caller's own cancellation, retirement or guard
 * refusal is thrown.
 */
export async function readFailureTransience(error: unknown, site: string, options: TransienceOptions = {}): Promise<FailureTransience> {
  const signal = options.reading?.signal;
  signal?.throwIfAborted();
  const guard = options.reading?.beforeAttempt;
  // The caller's guard runs once per model attempt inside the reading; a
  // refusal from it (or an asynchronous guard, which the reading refuses) is
  // the caller's, so it is told apart from a reading that could not be made.
  let refusedByCaller = false;
  const reading: FailureReadOptions | undefined = options.reading && guard
    ? { ...options.reading, beforeAttempt: () => {
      try {
        const checked: unknown = guard();
        if (checked !== undefined) refusedByCaller = true;
        return checked;
      } catch (refusal) { refusedByCaller = true; throw refusal; }
    } }
    : options.reading;
  const read = async (evidence: FailureEvidence): Promise<FailureConclusions | undefined> => {
    try { return await readFailure(evidence, site, reading); }
    catch (failure) {
      signal?.throwIfAborted();
      if (refusedByCaller || (reading !== undefined && failure instanceof JudgmentAuthorityRetiredError)) throw failure;
      return undefined;
    }
  };
  const describe = options.describe ?? describeFallback;
  const structured = structuredTransience(error);
  if (structured !== undefined) {
    const status = httpStatusOf(error);
    if (options.fromProvider !== true || status !== 429 || structured.failureClass !== 'retryable') return structured;
    const evidence = { ...failureWording(error, describe), status };
    if (evidence.message.trim().length === 0) return structured;
    const failure = await read(evidence);
    return failure?.billing === true
      ? { failureClass: 'terminal', basis: 'reading', detail: 'HTTP 429 read as billing: the account cannot pay for the request' }
      : structured;
  }
  const evidence = failureWording(error, describe);
  if (evidence.message.trim().length === 0) {
    return { failureClass: 'retryable', basis: 'no-wording', detail: 'the failure carries no wording' };
  }
  const failure = await read(evidence);
  if (failure === undefined) {
    return { failureClass: 'retryable', basis: 'reading', detail: 'the wording could not be read; retried within the attempt budget' };
  }
  return transienceFromReading(failure);
}
