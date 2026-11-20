/**
 * approval-lifecycle.ts, the one table an approval moves through, the one
 * shape every write of it takes, and the one reading every surface renders.
 *
 * ── Why one table and one transition path ─────────────────────────────────
 *
 * An approval used to be written by six paths (raise, claim, resolve, cancel,
 * expire, the remembered sweep), each with its own guard, its own order of
 * write, publish and wake, and its own idea of what a late call meant. Every
 * write is now an {@link ApprovalTransition}, applied by the broker's one
 * transition function inside its store write queue: the lifecycle table below
 * says which moves exist, a terminal record refuses every later move with
 * `APPROVAL_SETTLED`, and a caller that presents the revision it read is
 * refused with `APPROVAL_CHANGED` when the record moved since. A lost race is
 * an answer with the current reading, never a second event and never a
 * silent success.
 *
 * ── Why one reading ───────────────────────────────────────────────────────
 *
 * {@link readApproval} answers, for one viewer: what is waiting, on whom,
 * until when, what this viewer may do now, how it ended, and whether the
 * requester received the decision. "Approved" says the decision; `receipt`
 * says whether it reached the asker; `work` says that whether the approved
 * work ran is not reported here. A surface words the reason its own way, but
 * it never decides the state, the deadline or the actions itself.
 *
 * Browser-safe: pure data and pure functions, no node imports. The web UI
 * imports the reading's types from here.
 *
 * Cost: none of this does I/O; a reading is O(1) per record.
 */
import { refusal, type Refusal } from '@goodvibes-jev/engine/errors';
import { defineLifecycle } from '../utils/lifecycle-machine.js';
import type { SharedApprovalRecord, SharedApprovalStatus } from './approval-broker.js';
import type { SharedApprovalDecision, SharedApprovalDisposition } from './approval-disposition.js';
import type { OwnerApprovalProof } from './approval-broker-owner.js';

/**
 * The approval lifecycle. `claimed → claimed` is the one same-state move: a
 * later claim replaces `claimedBy` (a claim is advisory and gates nothing).
 */
export const approvalLifecycle = defineLifecycle<SharedApprovalStatus>('approval', {
  pending: ['claimed', 'approved', 'denied', 'cancelled', 'expired'],
  claimed: ['claimed', 'approved', 'denied', 'cancelled', 'expired'],
  approved: [],
  denied: [],
  cancelled: [],
  expired: [],
});

/** Whether an approval is still waiting for a decision. */
export function isOpenApprovalStatus(status: SharedApprovalStatus): boolean {
  return status === 'pending' || status === 'claimed';
}

/** Where an approval lives and its id there. Wire form `<id>@<node>`. */
export interface ApprovalRef {
  readonly node: string;
  readonly id: string;
}

export function formatApprovalRef(ref: ApprovalRef): string {
  return `${ref.id}@${ref.node}`;
}

/** A bare id means an approval on `localNode`. */
export function parseApprovalRef(value: string, localNode: string): ApprovalRef {
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return { node: localNode, id: value };
  return { node: value.slice(at + 1), id: value.slice(0, at) };
}

/** One wire raiser's hold on an ask; `releasedAt` is set when it gave the hold up (left, or received the decision). */
export interface ApprovalHold {
  readonly id: string;
  readonly releasedAt?: number | undefined;
}

/** Who waits for the answer, which is what receipt evidence is read from. */
export type ApprovalRequester =
  /** A waiter inside this daemon (the gate, a hosted capability): it is answered in the same step that records the decision. */
  | { readonly kind: 'in-process' }
  /** Surfaces that raised it over `approvals.raise`: each holds it until it releases the hold, which it does once it has the answer. */
  | { readonly kind: 'wire'; readonly holds: readonly ApprovalHold[] }
  /** The requester reads the record itself (a change put to the owner, applied by the process that reads the decision). */
  | { readonly kind: 'record-reader' };

/** Why an approval ended without a person's decision, or why it was cancelled. */
export type ApprovalCause =
  | 'requester-left'
  | 'requester-restarted'
  | 'cancelled-by-actor'
  | 'owner-decision-stale'
  | 'deadline'
  | 'deadline-while-down'
  | 'remembered-rule';

/** Who moved a record, from where. */
export interface ApprovalActor {
  readonly id: string;
  readonly surface: string;
  readonly node?: string | undefined;
}

