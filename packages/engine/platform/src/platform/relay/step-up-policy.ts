// relay/step-up-policy.ts
//
// A policy hook for requiring a recent WebAuthn (passkey) step-up assertion on
// state-changing operator calls that arrive over the relay. Reaching the daemon
// from outside the LAN is a higher-risk path than a call on the trusted LAN, so
// an operator can require that state-changing calls carry fresh proof of
// presence.
//
// This module holds the POLICY: which calls need an assertion (the scopes of the
// catalog method the call addresses, the HTTP verb only for a path no catalog
// method covers), and what a refused call is told (the reason and the one action
// that would get past it). The WebAuthn verification itself lives in
// relay/step-up-service.ts (the credential and challenge stores) and
// relay/step-up-webauthn.ts (the signature check); relay/daemon-wiring.ts always
// installs that verifier in front of the relay dispatch. A gated call is allowed
// only when the verifier genuinely confirmed a fresh assertion.

import type { StepUpVerifyFailure } from './step-up-webauthn.js';

/** Header carrying an opaque WebAuthn step-up assertion on a tunneled request. */
export const STEP_UP_ASSERTION_HEADER = 'x-goodvibes-stepup-assertion';

/** The request a step-up assertion is presented for. */
export interface StepUpRequestContext {
  readonly method: string;
  readonly path: string;
  /** The session the request addresses, when its path names one. */
  readonly sessionId?: string | undefined;
  /** The daemon's relay rendezvous the request arrived through, when known. */
  readonly rendezvousId?: string | undefined;
  /** Who the request authenticates as; a challenge is accepted only from the principal that minted it. */
  readonly principalId?: string | undefined;
}

/** Why a step-up assertion was not accepted. */
export type StepUpRefusalReason =
  | 'assertion-missing'
  | 'no-credential'
  | 'unknown-challenge'
  | 'challenge-expired'
  | 'challenge-consumed'
  | 'challenge-unbound'
  | StepUpVerifyFailure;

/**
 * The one action that gets a refused call through, for a client to branch on:
 * `sign` mint a challenge for this call and sign it; `mint-again` the challenge
 * cannot be used, mint a new one for this call; `re-sign` the signature did not
 * verify, sign again; `register-locally` no passkey this call could use is
 * registered, and registering one needs a direct (same-network) connection.
 */
export type StepUpNextAction = 'sign' | 'mint-again' | 're-sign' | 'register-locally';

/** What the verifier concluded about one presented (or absent) assertion. */
export type StepUpVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: StepUpRefusalReason };

/**
 * Verifies a step-up assertion (StepUpService.createVerifier is the daemon's
 * implementation). `assertion` is null when the request carried none; the
 * verifier then says whether any passkey is registered at all. `context` is the
 * request the assertion is presented for: a challenge is accepted only for the
 * method, path and principal it was minted for (and the session or rendezvous,
 * when it names one).
 */
export type StepUpAssertionVerifier = (
  assertion: string | null,
  context: StepUpRequestContext,
) => Promise<StepUpVerification>;

/** The outcome of a step-up policy evaluation. */
export type StepUpDecision =
  | { readonly allow: true }
  | {
    readonly allow: false;
    readonly code: 'STEP_UP_REQUIRED';
    readonly reason: StepUpRefusalReason;
    readonly action: StepUpNextAction;
    /** Why the call was refused, in product terms. */
    readonly message: string;
    /** What to do instead, most useful first. */
    readonly next: readonly string[];
  };

/** Inputs to a step-up evaluation, all already-resolved facts, so this is pure. */
export interface StepUpEvaluationInput {
  /** Did the request arrive over the relay (vs the trusted LAN)? */
  readonly viaRelay: boolean;
  /** Does the call change state (its catalog method carries a non-read scope)? */
  readonly mutating: boolean;
  /** Is the step-up requirement switched on? */
  readonly requireStepUp: boolean;
  /** What the verifier concluded about the assertion the request carried. */
  readonly verification: StepUpVerification;
}

/** HTTP methods that do not change state. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Whether an HTTP method is mutating. Used only for a path no catalog method
 * covers; a cataloged call is judged by its scopes ({@link callNeedsStepUp}).
 */
export function isMutatingMethod(method: string): boolean {
  return !READ_METHODS.has(method.toUpperCase());
}

/** What the catalog says about the method a relayed call addresses. */
export interface RelayMethodFacts {
  /**
   * The method's effect, derived from the effects it declares, the same fact
   * admission reads: anything but `read` changes state or sends outward.
   * Absent for a plugin's method, which declares access and scopes instead.
   */
  readonly effect?: 'read' | 'write' | 'outward' | undefined;
  readonly scopes: readonly string[];
}

