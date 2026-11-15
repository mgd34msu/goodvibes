import type { StructuredDaemonErrorBody } from './daemon-error-contract.js';
import { categoryForStatus } from './failure-reading.js';
import { classifyFailure, TRANSIENT_STATUS_CODES } from './failure-transience.js';

/**
 * One shape for "this did not happen": what state things are in, why, and what
 * to do next. The daemon wire body carries the same fields (`state`, `next`;
 * `hint` is `next[0]`), a tool result carries them as its decision, and a
 * command result carries one when it is not ok, so a person reads the same
 * three things on every surface and an agent can act on `next` without
 * parsing prose.
 */
export interface Refusal {
  /** Stable machine code to branch on (an `EngineErrorCode` or a route's own code). */
  readonly code: string;
  /** What is true now, in product terms: "the session is closed", "no daemon is running". */
  readonly state: string;
  /** Why the request was not carried out. */
  readonly reason: string;
  /** Steps that would get past it, most useful first; empty only when nothing would. */
  readonly next: readonly string[];
  /** Whether sending the same request again later can succeed. */
  readonly retryable: boolean;
  readonly retryAfterMs?: number | undefined;
  /** The HTTP status the refusal is answered with on the wire. */
  readonly status?: number | undefined;
}

/** What a slash command or CLI command returns: lines to show, or a refusal. */
export type CommandResult =
  | { readonly ok: true; readonly lines: readonly string[] }
  | { readonly ok: false; readonly refusal: Refusal };

export interface RefusalInit {
  readonly code: string;
  readonly state: string;
  readonly reason: string;
  readonly next?: readonly string[] | undefined;
  readonly retryable?: boolean | undefined;
  readonly retryAfterMs?: number | undefined;
  readonly status?: number | undefined;
}

const MAX_NEXT_STEPS = 8;

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** The non-empty strings of a `next` list, at most eight; undefined when the value is not a list. */
export function readNextSteps(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const steps: string[] = [];
  for (const entry of value as readonly unknown[]) {
    const step = text(entry);
    if (step !== undefined) steps.push(step);
    if (steps.length === MAX_NEXT_STEPS) break;
  }
  return steps;
}

function validStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

function validDelay(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Builds a frozen {@link Refusal}; `retryable` defaults to a Retry-After or a transient status (`TRANSIENT_STATUS_CODES`), otherwise false. */
export function refusal(init: RefusalInit): Refusal {
  const status = validStatus(init.status);
  const retryAfterMs = validDelay(init.retryAfterMs);
  const retryable = init.retryable
    ?? (retryAfterMs !== undefined || (status !== undefined && TRANSIENT_STATUS_CODES.includes(status)));
  return Object.freeze({
    code: text(init.code) ?? 'REFUSED',
    state: text(init.state) ?? 'not done',
    reason: text(init.reason) ?? 'The request was refused.',
    next: Object.freeze([...(readNextSteps(init.next ?? []) ?? [])]),
    retryable,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(status !== undefined ? { status } : {}),
  });
}

export function isRefusal(value: unknown): value is Refusal {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.code === 'string'
    && typeof record.state === 'string'
    && typeof record.reason === 'string'
    && Array.isArray(record.next)
    && typeof record.retryable === 'boolean';
}

export function commandOk(...lines: readonly string[]): CommandResult {
  return { ok: true, lines: Object.freeze([...lines]) };
}

export function commandRefused(init: Refusal | RefusalInit): CommandResult {
  return { ok: false, refusal: isRefusal(init) ? init : refusal(init) };
}

/** The one line a terminal or log prints for a refusal: `reason. next`. */
export function formatRefusal(value: Refusal): string {
  let reason = value.reason.trimEnd();
  while (reason.endsWith('.')) reason = reason.slice(0, -1).trimEnd();
  const next = value.next[0];
  return next === undefined ? `${reason}.` : `${reason}. ${next}`;
}

/** The daemon wire body for a refusal; `hint` repeats `next[0]` for clients that only read `hint`. */
export function refusalErrorBody(value: Refusal): StructuredDaemonErrorBody {
  const category = categoryForStatus(value.status);
  return {
    error: value.reason,
    code: value.code,
    state: value.state,
    next: value.next,
    ...(value.next[0] !== undefined ? { hint: value.next[0] } : {}),
    ...(category !== undefined ? { category } : {}),
    recoverable: value.retryable,
    ...(value.status !== undefined ? { status: value.status } : {}),
    ...(value.retryAfterMs !== undefined ? { retryAfterMs: value.retryAfterMs } : {}),
  };
}

/**
 * The refusal a failure carries, read from fields only: a `refusal` property
 * (`RefusalError`), or `state` and `next` on the error, or on the wire body an
 * `HttpStatusError` keeps. Undefined when the failure does not carry one; a
 * caller that must show one anyway uses {@link toRefusal}.
 */
export function readRefusal(error: unknown): Refusal | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const own = (error as { readonly refusal?: unknown }).refusal;
  if (isRefusal(own)) return own;
  const body = (error as { readonly body?: unknown }).body;
  for (const holder of [error, body]) {
    if (!holder || typeof holder !== 'object') continue;
    const record = holder as Record<string, unknown>;
    const state = text(record.state);
    const next = readNextSteps(record.next);
    if (state === undefined || next === undefined) continue;
    const classified = classifyFailure(error);
    return refusal({
      code: text((error as { readonly code?: unknown }).code) ?? text(record.code) ?? 'REFUSED',
      state,
      reason: text(record.error) ?? text(record.reason) ?? text((error as { readonly message?: unknown }).message) ?? 'The request was refused.',
      next,
      retryable: classified?.retryable ?? false,
      retryAfterMs: classified?.retryAfterMs,
      status: validStatus((error as { readonly status?: unknown }).status) ?? validStatus(record.status),
    });
  }
  return undefined;
}

/**
 * A refusal for any failure: the one it carries ({@link readRefusal}), or one
 * built from its fields with the caller's `state` and `next` for what the
 * error itself cannot know. Code decides `retryable` from status, errno and
 * category tables ({@link classifyFailure}); no model reads the wording.
 */
export function toRefusal(error: unknown, fallback: { readonly state: string; readonly next: readonly string[]; readonly code?: string | undefined }): Refusal {
  const carried = readRefusal(error);
  if (carried !== undefined) return carried;
  const classified = classifyFailure(error);
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : undefined;
  const reason = typeof error === 'string' ? text(error) : text(record?.message) ?? text(record?.error);
  return refusal({
    code: text(record?.code) ?? fallback.code ?? 'FAILED',
    state: fallback.state,
    reason: reason ?? 'The request failed.',
    next: fallback.next,
    retryable: classified?.retryable ?? false,
    retryAfterMs: classified?.retryAfterMs,
    status: validStatus(record?.status) ?? validStatus(record?.statusCode),
  });
}