/** Every write of an approval is one of these, applied by the broker's one transition function. */
export type ApprovalTransition =
  | { readonly to: 'claimed'; readonly actor: ApprovalActor; readonly note?: string | undefined }
  | {
    readonly to: 'approved' | 'denied';
    readonly actor: ApprovalActor;
    readonly decision: SharedApprovalDecision;
    /** The typed answer to a command's prompt: handed to the waiter of THIS transition only, never stored. */
    readonly withheldAnswer?: string | undefined;
    readonly ownerProof?: OwnerApprovalProof | undefined;
    readonly note?: string | undefined;
  }
  | { readonly to: 'cancelled'; readonly actor: ApprovalActor; readonly cause: ApprovalCause; readonly note?: string | undefined }
  | { readonly to: 'expired'; readonly cause: 'deadline' | 'deadline-while-down'; readonly note?: string | undefined }
  /** No status change: metadata merged (a prompt that could not be delivered, a remote run's report). */
  | {
    readonly to: 'updated'; readonly actor: ApprovalActor; readonly metadata?: Record<string, unknown> | undefined; readonly note?: string | undefined;
    /** Another wire raiser attached to this open ask: its hold is recorded, so the ask stays open until it too leaves. */
    readonly addHold?: string | undefined;
  }
  /** A wire raiser gives up its hold: on an open ask it leaves, on a decided one it confirms it received the answer. */
  | { readonly to: 'released'; readonly actor: ApprovalActor; readonly holdId?: string | undefined; readonly note?: string | undefined };

export interface TransitionRequest {
  readonly id: string;
  /**
   * The revision of the record the caller showed or read. Required for every
   * action a person or client takes; undefined only for the broker's own
   * timer, signal and restart paths.
   */
  readonly expectedRevision: number | undefined;
  readonly transition: ApprovalTransition;
}

/** Stable refusal codes an approval action answers with. */
export type ApprovalRefusalCode =
  | 'APPROVAL_SETTLED'
  | 'APPROVAL_CHANGED'
  | 'ILLEGAL_TRANSITION'
  | 'OWNER_DECISION_REQUIRED'
  | 'APPROVAL_EXPIRED'
  | 'UNKNOWN_APPROVAL'
  | 'NODE_UNREACHABLE';

export type TransitionOutcome =
  | { readonly applied: true; readonly record: SharedApprovalRecord }
  | { readonly applied: false; readonly record: SharedApprovalRecord | null; readonly refusal: Refusal };

/** Who is reading. Built by the route from the authenticated actor (approval-viewer.ts); never from a request body. */
export interface ApprovalViewer {
  readonly kind: 'owner-route' | 'admin' | 'operator' | 'agent' | 'remote-node';
  /** The principal id, when the viewer is a principal; used for "claimed by you" and "you asked". */
  readonly id?: string | undefined;
  readonly scopes: readonly string[];
  /** The node the viewer reached. */
  readonly node: string;
  /** May answer (`approval.answer`: the owner's own act; a model never). */
  readonly mayAnswer: boolean;
  /** May claim and cancel (`approvals.administer`). */
  readonly mayAdminister: boolean;
}

export type ApprovalAction = 'claim' | 'approve' | 'deny' | 'amend' | 'cancel';

export type ApprovalReason =
  | 'waiting-for-approver' | 'waiting-for-owner' | 'claimed-by-you' | 'claimed-by-other'
  | 'approved' | 'denied' | 'amended' | 'remembered-approved' | 'remembered-denied'
  | 'cancelled-requester-left' | 'cancelled-requester-restarted' | 'cancelled-by-actor' | 'cancelled-owner-decision-stale'
  | 'expired' | 'expired-while-down';

export type ApprovalReceiptState = 'delivered' | 'waiting' | 'undeliverable' | 'requester-reads-record' | 'not-applicable';

export type ApprovalNextMove = 'wait' | 'decide' | 'refresh' | 'raise-again' | 'nothing';

