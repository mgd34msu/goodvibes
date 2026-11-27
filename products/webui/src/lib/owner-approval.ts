/**
 * A setting or a session's mode changed from a token minted for automation
 * is not applied at once when the change loosens a security, permission,
 * judgment or payment setting: the daemon puts it to the owner as an approval
 * and answers 202 with `code: 'OWNER_APPROVAL_PENDING'` and the `approvalId`.
 *
 * The write wrappers (lib/goodvibes.ts) recognise that answer, record the
 * change here as pending and reject with {@link OwnerApprovalPendingError},
 * so no caller reports it as saved. {@link OwnerApprovalNotices} shows each
 * pending change, follows its approval until it settles, says the outcome,
 * and refreshes what the change touched. From the owner's own credential
 * (an owner device, a sign-in) the daemon applies the change directly and
 * none of this runs.
 *
 * Each change is held with the client lifetime (sign-in, daemon route) it was
 * raised under. When that lifetime ends (a sign-out, another sign-in, a relay
 * re-pairing) the change is settled as `left`: this tab can no longer follow it,
 * and the approval is still decided on the daemon that asked. It is never read
 * as cancelled through another identity or daemon.
 */
import { getClientLifetime, isClientLifetimeCurrent, subscribeClientLifetime, type ClientLifetime } from './client-lifetime';

/** The daemon's answer to a change it put to the owner. */
export interface OwnerApprovalPendingAnswer {
  readonly code: 'OWNER_APPROVAL_PENDING';
  readonly approvalId: string;
  /** False when this credential may not read the approval: the tab cannot follow it, so it shows no notice for it. */
  readonly followable?: boolean;
  readonly keys?: readonly string[];
  readonly sessionId?: string;
  readonly requestedMode?: string;
  readonly state?: string;
}

/**
 * A write's answer once it was applied: the pending answer is never returned
 * to a caller, because {@link acceptOwnerApprovalAnswer} rejects with it.
 */
export type AppliedAnswer<T> = Exclude<T, { readonly code: 'OWNER_APPROVAL_PENDING' }>;

export function isOwnerApprovalPending(value: unknown): value is OwnerApprovalPendingAnswer {
  return typeof value === 'object' && value !== null
    && (value as { code?: unknown }).code === 'OWNER_APPROVAL_PENDING'
    && typeof (value as { approvalId?: unknown }).approvalId === 'string';
}

/** What the change was, in words the notice shows. */
function describe(answer: OwnerApprovalPendingAnswer): string {
  if (answer.sessionId && answer.requestedMode) return `Setting this session to ${answer.requestedMode}`;
  if (answer.keys && answer.keys.length > 0) return `Changing ${answer.keys.join(', ')}`;
  return 'This change';
}

/** Rejected by a write the daemon put to the owner instead of applying it. */
export class OwnerApprovalPendingError extends Error {
  readonly approvalId: string;
  readonly answer: OwnerApprovalPendingAnswer;
  constructor(answer: OwnerApprovalPendingAnswer) {
    super(`${describe(answer)} is waiting for your approval. Nothing has changed yet; it is applied when you approve it.`);
    this.name = 'OwnerApprovalPendingError';
    this.approvalId = answer.approvalId;
    this.answer = answer;
  }
}

/** `left`: the tab signed out or changed daemon while the change waited; the daemon that asked still decides it. */
export type OwnerApprovalOutcome = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled' | 'left';

export interface PendingOwnerChange {
  readonly approvalId: string;
  readonly summary: string;
  readonly keys: readonly string[];
  readonly sessionId?: string | undefined;
  /** The client lifetime the change was raised under; only it can read the approval's outcome. */
  readonly lifetime: ClientLifetime;
  readonly outcome: OwnerApprovalOutcome;
}

type Listener = () => void;
let changes: readonly PendingOwnerChange[] = [];
const listeners = new Set<Listener>();
let watchingLifetime = false;

function publish(next: readonly PendingOwnerChange[]): void {
  changes = next;
  for (const listener of listeners) listener();
}

/** Settle every waiting change raised under a lifetime that has ended as `left`. */
function leaveRetiredChanges(): void {
  if (!changes.some((change) => change.outcome === 'pending' && !isClientLifetimeCurrent(change.lifetime))) return;
  publish(changes.map((change) => (
    change.outcome === 'pending' && !isClientLifetimeCurrent(change.lifetime) ? { ...change, outcome: 'left' } : change
  )));
}

/**
 * Record a change the daemon put to the owner. A change this credential may
 * not read the approval of (`followable: false`) is not recorded: its outcome
 * would never reach this tab, so no notice is shown for it; the write still
 * rejects with {@link OwnerApprovalPendingError}, which says it waits.
 */
export function trackOwnerApproval(answer: OwnerApprovalPendingAnswer): void {
  if (answer.followable === false) return;
  if (!watchingLifetime) {
    watchingLifetime = true;
    subscribeClientLifetime(leaveRetiredChanges);
  }
  if (changes.some((change) => change.approvalId === answer.approvalId)) return;
  publish([...changes, {
    approvalId: answer.approvalId,
    summary: describe(answer),
    keys: [...(answer.keys ?? [])],
    ...(answer.sessionId ? { sessionId: answer.sessionId } : {}),
    lifetime: getClientLifetime(),
    outcome: 'pending',
  }]);
}

/** The approval's status as the daemon reports it, mapped to an outcome. */
export function outcomeOfApprovalStatus(status: unknown): OwnerApprovalOutcome {
  return status === 'approved' || status === 'denied' || status === 'expired' || status === 'cancelled' ? status : 'pending';
}

/**
 * Record how a pending change's approval settled, as read under `lifetime`. A
 * reading taken under a lifetime that is not the change's own (or no longer
 * current) is dropped: only the identity and daemon that raised the change know it.
 */
export function settleOwnerApproval(approvalId: string, outcome: OwnerApprovalOutcome, lifetime: ClientLifetime): void {
  if (outcome === 'pending' || !isClientLifetimeCurrent(lifetime)) return;
  publish(changes.map((change) => (
    change.approvalId === approvalId && change.outcome === 'pending' && change.lifetime === lifetime ? { ...change, outcome } : change
  )));
}

/** Forget a change once its outcome was shown. */
export function dismissOwnerApproval(approvalId: string): void {
  publish(changes.filter((change) => change.approvalId !== approvalId));
}

export function subscribeOwnerApprovals(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function ownerApprovalChanges(): readonly PendingOwnerChange[] {
  return changes;
}

/**
 * A write's answer: passed through when it was applied; recorded as pending
 * and rejected with {@link OwnerApprovalPendingError} when the daemon put it
 * to the owner.
 */
export function acceptOwnerApprovalAnswer<T>(answer: T): T {
  if (isOwnerApprovalPending(answer)) {
    trackOwnerApproval(answer);
    throw new OwnerApprovalPendingError(answer);
  }
  return answer;
}
