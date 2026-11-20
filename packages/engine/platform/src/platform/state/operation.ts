/**
 * Operation identity, the durable acknowledgement and the one failure classifier.
 *
 * The rule these types carry: nothing tells a person, a client or an agent
 * "accepted", "saved", "delivered" or "done" until a record of it is on disk;
 * every effect outside the process carries one identity for all its attempts;
 * and a call whose result cannot be known is reported `unknown`, never as
 * success or failure.
 *
 * - {@link OperationId}: one accepted operation. The caller's key when it sent
 *   one ({@link operationIdFromClient}), else minted once at accept
 *   ({@link newOperationId}). Never one per attempt.
 * - {@link EffectKey}: one external effect of an operation, what is sent as an
 *   Idempotency-Key, nonce, UID, Message-ID or provider message id. Derived
 *   from the operation ({@link effectKey}), so every retry sends the same one.
 * - {@link Durable}: a record that is on disk. Only {@link durableAfter} makes
 *   one, and it resolves only after the sync it is handed; a route or adapter
 *   that acknowledges takes a `Durable<...>` argument, so acknowledging before
 *   the save does not compile.
 * - {@link outcomeOfFailure}: the only translation from a thrown error to an
 *   outcome for an outward call, by where the call stood when it failed.
 *
 * Cost per request: none of these does I/O. `durableAfter` waits for a sync the
 * caller already started; it adds no write and no fsync.
 */
import { failedOutcome, httpStatusOf, isOperationKey, OPERATION_KEY_RULE, refusal, RefusalError, toRefusal, unknownOutcome, type EffectOutcome } from '@goodvibes-jev/engine/errors';

declare const opBrand: unique symbol;
declare const effectBrand: unique symbol;
declare const durableBrand: unique symbol;

/** One accepted operation. The caller's key when it sent one, else minted once at accept. Never per attempt. */
export type OperationId = string & { readonly [opBrand]: true };
/** One external effect of an operation: what is sent as Idempotency-Key, nonce, UID, Message-ID or provider message id. */
export type EffectKey = string & { readonly [effectBrand]: true };
/** A record that is on disk. Made only by {@link durableAfter}, after the sync it was handed resolved. */
export type Durable<R> = R & { readonly [durableBrand]: true };

/** The client's key as an operation id. Throws a 400 `INVALID_ARGUMENT` refusal for a key outside the one rule (`isOperationKey`: `[A-Za-z0-9._:-]{1,255}`). */
export function operationIdFromClient(key: string): OperationId {
  if (!isOperationKey(key)) {
    throw new RefusalError(refusal({
      code: 'INVALID_ARGUMENT',
      status: 400,
      state: 'nothing was accepted',
      reason: `The operation key must be ${OPERATION_KEY_RULE}.`,
      next: ['Send the request again with a key of that form, and use the same key for every retry of it'],
      retryable: false,
    }));
  }
  return key as OperationId;
}

/** A new operation id, `<kind>-<uuidv7>`: minted once when the operation is accepted, then kept for every attempt. */
export function newOperationId(kind: string): OperationId {
  return `${kind}-${Bun.randomUUIDv7()}` as OperationId;
}

/** The identity of one effect of an operation, `<op>/<part>`: the same for every attempt of that part. */
export function effectKey(op: OperationId, part: string | number): EffectKey {
  return `${op}/${part}` as EffectKey;
}

/**
 * `record` as {@link Durable}, once `synced` resolved. `synced` is the sync of
 * the write that holds the record (a record log's `flush()`, a store's durable
 * persist); a rejected sync rejects here, and nothing durable is made.
 */
export async function durableAfter<R>(record: R, synced: Promise<unknown>): Promise<Durable<R>> {
  await synced;
  return record as Durable<R>;
}

/** Where a failed call stood when it failed. */
export type DispatchPhase = 'before-send' | 'sent';

/** HTTP answers to a sent request that do not settle whether it took effect: a timeout, a conflict, too early, too many. */
const UNSETTLED_CLIENT_STATUSES: ReadonlySet<number> = new Set([408, 409, 425, 429]);

/**
 * The only translation from a thrown error to an outcome for an outward call.
 *
 * - `before-send` (a DNS failure, a refused connection, a refusal raised by our
 *   own checks, an abort before the request was handed to the network):
 *   `failed`, nothing was applied.
 * - `sent`: an HTTP 4xx answer other than 408, 409, 425 and 429, carried on the
 *   error as `status` (the far side read the request and refused it): `failed`.
 *   Anything else (a timeout or abort after dispatch, a reset socket, a 5xx, a
 *   408 or 429, a 2xx whose body could not be read or validated, an error with
 *   no status): `unknown`, carrying `effect` so a retry reuses it, and the
 *   `readBack` step (the command or method that reads the far side's state)
 *   as the first next step.
 */
export function outcomeOfFailure(
  error: unknown,
  phase: DispatchPhase,
  effect: EffectKey | undefined,
  readBack: string,
): EffectOutcome<never> {
  if (phase === 'before-send') {
    return failedOutcome(toRefusal(error, {
      code: 'NOT_SENT',
      state: 'the request was not sent; nothing was applied',
      next: ['Send it again once the cause is fixed'],
    }));
  }
  const status = httpStatusOf(error);
  if (status !== undefined && status >= 400 && status < 500 && !UNSETTLED_CLIENT_STATUSES.has(status)) {
    return failedOutcome(toRefusal(error, {
      code: 'REFUSED_BY_RECIPIENT',
      state: 'the request was refused by the far side; nothing was applied',
      next: ['Correct what the far side refused, then send it again'],
    }));
  }
  const carried = toRefusal(error, { state: '', next: [] });
  const next = [readBack, ...(effect !== undefined ? [`Send it again only with the same key (${effect}), so a repeat is dropped`] : ['Do not send it again until the read-back shows it did not happen'])];
  return unknownOutcome(refusal({
    code: 'OUTCOME_UNKNOWN',
    state: 'the request was sent; whether it took effect is not known',
    reason: carried.reason,
    next,
    retryable: false,
  }), effect);
}
