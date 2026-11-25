/**
 * owner-approved-call.ts, the owner's approval of a call put to him standing
 * as his own act for that call's nested methods.
 *
 * An outside caller's call that `capabilities.run` put to the owner runs, once
 * he approves it, as the same caller (routes/capabilities.ts). That caller's
 * credential states no person, so a nested method that needs a person's
 * request (`confirmation: 'owner-request'`, control-plane/confirmation-gate.ts)
 * refused the call the owner had just approved. His approval is that request,
 * for that one call: the approved run is marked here, each nested method it
 * calls that needs it takes a one-use grant (capability-wiring.ts), and the
 * dispatch spends the grant on that one nested call (daemon/control-plane.ts),
 * where it keeps the person's claim the caller's credential could not make.
 * The mark ends with the run, so nothing after it takes a grant. Nothing here
 * can be named from outside the process: an invocation or a grant is an object
 * this module issued, never a value read from a request.
 *
 * The same grant carries the owner's approval of a model's call of an act that is his own (its program's gate put it
 * to him, gate/classify.ts): the nested method is admitted as the owner the model acts for, that one call.
 *
 * And it carries his authority when the caller is not the owner (an admin's sign-in, a paired device, a member) and
 * the act was his own (an effect only the owner causes): the run is marked with the owner's actor, and every nested
 * method of that one call is admitted as him, never as the caller, whose credential cannot make it.
 */
import type { Actor } from '@goodvibes/engine/daemon-api/http-policy';
import { effectFacts, type EffectId } from '../security/effect-authority.js';

type CoveredDescriptor = { readonly confirmation?: string | undefined; readonly effects?: readonly EffectId[] | undefined } | null | undefined;

/**
 * Whether a nested method is one the owner's approval stands in for: it needs a person's request
 * (`confirmation: 'owner-request'`), or it causes an effect that is the owner's own act (a model never causes it, or
 * only the owner does), which his yes to the call made his.
 */
export function ownerApprovalCovers(descriptor: CoveredDescriptor): boolean {
  if (!descriptor) return false;
  if (descriptor.confirmation === 'owner-request') return true;
  const effects = descriptor.effects ?? [];
  return effects.length > 0 && (effectFacts(effects).modelRefused || effectFacts(effects).ownerOnly);
}

/** A one-use grant: the nested call it is handed with is the owner's request, or made with his authority. */
export interface OwnerApprovedCallGrant {
  /** The approval the owner answered, named in what the nested call is admitted as. */
  readonly approvalId: string;
  /** The owner's actor, when the call's caller is not the owner and the act was his: the nested call is admitted as him. */
  readonly owner?: Actor | undefined;
  /** The nested method needs a person's request (or is the owner's own act): the claim is kept for it. */
  readonly personRequest: boolean;
}

interface ApprovedRun {
  readonly approvalId: string;
  readonly owner?: Actor | undefined;
}

/** Approved runs, by their invocation, until the run ends. */
const approvedRuns = new WeakMap<object, ApprovedRun>();
/** Grants issued and not spent yet. */
const grants = new WeakSet<OwnerApprovedCallGrant>();

/**
 * Mark the invocation an approved call runs under (approval `approvalId`). `owner`: the owner's actor, when the
 * caller is not the owner and the act was his own; every nested method of the run is then made with his authority.
 */
export function markOwnerApprovedRun(invocation: object, approvalId: string, owner?: Actor): void {
  approvedRuns.set(invocation, { approvalId, ...(owner ? { owner } : {}) });
}

/** The run is over: no nested call of it takes a grant after this. */
export function endOwnerApprovedRun(invocation: object): void {
  approvedRuns.delete(invocation);
}

/**
 * A one-use grant for one nested method of an approved run: every nested method when the run carries the owner's
 * authority, else one the approval stands in for (ownerApprovalCovers); none for any other run or after it ended.
 */
export function takeOwnerApprovalGrant(invocation: object, descriptor: CoveredDescriptor): OwnerApprovedCallGrant | undefined {
  const run = approvedRuns.get(invocation);
  if (run === undefined) return undefined;
  const covers = ownerApprovalCovers(descriptor);
  if (run.owner === undefined && !covers) return undefined;
  const grant: OwnerApprovedCallGrant = Object.freeze({ approvalId: run.approvalId, personRequest: covers, ...(run.owner ? { owner: run.owner } : {}) });
  grants.add(grant);
  return grant;
}

/** The grant when it was issued here and not spent; reading it spends it, so it stands for one call only. */
export function spendOwnerApprovalGrant(grant: unknown): OwnerApprovedCallGrant | undefined {
  if (grant === null || typeof grant !== 'object' || !grants.has(grant as OwnerApprovedCallGrant)) return undefined;
  grants.delete(grant as OwnerApprovedCallGrant);
  return grant as OwnerApprovedCallGrant;
}
