import { RefusalError, refusal } from '@goodvibes/engine/errors';

/**
 * gateway-verb-error.ts
 *
 * (fleet.*, checkpoints.*, sessions.search, see CHANGELOG 1.0.0): a structured error for
 * gateway methods registered with a direct handler via
 * `GatewayMethodCatalog.register(descriptor, handler)`.
 *
 * WHY THIS EXISTS: `invokeGatewayMethodCall` (../../daemon/control-plane.ts)
 * dispatches a handler-bearing method via `catalog.invoke()` and, on ANY
 * thrown error, collapses it to a blanket `{ status: 500 }`, there was no
 * prior handler-registered verb that needed an honest non-500 status (the
 * only prior consumer of `register(descriptor, handler)` is the plugin API,
 * whose tool-call errors are swallowed into a `{success:false}` payload, not
 * an HTTP status). checkpoints.diff/restore need an honest 404 for an
 * unknown/gc'd checkpoint id (see routes/checkpoints.ts), and invalid
 * pagination cursors need an honest 400 (fleet.list, sessions.search), a
 * blanket 500 would misreport caller error as server error.
 *
 * This mirrors the existing `EngineErrorCodes.SESSION_CLOSED` convention used by
 * the plain-REST session routes (`callOrSessionClosed`,
 * ../../../daemon-api/src/runtime-session-routes.ts), generalized to any
 * status/code pair instead of one hardcoded to 409/SESSION_CLOSED.
 *
 * It is a `RefusalError`: the one class every route refusal is, so a refusal
 * can say what is true now (`state`) and what to do (`next`), and the
 * dispatcher forwards both on the wire.
 */
export interface GatewayVerbRefusalDetail {
  /** What is true now, in product terms. */
  readonly state?: string | undefined;
  /** Steps that would get past the refusal, most useful first. */
  readonly next?: readonly string[] | undefined;
}

export class GatewayVerbError extends RefusalError {
  declare readonly code: string;
  declare readonly status: number;
  /**
   * Which input field the refusal is ABOUT, as a machine-readable name rather
   * than prose buried in `message`.
   *
   * This exists for one gate, and the gate is the reason to keep populating it.
   * A verb's method-catalog descriptor declares an `inputSchema.required` array;
   * that array is what consumers compile against and what
   * `invoke-input-validation.ts` enforces before dispatch. A handler that
   * refuses a call because `authority` is absent, on a descriptor that never
   * listed `authority` as required, type-checks in every consumer and 400s at
   * runtime, the class of defect that has now been found three separate times
   * in this control plane.
   *
   * `test/gateway-verb-required-conformance.test.ts` catches it by INVOKING
   * every handler-registered verb with the fields its descriptor declares
   * required, and asserting that the handler does not then demand something
   * else. To do that it has to know WHICH field a refusal names, and the one
   * thing it must never do is guess from the message text: the messages are
   * deliberately human prose ("Invalid permission mode: (expected one of …)")
   * and parsing them yields the wrong property, which is a gate that reports
   * green while checking something other than what it claims.
   *
   * So the contract is: a refusal that is ABOUT a named input field sets
   * `field`, and the conformance test FAILS on an input-shaped refusal that
   * does not, an unattributable refusal is treated as an unchecked verb, not
   * as a pass.
   *
   * Use the input field's own name as the caller spells it (`sessionId`,
   * `uid`, `mode`), dotted for a nested one (`notifications.keys`).
   */
  readonly field: string | undefined;

  constructor(message: string, code: string, status: number, field?: string, detail: GatewayVerbRefusalDetail = {}) {
    super(refusal({
      code,
      reason: message,
      // An empty state takes the refusal's own default.
      state: detail.state ?? '',
      ...(detail.next !== undefined ? { next: detail.next } : {}),
      status,
    }));
    this.name = 'GatewayVerbError';
    this.code = code;
    this.status = status;
    this.field = field;
  }
}

export function isGatewayVerbError(error: unknown): error is GatewayVerbError {
  return error instanceof GatewayVerbError;
}

/** A handler's refusal, read off whatever class the handler threw. */
export interface GatewayVerbRefusal {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  /** The input field the refusal is about, when it names one. */
  readonly field: string | undefined;
}

/**
 * Read a refusal from a thrown value by SHAPE rather than by class.
 *
 * `instanceof GatewayVerbError` only recognizes refusals thrown by handlers
 * compiled against this module. A handler registered by a consuming runtime,
 * the daemon product registers its own, and its confirmation gate refuses with
 * a 403 the caller is meant to act on, throws its own error class carrying the
 * same two facts. Recognized only by class, every one of those reached the
 * client as a blanket 500, so a refusal a caller could answer read as a daemon
 * fault.
 *
 * The shape is deliberately narrow: an integer HTTP error status and a
 * machine code in the platform's own spelling (upper snake case, like
 * `CONFIRMATION_REQUIRED`). Both together are a statement that the thrower meant this
 * to be a wire refusal; a plain `Error` carries neither and still collapses to
 * 500. An upstream HTTP or provider error also carries a status and a code, but
 * spells it `invalid_api_key` or `card_declined`; forwarding that would turn a
 * provider's 401 into this daemon's own authentication failure and echo the
 * provider's text to the caller, so it stays a 500.
 */
const WIRE_REFUSAL_CODE = /^[A-Z][A-Z0-9_]*$/;

export function readGatewayVerbRefusal(error: unknown): GatewayVerbRefusal | null {
  if (isGatewayVerbError(error)) {
    return { status: error.status, code: error.code, message: error.message, field: error.field };
  }
  if (!error || typeof error !== 'object') return null;
  const candidate = error as { status?: unknown; code?: unknown; message?: unknown; field?: unknown };
  if (typeof candidate.status !== 'number' || !Number.isInteger(candidate.status)) return null;
  if (candidate.status < 400 || candidate.status > 599) return null;
  const code = typeof candidate.code === 'string' ? candidate.code.trim() : '';
  if (!WIRE_REFUSAL_CODE.test(code)) return null;
  const message = typeof candidate.message === 'string' && candidate.message.trim()
    ? candidate.message.trim()
    : `The handler refused this call: ${code}`;
  return {
    status: candidate.status,
    code,
    message,
    field: typeof candidate.field === 'string' && candidate.field.trim() ? candidate.field.trim() : undefined,
  };
}

/**
 * Rethrow the refusal a handler raised AFTER its effect was already committed,
 * saying so. A bare "forbidden" there reads as "nothing happened", and a caller
 * that retries on that reading repeats work that is already done. Anything that
 * is not a refusal passes through unchanged.
 */
export function withholdCommittedResult(error: unknown, committed: string): never {
  if (!(error instanceof GatewayVerbError)) throw error;
  throw new GatewayVerbError(
    `${committed} Access changed before the reply could be returned, so the result is withheld. Read the current state before retrying; do not repeat the request blindly. ${error.message}`,
    error.code,
    error.status,
    error.field,
    { state: committed, next: ['Read the current state before retrying.', ...error.refusal.next] },
  );
}
