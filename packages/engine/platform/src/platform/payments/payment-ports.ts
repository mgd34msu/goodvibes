/**
 * payment-ports.ts, the two composition-supplied ports the checkout flow
 * spends and speaks through.
 *
 * Split from checkout-flow.ts purely for size; the flow re-exports both, so
 * every existing import path still works. The semantics documented on each
 * member are the contract; see checkout-flow.ts for how the flow uses them.
 */
import type { PurchaseRecord } from './purchase-record.js';
import type { ChannelDelivery } from './windows.js';
import type { PaymentAnswerChannel } from './types.js';

export interface PaymentNoticeWindow {
  /** Sending starts after the reply source has reserved this exact purchase. */
  readonly deliveries: Promise<readonly ChannelDelivery[]>;
  /** Arm only after the actual delivery report and deadline are durable. */
  awaitAnswer(deadlineMs: number): ReturnType<PaymentNotifier['awaitAnswer']>;
  /** Retire queued replies and any unarmed wait on every nonwaiting exit. */
  cancel(): void;
}

export interface PurchaseLedger {
  /** Synchronous evidence check before admitting a new checkout and again at
   * the submit actuator. An unreadable ledger must not become empty history. */
  assertAvailable?(): void;
  /**
   * `ownerNotice`: the report the owner is owed for this purchase, saved in the
   * same write as the record, so a restart before it is sent still sends it.
   */
  record(entry: PurchaseRecord, options?: { readonly ownerNotice?: string | undefined }): Promise<void>;
  /** The owed report was handed to a channel that took it: it is no longer owed (one write). */
  settleOwnerNotice?(purchaseId: string): Promise<void>;
  /**
   * Optional lookup. Boot recovery uses it to verify that a `submitted`
   * journal record really has its purchase on the ledger before closing the
   * record and telling the owner it was recorded. A composition without it
   * gets the conservative treatment: the record is kept and the owner is
   * told exactly what could and could not be verified.
   */
  has?(purchaseId: string): Promise<boolean>;
}

/** Delivering a prompt and hearing back, over channels that carry authority. */
/** The refusal code of an owner answer to a purchase window that could not be read (never silence). */
export const PAYMENT_ANSWER_UNREADABLE = 'PAYMENT_ANSWER_UNREADABLE';

/** The owner-inbox metadata a purchase window's facts are posted under (host/notifier.ts), read by the ask's wording. */
export const PURCHASE_ITEM_METADATA = 'purchaseItem';
export const PURCHASE_SHOP_METADATA = 'purchaseShop';
export const PURCHASE_AMOUNT_METADATA = 'purchaseAmount';
/** When a window closes (epoch ms): a veto window goes ahead then, an approval window stops waiting. The item itself outlives it by a minute. */
export const PURCHASE_DEADLINE_METADATA = 'purchaseDeadline';

/** A purchase window's subject as facts: the item, the shop and the amount with its currency ("$64.00"). */
export interface PurchaseNoticeFacts {
  readonly item: string;
  readonly shop: string;
  readonly amount: string;
}

export interface PaymentNotifier {
  /** The native channel composition reserves reply reception before sending,
   * so an owner answering during delivery/journal I/O cannot fall through to
   * chat or be mistaken for silence. Other transports may own reception in
   * their own mailbox and implement deliver/awaitAnswer directly. */
  prepareWindow?(input: {
    readonly purchaseId: string;
    readonly kind: 'approval' | 'veto';
    readonly notice: string;
    /** What the window is about, as facts: carried on its owner-inbox item so every surface words it the same. */
    readonly facts?: PurchaseNoticeFacts | undefined;
    readonly assertCurrent?: (() => void) | undefined;
    readonly signal?: AbortSignal | undefined;
    /**
     * True when the purchase is stopping with this window saved for the next
     * start (the host stops, the owner did not cancel). The window's
     * owner-inbox item then stays open, so the owner can still answer it while
     * the daemon is down and the next start reads that answer.
     */
    readonly keepOnStop?: (() => boolean) | undefined;
  }): PaymentNoticeWindow;
  /** Sends the message; reports per-channel landing. `notice` expects no reply (boot-recovery settlements). */
  deliver(input: {
    readonly kind: 'approval' | 'veto' | 'notice';
    readonly message: string;
    /** For a window: what it is about, as facts (see prepareWindow). */
    readonly facts?: PurchaseNoticeFacts | undefined;
    readonly assertCurrent?: (() => void) | undefined;
    readonly signal?: AbortSignal | undefined;
  }): Promise<readonly ChannelDelivery[]>;
  /**
   * Wait for an answer, or until the deadline.
   *
   * Resolves null on silence. The caller decides what silence MEANS, because
   * the two windows mean opposite things by it and a notifier that decided
   * would be one place where they could be accidentally unified. An answer
   * that could not be read is never silence: it rejects with a RefusalError
   * coded {@link PAYMENT_ANSWER_UNREADABLE}, and nothing is bought on it.
   */
  awaitAnswer(input: {
    /** The exact purchase whose persisted window is being answered. */
    readonly purchaseId: string;
    readonly kind: 'approval' | 'veto';
    /** This purchase's notice; never a shared "last notice". */
    readonly notice: string;
    readonly deadlineMs: number;
    readonly signal?: AbortSignal | undefined;
  }): Promise<{
    /** `not-understood` (veto windows only): an on-time reply that was not a go-ahead; see `readPaymentReply`. */
    readonly answer: 'approve' | 'deny' | 'acknowledge' | 'object' | 'not-understood';
    readonly channel: PaymentAnswerChannel;
  } | null>;
}