/** The one reading every surface renders and every agent reads. Computed per viewer. */
export interface ApprovalReading {
  readonly ref: ApprovalRef;
  /** What an action names as `expectedRevision`: moves on a claim, a decision or an end, never on a note or a hold. */
  readonly revision: number;
  /** Moves on every write of the record: what frames are ordered by. */
  readonly sequence: number;
  /** `waiting` (pending or claimed), `decided` (approved or denied), `ended` (cancelled or expired). */
  readonly phase: 'waiting' | 'decided' | 'ended';
  readonly status: SharedApprovalStatus;
  readonly reason: ApprovalReason;
  /** While waiting: on whom, and whether the node that decides it can be reached. */
  readonly waitingOn?: {
    readonly who: 'owner' | 'approver';
    readonly claimedBy?: string | undefined;
    readonly homeNode: string;
    readonly homeReachable: boolean;
  } | undefined;
  /** While waiting, for an ask with a deadline: when it expires unanswered. */
  readonly deadline?: { readonly expiresAt: number; readonly remainingMs: number } | undefined;
  /** What THIS viewer may do now. A request is still re-checked when it is applied. */
  readonly allowedActions: readonly ApprovalAction[];
  readonly refusedActions: readonly { readonly action: ApprovalAction; readonly code: string; readonly reason: string }[];
  /** How it was decided or ended: by whom, from which surface and node, when. */
  readonly decision?: {
    readonly disposition: SharedApprovalDisposition;
    readonly by: string;
    readonly surface: string;
    readonly node: string;
    readonly at: number;
    readonly cause?: ApprovalCause | undefined;
  } | undefined;
  /** Whether the requester received the decision. Read from evidence only: a wire raiser's released hold, an in-process waiter answered in the deciding step. */
  readonly receipt: { readonly state: ApprovalReceiptState; readonly reason?: string | undefined };
  /** Who asked: the kind of requester, and whether it was this viewer. */
  readonly requester: { readonly kind: ApprovalRequester['kind']; readonly principal?: string | undefined; readonly surface?: string | undefined; readonly mine: boolean };
  /** Whether the approved work ran is not reported by the approval; `callId` links to the tool call that asked. */
  readonly work: { readonly state: 'not-reported'; readonly callId: string; readonly sessionId?: string | undefined };
  /** The lawful next moves for this viewer, most useful first. */
  readonly next: readonly { readonly move: ApprovalNextMove; readonly text: string }[];
}

const ACTIONS: readonly ApprovalAction[] = ['claim', 'approve', 'deny', 'amend', 'cancel'];

