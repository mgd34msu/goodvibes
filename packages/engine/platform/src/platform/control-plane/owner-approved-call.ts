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
import type { SettingAct } from '@goodvibes/engine/daemon-api/control-routes';
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

/**
 * A mark a capability's own nested method call carries (daemon/capability-wiring.ts): the capability that runs it was
 * decided already, by `capabilities.run` (its admission, and the owner's gate for a caller who needed it), so the
 * dispatch does not decide the method's risk class again (daemon/method-owner-decision.ts). Issued only here, kept in
 * process: no value read from a request is one.
 */
const decidedMarks = new WeakSet<object>();
/** Who made the decided capability's act and how it was decided, carried by its nested call's mark. */
const markActs = new WeakMap<object, SettingAct>();
/** Who made each capability run's act and how it was decided (routes/capabilities.ts), by the run's invocation. */
const runActs = new WeakMap<object, SettingAct>();

/** Record who made a capability run's act and how it was decided, for the methods it calls (a settings write keeps it). */
export function markRunAct(invocation: object, act: SettingAct): void {
  runActs.set(invocation, act);
}

/** The act recorded for a capability run, or undefined. */
export function runActOf(invocation: object): SettingAct | undefined {
  return runActs.get(invocation);
}

/** The owner-decision classes a capability run's own decision covered (routes/capabilities.ts), by the run's invocation. */
const runCovers = new WeakMap<object, ReadonlySet<string>>();
/** The classes each mark's decision covered. */
const markCovers = new WeakMap<object, ReadonlySet<string>>();

/**
 * Record the owner-decision classes a capability run's own decision covered (its risk, a secret it writes, an act of
 * the owner's...): a method it calls of a class outside them was not decided by it (method-owner-decision.ts).
 */
export function markRunCovers(invocation: object, classes: ReadonlySet<string>): void {
  runCovers.set(invocation, classes);
}

/** The classes recorded for a capability run, or undefined. */
export function runCoversOf(invocation: object): ReadonlySet<string> | undefined {
  return runCovers.get(invocation);
}

export function capabilityDecidedMark(act?: SettingAct, covers?: ReadonlySet<string>): object {
  const mark = Object.freeze({});
  decidedMarks.add(mark);
  if (act) markActs.set(mark, act);
  if (covers) markCovers.set(mark, covers);
  return mark;
}

/** The classes a decided mark's decision covered (read before the mark is spent), or undefined when none were recorded. */
export function decidedMarkCovers(mark: unknown): ReadonlySet<string> | undefined {
  return mark !== null && typeof mark === 'object' && decidedMarks.has(mark) ? markCovers.get(mark) : undefined;
}

/** The act a decided mark carries (read before the mark is spent), or undefined. */
export function decidedMarkAct(mark: unknown): SettingAct | undefined {
  return mark !== null && typeof mark === 'object' && decidedMarks.has(mark) ? markActs.get(mark) : undefined;
}

/** Whether `mark` is one this module issued and not spent yet; reading it spends it. */
export function spendCapabilityDecidedMark(mark: unknown): boolean {
  if (mark === null || typeof mark !== 'object' || !decidedMarks.has(mark)) return false;
  decidedMarks.delete(mark);
  return true;
}

/** The grant when it was issued here and not spent; reading it spends it, so it stands for one call only. */
export function spendOwnerApprovalGrant(grant: unknown): OwnerApprovedCallGrant | undefined {
  if (grant === null || typeof grant !== 'object' || !grants.has(grant as OwnerApprovedCallGrant)) return undefined;
  grants.delete(grant as OwnerApprovedCallGrant);
  return grant as OwnerApprovedCallGrant;
}
