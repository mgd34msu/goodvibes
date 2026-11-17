/**
 * windows.ts, the approval gate and the veto window.
 *
 * ══ READ THIS BEFORE UNIFYING THEM ════════════════════════════════════════
 *
 * These two look like near-duplicates. Merging them into one timed-prompt
 * primitive with a configurable default would be a natural cleanup and it would
 * be a serious defect. See docs/decisions/2026-07-27-payment-windows-are-deliberately-opposite.md.
 *
 *   ABOVE budget → an APPROVAL. Silence means DENIED.
 *   WITHIN budget → a VETO.     Silence means PROCEEDS.
 *
 * Owner's reasoning for the approval side:
 *
 *   "if i didn't want the approval to expire, I should have just increased the
 *    limit... puts it directly in the human's hands, never lets automated
 *    spending happen"
 *
 * They answer different questions. The approval asks *may this happen at all*,
 * and an unanswered question about money above the limit must resolve to no. The
 * veto announces *this is about to happen*, and an unanswered announcement about
 * money inside a limit the owner already set must resolve to yes, otherwise the limit
 * does nothing and every purchase is an approval.
 *
 * Collapsing them means picking one silence rule for both. Either every
 * above-budget purchase starts going through unattended, or every in-budget one
 * stalls waiting for a human, and the second gets "fixed" by flipping the
 * default, which produces the first.
 *
 * The duplication below is load-bearing. There is deliberately no shared
 * `openTimedPrompt()`.
 *
 * ══ Presence is not attention ═════════════════════════════════════════════
 *
 * The window runs its full configured duration regardless of where the owner is. No
 * presence, focus, idle or activity signal shortens, skips or extends it, the
 * deadline is a function of the start instant and the configured duration and
 * nothing else. Owner's reasoning:
 *
 *   "this is for situations where the user is multitasking and doesn't look at
 *    the specific terminal session for an extended period of time"
 *
 * Only an explicit acknowledgement short-circuits it.
 */
import type { CommandAuthorityChannel, PaymentAnswerChannel } from './types.js';
import type { ChannelDeliveryReceipt } from '../channels/delivery/types.js';

/**
 * What happens when a window closes with no answer.
 *
 * The two windows must never share a value. A test asserts both values
 * individually and asserts they differ, so a change to either fails with a
 * message naming the ruling rather than silently converting denials into
 * purchases.
 */
export type SilenceMeaning = 'denied' | 'proceeds';

export const APPROVAL_GATE = {
  kind: 'approval',
  silenceMeans: 'denied',
} as const satisfies { kind: string; silenceMeans: SilenceMeaning };

export const VETO_WINDOW = {
  kind: 'veto',
  silenceMeans: 'proceeds',
} as const satisfies { kind: string; silenceMeans: SilenceMeaning };

/** What the delivery layer reported, per channel. */
export interface ChannelDelivery {
  readonly channel: CommandAuthorityChannel;
  readonly delivered: boolean;
  /** Recorded with each delivery. A restart decides from the channel itself
   * (`RESTART_READABLE_CHANNELS`), never from this flag. */
  readonly backfillable: boolean;
  /** Exact provider acknowledgement, when available. Not a backfill capability. */
  readonly receipt?: ChannelDeliveryReceipt | undefined;
}

export type ApprovalState =
  | 'pending-dispatch'
  | 'awaiting-approval'
  | 'approved'
  | 'denied-explicit'
  | 'denied-timeout'
  | 'denied-undeliverable'
  | 'void';

export type VetoState =
  | 'pending-dispatch'
  | 'open'
  | 'proceeding-acknowledged'
  | 'proceeding-silent'
  | 'proceeding-undelivered'
  | 'cancelled'
  /**
   * The owner answered the notice in time with something that was not a
   * go-ahead: an addressed reply that was not a confident acknowledgement, or
   * a reply whose best reading was an objection. The timer stops; nothing is
   * bought unless the owner says yes to an explicit approval question.
   */
  | 'held-reply-not-understood'
  | 'void';

/** Every terminal state settles its reservation exactly one way. */
export type Settlement = 'commit' | 'release' | 'hold';