/**
 * Whether a call changes state. The catalog method's effect decides, so a
 * read invoked by POST is not gated and a write or an outward send is,
 * whatever scopes it names. A method with no effect (a plugin's) is judged by
 * its scopes (`read:*` only means it does not change state); a call with no
 * catalog method, or one whose method declares neither, by its HTTP verb.
 */
export function callNeedsStepUp(method: RelayMethodFacts | null, httpMethod: string): boolean {
  if (method?.effect !== undefined) return method.effect !== 'read';
  if (method && method.scopes.length > 0) return method.scopes.some((scope) => !scope.startsWith('read:'));
  return isMutatingMethod(httpMethod);
}

/** The action that gets past each refusal. */
export function stepUpNextAction(reason: StepUpRefusalReason): StepUpNextAction {
  switch (reason) {
    case 'assertion-missing':
      return 'sign';
    case 'no-credential':
      return 'register-locally';
    case 'unknown-challenge':
    case 'challenge-expired':
    case 'challenge-consumed':
    // A challenge minted for another call can never match this one; signing it again cannot help.
    case 'challenge-unbound':
      return 'mint-again';
    default:
      return 're-sign';
  }
}

const REASON_TEXT: Readonly<Record<StepUpRefusalReason, string>> = {
  'assertion-missing': 'This call arrived over the relay and changes state, so it needs a fresh passkey confirmation, and it carried none.',
  'no-credential': 'This call needs a passkey confirmation, and no passkey that could sign it is registered with the daemon.',
  'unknown-challenge': 'The passkey confirmation signed a challenge the daemon did not issue or no longer holds.',
  'challenge-expired': 'The passkey confirmation signed a challenge that expired before the call arrived.',
  'challenge-consumed': 'The passkey confirmation was already used for another call; each one is good for one call.',
  'challenge-unbound': 'The passkey confirmation was minted for a different call, path or caller than this one.',
  'malformed-envelope': 'The passkey confirmation header could not be read.',
  'malformed-client-data': 'The passkey confirmation carried client data that could not be read.',
  'wrong-type': 'The passkey response was not an assertion (webauthn.get).',
  'challenge-mismatch': 'The passkey confirmation signed a different challenge than the one it names.',
  'origin-not-allowed': 'The passkey confirmation came from a web origin the registered passkey is not allowed for.',
  'rpid-mismatch': 'The passkey confirmation was made for a different relying party than the registered passkey.',
  'user-presence-missing': 'The passkey confirmation did not show a person present at the device.',
  'user-verification-missing': 'The passkey confirmation was not user-verified (PIN or biometric), which this daemon requires.',
  'bad-public-key': 'The registered passkey\'s public key could not be used to check the confirmation.',
  'bad-signature': 'The passkey confirmation\'s signature could not be read.',
  'signature-invalid': 'The passkey confirmation\'s signature did not verify.',
  'sign-count-regression': 'The passkey\'s signature counter went backwards, which is the mark of a cloned authenticator.',
};

const NEXT_TEXT: Readonly<Record<StepUpNextAction, string>> = {
  sign: 'Mint a challenge for this call (stepup.challenge.mint with its method and path), sign it with a registered passkey, and send the call again with the x-goodvibes-stepup-assertion header.',
  'mint-again': 'Mint a new challenge for this call (stepup.challenge.mint with its method and path), sign it, and send the call again.',
  're-sign': 'Sign the challenge again with a passkey registered on this daemon, from an allowed origin, and send the call again.',
  'register-locally': 'Register a passkey while connected directly to the daemon (same network), then try again; or turn relay.requireStepUpForMutations off from there.',
};

/** The reason sentence and next step a refused call is answered with. */
export function describeStepUpRefusal(reason: StepUpRefusalReason): { readonly action: StepUpNextAction; readonly message: string; readonly next: readonly string[] } {
  const action = stepUpNextAction(reason);
  return { action, message: REASON_TEXT[reason], next: [NEXT_TEXT[action]] };
}

/**
 * Decide whether a request may proceed. The control only bites on state-changing
 * relay calls when the requirement is enabled; every other request is allowed
 * unchanged. When it does bite, it fails closed unless the verifier genuinely
 * confirmed a fresh assertion, and the refusal names the reason and the action.
 */
export function evaluateStepUp(input: StepUpEvaluationInput): StepUpDecision {
  if (!input.viaRelay || !input.mutating || !input.requireStepUp) return { allow: true };
  if (input.verification.ok) return { allow: true };
  const reason = input.verification.reason;
  return { allow: false, code: 'STEP_UP_REQUIRED', reason, ...describeStepUpRefusal(reason) };
}
