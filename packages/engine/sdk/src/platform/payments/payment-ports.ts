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
  record(entry: PurchaseRecord): Promise<void>;
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
export interface PaymentNotifier {
  /** The native channel composition reserves reply reception before sending,
   * so an owner answering during delivery/journal I/O cannot fall through to
   * chat or be mistaken for silence. Other transports may own reception in
   * their own mailbox and implement deliver/awaitAnswer directly. */
  prepareWindow?(input: {
    readonly purchaseId: string;
    readonly kind: 'approval' | 'veto';
    readonly notice: string;
    readonly assertCurrent?: (() => void) | undefined;
    readonly signal?: AbortSignal | undefined;
  }): PaymentNoticeWindow;
  /** Sends the message; reports per-channel landing. `notice` expects no reply (boot-recovery settlements). */
  deliver(input: {
    readonly kind: 'approval' | 'veto' | 'notice';
    readonly message: string;
    readonly assertCurrent?: (() => void) | undefined;
    readonly signal?: AbortSignal | undefined;
  }): Promise<readonly ChannelDelivery[]>;
  /**
   * Wait for an answer, or until the deadline.
   *
   * Resolves null on silence. The caller decides what silence MEANS, because
   * the two windows mean opposite things by it and a notifier that decided
   * would be one place where they could be accidentally unified.
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
    readonly answer: 'approve' | 'deny' | 'acknowledge' | 'object';
    readonly channel: PaymentAnswerChannel;
  } | null>;
}