const APPROVAL_SETTLEMENT: Readonly<Record<ApprovalState, Settlement>> = {
  'pending-dispatch': 'hold',
  'awaiting-approval': 'hold',
  approved: 'hold', // proceeds to payment; commit happens after the charge
  'denied-explicit': 'release',
  'denied-timeout': 'release',
  'denied-undeliverable': 'release',
  void: 'release',
};

const VETO_SETTLEMENT: Readonly<Record<VetoState, Settlement>> = {
  'pending-dispatch': 'hold',
  open: 'hold',
  'proceeding-acknowledged': 'hold',
  'proceeding-silent': 'hold',
  'proceeding-undelivered': 'hold',
  cancelled: 'release',
  // Held until the explicit approval question settles it.
  'held-reply-not-understood': 'hold',
  void: 'release',
};

export function approvalSettlement(state: ApprovalState): Settlement {
  return APPROVAL_SETTLEMENT[state];
}

export function vetoSettlement(state: VetoState): Settlement {
  return VETO_SETTLEMENT[state];
}

export function isTerminalApproval(state: ApprovalState): boolean {
  return state !== 'pending-dispatch' && state !== 'awaiting-approval';
}

export function isTerminalVeto(state: VetoState): boolean {
  return state !== 'pending-dispatch' && state !== 'open';
}

/** The deadline. A pure function of the start and the duration, nothing else. */
export function windowDeadlineMs(startedAtMs: number, minutes: number): number {
  return startedAtMs + Math.max(0, minutes) * 60_000;
}

export type ApprovalEvent =
  | { readonly kind: 'dispatched'; readonly deliveries: readonly ChannelDelivery[] }
  | { readonly kind: 'undeliverable' }
  | { readonly kind: 'approve'; readonly channel: PaymentAnswerChannel }
  | { readonly kind: 'deny'; readonly channel: PaymentAnswerChannel }
  | { readonly kind: 'deadline' }
  | { readonly kind: 'total-changed' };

export type VetoEvent =
  | { readonly kind: 'dispatched'; readonly deliveries: readonly ChannelDelivery[] }
  | { readonly kind: 'undeliverable' }
  | { readonly kind: 'acknowledge'; readonly channel: PaymentAnswerChannel }
  | { readonly kind: 'object'; readonly channel: PaymentAnswerChannel }
  | { readonly kind: 'not-understood'; readonly channel: PaymentAnswerChannel }
  | { readonly kind: 'deadline' }
  | { readonly kind: 'total-changed' };

/**
 * The approval gate. SILENCE DENIES.
 *
 * Note `undeliverable` → `denied-undeliverable`. An above-budget purchase whose
 * notification could not reach the owner does not happen: there is nobody to put it in
 * front of, and the whole point of the above-budget branch is that a human
 * decides.
 */
export function advanceApproval(state: ApprovalState, event: ApprovalEvent): ApprovalState {
  if (isTerminalApproval(state)) return state;
  switch (event.kind) {
    case 'dispatched':
      return event.deliveries.some((entry) => entry.delivered)
        ? 'awaiting-approval'
        : 'denied-undeliverable';
    case 'undeliverable':
      return 'denied-undeliverable';
    case 'approve':
      return state === 'awaiting-approval' ? 'approved' : state;
    case 'deny':
      return 'denied-explicit';
    case 'deadline':
      return 'denied-timeout';
    case 'total-changed':
      return 'void';
    default:
      return state;
  }
}

/**
 * The veto window. SILENCE PROCEEDS.
 *
 * Note `undeliverable` → `proceeding-undelivered`. Owner ruling: under or at
 * budget, items get through. This is the exact mirror of the approval's
 * undeliverable edge, and that pair of edges is the owner's undeliverable ruling in its
 * entirety.
 */