function metadataText(record: SharedApprovalRecord, key: string): string | undefined {
  const value = record.metadata[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function reasonOf(record: SharedApprovalRecord, viewer: ApprovalViewer): ApprovalReason {
  switch (record.status) {
    case 'pending':
      return record.requiresOwnerDecision ? 'waiting-for-owner' : 'waiting-for-approver';
    case 'claimed':
      return viewer.id !== undefined && record.claimedBy === viewer.id ? 'claimed-by-you' : 'claimed-by-other';
    case 'approved':
      return record.decision?.disposition === 'remembered' ? 'remembered-approved' : 'approved';
    case 'denied':
      return record.decision?.disposition === 'remembered' ? 'remembered-denied'
        : record.decision?.disposition === 'amended' ? 'amended' : 'denied';
    case 'cancelled':
      switch (record.cause) {
        case 'requester-left': return 'cancelled-requester-left';
        case 'requester-restarted': return 'cancelled-requester-restarted';
        case 'owner-decision-stale': return 'cancelled-owner-decision-stale';
        default: return 'cancelled-by-actor';
      }
    case 'expired':
      return record.cause === 'deadline-while-down' ? 'expired-while-down' : 'expired';
  }
}

/** The audit entry that closed the record, for the surface and node it was decided from. */
function closingAudit(record: SharedApprovalRecord): SharedApprovalRecord['audit'][number] | undefined {
  for (let index = record.audit.length - 1; index >= 0; index -= 1) {
    const entry = record.audit[index]!;
    if (entry.action === record.status) return entry;
  }
  return undefined;
}

function receiptOf(record: SharedApprovalRecord): ApprovalReading['receipt'] {
  if (isOpenApprovalStatus(record.status)) return { state: 'not-applicable', reason: 'Nothing is decided yet.' };
  if (record.cause === 'requester-left' || record.cause === 'requester-restarted') {
    return { state: 'not-applicable', reason: 'The asker stopped waiting before it was decided.' };
  }
  const requester = record.requester;
  switch (requester.kind) {
    case 'in-process':
      return { state: 'delivered', reason: 'The waiting call was answered in the same step that recorded it.' };
    case 'record-reader':
      return { state: 'requester-reads-record', reason: 'The asker reads this record when it acts on it.' };
    case 'wire': {
      const held = requester.holds.filter((hold) => hold.releasedAt === undefined).length;
      if (held === 0) return { state: 'delivered', reason: 'Every surface that asked confirmed it received the answer.' };
      return {
        state: 'waiting',
        reason: held === 1
          ? 'The surface that asked has not yet confirmed it received the answer; it reads it when it reconnects.'
          : `${held} surfaces that asked have not yet confirmed they received the answer; each reads it when it reconnects.`,
      };
    }
  }
}

/** Why a viewer may not take an action now, or undefined when it may. */
function refusalFor(record: SharedApprovalRecord, viewer: ApprovalViewer, action: ApprovalAction): { code: string; reason: string } | undefined {
  if (!isOpenApprovalStatus(record.status)) {
    return { code: 'APPROVAL_SETTLED', reason: `It is ${record.status}, which is final.` };
  }
  if (action === 'claim' || action === 'cancel') {
    if (viewer.kind === 'agent') return { code: 'OWNER_ONLY', reason: 'An agent can read approvals but never acts on them.' };
    if (!viewer.mayAdminister) return { code: 'FORBIDDEN', reason: 'Claiming or cancelling an approval needs an admin credential with write:approvals.' };
    return undefined;
  }
  if (viewer.kind === 'agent' || !viewer.mayAnswer) {
    return { code: 'OWNER_ONLY', reason: 'Answering an approval is the owner\'s own act.' };
  }
  if (action === 'approve' && record.requiresOwnerDecision) {
    return { code: 'OWNER_DECISION_REQUIRED', reason: 'Only the paired-owner decision on the device that raised it can approve it; it can be denied from here.' };
  }
  if (action === 'approve' && viewer.kind === 'remote-node') {
    return { code: 'OWNER_DECISION_REQUIRED', reason: 'A relayed approve is refused for an ask that needs the owner\'s own decision.' };
  }
  return undefined;
}

function nextMoves(record: SharedApprovalRecord, allowed: readonly ApprovalAction[], receipt: ApprovalReading['receipt']): ApprovalReading['next'] {
  const revision = record.revision;
  if (isOpenApprovalStatus(record.status)) {
    if (allowed.includes('approve') || allowed.includes('deny')) {
      return [{ move: 'decide', text: `Approve or deny it with expectedRevision ${revision}.` }];
    }
    return [{ move: 'wait', text: record.requiresOwnerDecision
      ? 'Wait for the owner to decide it on the device that raised it; watch approval-update for it.'
      : 'Wait for the owner to decide it; watch approval-update for it.' }];
  }
  if (record.status === 'approved' || record.status === 'denied') {
    if (receipt.state === 'waiting') return [{ move: 'wait', text: 'The decision is recorded; the asking surface reads it when it reconnects.' }];
    return [{ move: 'nothing', text: 'Nothing to do; the decision stands. Whether the work ran is reported by the work, not the approval.' }];
  }
  return [{ move: 'raise-again', text: 'Ask again if the action is still wanted.' }];
}

/**
 * The reading of `record` for `viewer` at `now`. `homeReachable` is false
 * only when the record is a remote node's and that node stopped answering.
 */
export function readApproval(record: SharedApprovalRecord, viewer: ApprovalViewer, now: number, homeReachable = true): ApprovalReading {
  const open = isOpenApprovalStatus(record.status);
  const phase: ApprovalReading['phase'] = open ? 'waiting'
    : record.status === 'approved' || record.status === 'denied' ? 'decided' : 'ended';
  const allowedActions: ApprovalAction[] = [];
  const refusedActions: { action: ApprovalAction; code: string; reason: string }[] = [];
  for (const action of ACTIONS) {
    const refused = refusalFor(record, viewer, action);
    if (refused) refusedActions.push({ action, ...refused });
    else allowedActions.push(action);
  }
  const receipt = receiptOf(record);
  const closing = open ? undefined : closingAudit(record);
  const disposition = record.decision?.disposition ?? (record.status === 'approved' ? 'approved' : record.status === 'denied' ? 'denied' : undefined);
  const principal = metadataText(record, 'raisedByPrincipal');
  const surface = metadataText(record, 'raisedBySurface');
  return {
    ref: { node: record.homeNode, id: record.id },
    revision: record.revision,
    sequence: record.sequence,
    phase,
    status: record.status,
    reason: reasonOf(record, viewer),
    ...(open ? {
      waitingOn: {
        who: record.requiresOwnerDecision ? 'owner' as const : 'approver' as const,
        ...(record.status === 'claimed' && record.claimedBy !== undefined ? { claimedBy: record.claimedBy } : {}),
        homeNode: record.homeNode,
        homeReachable,
      },
      ...(record.expiresAt !== undefined ? { deadline: { expiresAt: record.expiresAt, remainingMs: Math.max(0, record.expiresAt - now) } } : {}),
    } : {}),
    allowedActions,
    refusedActions,
    ...(!open && disposition !== undefined ? {
      decision: {
        disposition,
        by: record.resolvedBy ?? closing?.actor ?? 'unknown',
        surface: closing?.actorSurface ?? 'unknown surface',
        node: closing?.actorNode ?? record.homeNode,
        at: record.resolvedAt ?? record.updatedAt,
        ...(record.cause !== undefined ? { cause: record.cause } : {}),
      },
    } : {}),
    receipt,
    requester: {
      kind: record.requester.kind,
      ...(principal !== undefined ? { principal } : {}),
      ...(surface !== undefined ? { surface } : {}),
      mine: principal !== undefined && viewer.id !== undefined && principal === viewer.id,
    },
    work: { state: 'not-reported', callId: record.callId, ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}) },
    next: nextMoves(record, allowedActions, receipt),
  };
}

