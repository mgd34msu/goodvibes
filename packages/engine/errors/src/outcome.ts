import type { Refusal } from './refusal.js';

/**
 * What a receipt and a combined result may say.
 *
 * A receipt says `done` only after something observed the effect: `done()`
 * takes an {@link Observation}, and only {@link observe} makes one, so a
 * receipt cannot claim `done` at dispatch without a visible cast (and `done()`
 * refuses an object that `observe` did not make). An effect that was sent but
 * not yet seen to finish is `pending` with the command or method that will
 * tell; one whose result cannot be known now is `unknown` (do not retry it
 * blindly); one that did not happen is `failed`. Every non-done state carries
 * the next step: `check` for `pending`, `Refusal.next` for the others.
 *
 * Combining per-item outcomes goes through {@link tally}, which keeps every
 * item: a failed or unknown item is listed with its refusal, never dropped.
 */

const observation: unique symbol = Symbol('goodvibes.observation');

/** Made only by {@link observe}; a receipt cannot be built as `done` from a dispatch. */
export interface Observation {
  readonly [observation]: true;
  /** What was looked at to see the effect, in product terms ("MERGE_HEAD gone and no unmerged paths"). */
  readonly how: string;
  /** When the effect was seen (milliseconds since the epoch). */
  readonly at: number;
}

export type EffectOutcome<T = void> =
  | { readonly state: 'done'; readonly value: T; readonly observed: Observation }
  /** Dispatched; not yet seen to finish. `check` is the command or method that will tell. */
  | { readonly state: 'pending'; readonly check: string; readonly since: number }
  /** Dispatched and cannot be known now ("outcome unknown"): do not retry blindly. */
  | {
    readonly state: 'unknown'; readonly refusal: Refusal;
    /** The effect's identity (Idempotency-Key, nonce, UID, Message-ID) when it had one: a retry reuses it, so the far side can drop a repeat. */
    readonly effect?: string;
  }
  | { readonly state: 'failed'; readonly refusal: Refusal };

/** The value and observation {@link observe} returns when its probe saw the effect. */
export interface Seen<T> {
  readonly value: T;
  readonly observed: Observation;
}

/**
 * Runs the probe; returns the value with an {@link Observation} only when the
 * probe saw the effect (returned a value other than `undefined`). A probe that
 * throws is not an observation: the error propagates to the caller, which
 * decides between `unknown` and `failed`.
 */
export async function observe<T>(
  how: string,
  probe: () => Promise<T | undefined> | T | undefined,
  now: () => number = Date.now,
): Promise<Seen<T> | undefined> {
  const value = await probe();
  if (value === undefined) return undefined;
  const observed: Observation = Object.freeze({ [observation]: true as const, how, at: now() });
  return Object.freeze({ value, observed });
}

/** Whether a value is an {@link Observation} made by {@link observe}. */
export function isObservation(value: unknown): value is Observation {
  return typeof value === 'object' && value !== null
    && (value as { readonly [observation]?: unknown })[observation] === true;
}

/** A `done` outcome from what {@link observe} saw. Throws on an observation `observe` did not make. */
export function done<T>(seen: Seen<T>): EffectOutcome<T> {
  if (!isObservation(seen.observed)) {
    throw new TypeError('done() needs an Observation made by observe(); a dispatch is not an observation.');
  }
  return Object.freeze({ state: 'done' as const, value: seen.value, observed: seen.observed });
}

/** Dispatched and not yet seen to finish; `check` names the command or method that will tell. */
export function pending(check: string, since: number): EffectOutcome<never> {
  return Object.freeze({ state: 'pending' as const, check, since });
}

/** Dispatched, and whether it took effect cannot be known now: do not retry blindly. `effect` is the key a retry must reuse. */
export function unknownOutcome(refusal: Refusal, effect?: string): EffectOutcome<never> {
  return Object.freeze({ state: 'unknown' as const, refusal, ...(effect !== undefined ? { effect } : {}) });
}

/** The effect did not happen. */
export function failedOutcome(refusal: Refusal): EffectOutcome<never> {
  return Object.freeze({ state: 'failed' as const, refusal });
}

/**
 * The one rule for a key a client sends to name one operation (the
 * `Idempotency-Key` header, `idempotencyKey`, `clientMessageId`, a session
 * message's `messageId`): 1 to 255 letters, digits, ".", "_", ":" or "-". Every
 * route that takes such a key, and `operationIdFromClient`, checks this one
 * pattern, so a key one route accepts is never refused by another it reaches.
 */