export function advanceVeto(state: VetoState, event: VetoEvent): VetoState {
  if (isTerminalVeto(state)) return state;
  switch (event.kind) {
    case 'dispatched':
      return event.deliveries.some((entry) => entry.delivered) ? 'open' : 'proceeding-undelivered';
    case 'undeliverable':
      return 'proceeding-undelivered';
    case 'acknowledge':
      // Like an approval, an acknowledgement answers a notice that went out.
      // (An objection is honoured from any state: cancelling is the safe edge.)
      return state === 'open' ? 'proceeding-acknowledged' : state;
    case 'object':
      return 'cancelled';
    case 'not-understood':
      // An on-time answer that is not a go-ahead is never silence.
      return state === 'open' ? 'held-reply-not-understood' : state;
    case 'deadline':
      return 'proceeding-silent';
    case 'total-changed':
      return 'void';
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Recovering a window that was interrupted by downtime
// ---------------------------------------------------------------------------

/**
 * Channels whose replies a restart can read back: the daemon archives every
 * owner reply to a Telegram notice before it confirms the update, and the
 * native poller drains what arrived while it was down into that archive. The
 * owner inbox keeps each window's item and its answer in the home's store
 * (answerable from a terminal app while the daemon is down), found again by
 * the item's key.
 */
export const RESTART_READABLE_CHANNELS: readonly CommandAuthorityChannel[] = Object.freeze(['telegram', 'owner-inbox']);

/**
 * What a restart does with a purchase that was waiting for the owner's reply.
 *
 * One order, applied first by the native restorer and then by the boot sweep
 * to every window the restorer did not take back:
 *
 *  1. The notice never reached the owner on any channel (`not-delivered`):
 *     there is nothing to resume. The purchase ends unbought, the hold is
 *     released and the owner is told.
 *  2. Every channel the notice reached keeps its replies across a restart
 *     (`resume`): the window is resumed under its original authority, page and
 *     settings. Replies archived for it are read first, and an objection or a
 *     refusal ends it. Silence counts only where the archive proves every reply
 *     up to the deadline was received; a recipient that is not proven gets the
 *     notice again and a renewed deadline. An approval that expired unanswered
 *     is still denied. `/payments pending` answers a resumed window too.
 *  3. A channel the notice reached keeps no replies across a restart (`end`):
 *     a reply there may have been lost, and a lost objection must not become a
 *     veto's silence. The purchase ends unbought and the owner is told.
 *  4. A window that should resume but cannot (its page, pairing, payment
 *     settings, decision models or saved replies are not as they were): it
 *     ends unbought, the hold is released and the owner is told why.
 *
 * Keyed on DELIVERY, not on uptime: silence means "the owner had the chance to
 * object and did not", and whether this process was alive has nothing to do
 * with that chance. A delivered notice is never sent again to a recipient whose
 * replies are proven, because a system that repeats itself is one people stop
 * reading.
 */
export interface WindowRecovery {
  readonly outcome: 'not-delivered' | 'resume' | 'end';
  /** Channels the notice reached. */
  readonly deliveredChannels: readonly CommandAuthorityChannel[];
  /** Delivered channels whose replies a restart cannot read back. */
  readonly unreadableChannels: readonly CommandAuthorityChannel[];
  readonly deadlinePassed: boolean;
  readonly reason: string;
}

export function recoverInterruptedWindow(input: {
  readonly deliveries: readonly ChannelDelivery[];
  readonly deadlinePassed: boolean;
}): WindowRecovery {
  const delivered = [...new Set(input.deliveries.filter((entry) => entry.delivered).map((entry) => entry.channel))];
  const unreadable = delivered.filter((channel) => !RESTART_READABLE_CHANNELS.includes(channel));
  if (delivered.length === 0) {
    return {
      outcome: 'not-delivered',
      deliveredChannels: [],
      unreadableChannels: [],
      deadlinePassed: input.deadlinePassed,
      reason: 'The notice never reached the owner, so there is no window to resume.',
    };
  }
  if (unreadable.length > 0) {
    return {
      outcome: 'end',
      deliveredChannels: delivered,
      unreadableChannels: unreadable,
      deadlinePassed: input.deadlinePassed,
      reason: 'A channel the notice reached keeps no replies across a restart, so a reply there may have been lost.',
    };
  }
  return {
    outcome: 'resume',
    deliveredChannels: delivered,
    unreadableChannels: [],
    deadlinePassed: input.deadlinePassed,
    reason: 'Every channel the notice reached keeps its replies across a restart, so the window is resumed from them.',
  };
}