/** The viewer the broker publishes events for: an admin who may answer, on the record's own node. */
export function adminApprovalViewer(node: string): ApprovalViewer {
  return { kind: 'admin', scopes: ['read:approvals', 'write:approvals'], node, mayAnswer: true, mayAdminister: true };
}

/** The refusal an approval action answers with, in product terms, with the record's state named. */
export function approvalRefusal(code: ApprovalRefusalCode, record: SharedApprovalRecord | null, detail?: string): Refusal {
  const state = record === null ? 'not in this daemon\'s approvals' : `${record.status} (revision ${record.revision})`;
  switch (code) {
    case 'UNKNOWN_APPROVAL':
      return refusal({ code, state, status: 404, reason: detail ?? 'No approval has that id.', next: ['List approvals again and act on an id it shows.'] });
    case 'APPROVAL_SETTLED':
      return refusal({
        code, state, status: 409,
        reason: detail ?? `It is already ${record?.status ?? 'settled'}${record?.resolvedBy ? ` by ${record.resolvedBy}` : ''}, which is final; nothing changed.`,
        next: ['Nothing to do; the first decision stands. Read the returned reading for who decided it.'],
      });
    case 'APPROVAL_CHANGED':
      return refusal({
        code, state, status: 409,
        reason: detail ?? `It changed since revision you read; it is now at revision ${record?.revision ?? '?'}. Nothing was applied.`,
        next: ['Show the returned reading again, then act on it with its revision.'],
      });
    case 'APPROVAL_EXPIRED':
      return refusal({
        code, state, status: 409,
        reason: detail ?? 'Its deadline passed before this decision reached it, so it expired unanswered; nothing was approved.',
        next: ['Ask again if the action is still wanted.'],
      });
    case 'OWNER_DECISION_REQUIRED':
      return refusal({
        code, state, status: 403,
        reason: detail ?? 'This approval needs the owner\'s own decision on the device that raised it. Deny and cancel are allowed here.',
        next: ['Approve it with the paired-owner decision on the device that raised it, or deny it here.'],
      });
    case 'NODE_UNREACHABLE':
      return refusal({
        code, state: 'unknown', status: 504, retryable: false,
        reason: detail ?? 'The node that owns this approval did not answer in time, so whether the action was applied is not known.',
        next: ['Read the approval again; the node that owns it decides whether it was applied.'],
      });
    case 'ILLEGAL_TRANSITION':
      return refusal({ code, state, status: 409, reason: detail ?? 'That move is not one an approval can make now.', next: ['Read the approval again.'] });
  }
}