export const MAX_OPERATION_KEY_LENGTH = 255;
const OPERATION_KEY = /^[A-Za-z0-9._:-]{1,255}$/;
/** The rule in words, for refusals and method descriptions. */
export const OPERATION_KEY_RULE = '1 to 255 characters of letters, digits, ".", "_", ":" or "-"';
/** The JSON Schema of an operation key, for the operator contract. */
export const OPERATION_KEY_SCHEMA = Object.freeze({ type: 'string', minLength: 1, maxLength: MAX_OPERATION_KEY_LENGTH, pattern: '^[A-Za-z0-9._:-]+$' } as const);

/** Whether `value` is a usable operation key ({@link OPERATION_KEY_RULE}). */
export function isOperationKey(value: unknown): value is string {
  return typeof value === 'string' && OPERATION_KEY.test(value);
}

/** For a switch's default branch: a new state is a compile error at every switch. */
export function assertNeverOutcome(outcome: never): never {
  throw new TypeError(`Unhandled effect outcome: ${JSON.stringify(outcome)}`);
}

/** Folds per-item outcomes. Nothing is dropped: every failed or unknown id is listed with its refusal. */
export interface Tally<Id extends string = string> {
  /** What the caller asked for (0 means "nothing was selected"). */
  readonly requested: number;
  readonly done: readonly Id[];
  readonly pending: readonly Id[];
  readonly unknown: readonly { readonly id: Id; readonly refusal: Refusal }[];
  readonly failed: readonly { readonly id: Id; readonly refusal: Refusal }[];
  /**
   * `all-done` only when every requested item is done; `none-done` when
   * something was requested and nothing is done; `nothing-selected` when the
   * caller asked for nothing; `partial` otherwise (including requested items
   * that reported no outcome at all).
   */
  readonly state: 'all-done' | 'partial' | 'none-done' | 'nothing-selected';
}

export function tally<Id extends string>(
  requested: number,
  items: readonly { readonly id: Id; readonly outcome: EffectOutcome<unknown> }[],
): Tally<Id> {
  const doneIds: Id[] = [];
  const pendingIds: Id[] = [];
  const unknownItems: { readonly id: Id; readonly refusal: Refusal }[] = [];
  const failedItems: { readonly id: Id; readonly refusal: Refusal }[] = [];
  for (const { id, outcome } of items) {
    switch (outcome.state) {
      case 'done': doneIds.push(id); break;
      case 'pending': pendingIds.push(id); break;
      case 'unknown': unknownItems.push({ id, refusal: outcome.refusal }); break;
      case 'failed': failedItems.push({ id, refusal: outcome.refusal }); break;
      default: assertNeverOutcome(outcome);
    }
  }
  // An item reported beyond `requested` still counts as asked for: nothing is dropped.
  const asked = Math.max(requested, items.length);
  const state: Tally<Id>['state'] = asked === 0
    ? 'nothing-selected'
    : doneIds.length === asked
      ? 'all-done'
      : doneIds.length === 0
        ? 'none-done'
        : 'partial';
  return Object.freeze({
    requested: asked,
    done: Object.freeze(doneIds),
    pending: Object.freeze(pendingIds),
    unknown: Object.freeze(unknownItems),
    failed: Object.freeze(failedItems),
    state,
  });
}

/**
 * Exit code for `run`-class commands (docs/exit-codes.md): all done 0;
 * nothing selected 2 (usage); some items still pending or of unknown outcome
 * and none failed 3 (do not retry; inspect first); any other partial or
 * none-done batch 1 ("ran and did not succeed", with the per-item list).
 */
export function exitCodeOfTally(t: Tally): 0 | 1 | 2 | 3 {
  switch (t.state) {
    case 'all-done': return 0;
    case 'nothing-selected': return 2;
    case 'partial':
    case 'none-done': {
      const unaccounted = t.requested - t.done.length - t.pending.length - t.unknown.length - t.failed.length;
      if (t.failed.length === 0 && unaccounted === 0 && (t.unknown.length > 0 || t.pending.length > 0)) return 3;
      return 1;
    }
    default: return assertNeverOutcome(t.state);
  }
}
