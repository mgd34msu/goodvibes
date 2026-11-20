/**
 * gates.ts, step 0 of the decision order: the checks that are terminal.
 *
 * Everything here refuses outright. There is no approval path around a gate and
 * no downgrade path through one, that is what separates step 0 from steps 1
 * and 2, where a purchase can still be rescued by an approval or by stepping
 * delivery down.
 *
 * The gates take a single record with every input REQUIRED rather than a partly
 * optional bag, so a caller cannot quietly omit one and get a pass. In
 * particular `isPaymentsLeader` has no default: on a clustered install the wrong
 * answer here is a double-spend, and a defaulted `true` would be the kind of
 * convenience that reads fine in review and costs money in production.
 */
import type { RefusalCode } from './types.js';

export interface GateInput {
  /** `payments.enabled`. */
  readonly enabled: boolean;
  /**
   * A card is configured and its material is present in the secret store; under
   * `payments.cvvHandling: 'prompt'`, every field but the security code is, and
   * the owner can be asked for the code at payment time (`securityCodePrompt`).
   */
  readonly hasUsableCard: boolean;
  /** `payments.cvvHandling` is 'prompt': the flow asks the owner for the code before typing the card. */
  readonly securityCodePrompt?: boolean;
  /**
   * The named card is configured and `payments.cvvHandling` is 'prompt', but
   * this host has no way to ask for the code. Only changes the refusal text
   * when `hasUsableCard` is false.
   */
  readonly cardWithheldByCvvPrompt?: boolean;
  /** A shipping address is configured. */
  readonly hasShippingAddress: boolean;
  /**
   * This request came from the owner speaking directly, in this turn.
   *
   * Not "a request arrived", a schedule, a trigger or a channel message is not
   * an instruction to spend money. See security/untrusted-content.ts: those
   * surfaces carry no command authority at all.
   */
  readonly isOwnerDirectRequest: boolean;
  /**
   * The owner's live standing authorisation this purchase was admitted under
   * (payments/host/standing-store.ts), when nobody asked for it in the moment.
   * Set only by the host after it matched the item, merchant and amount to the
   * entry; it is what lets a scheduled or triggered purchase past the origin
   * gate, and nothing else.
   */
  readonly standingAuthorizationId?: string | undefined;
  /**
   * This daemon may serve payments: it runs alone, or it holds the group's
   * payments role (cluster/roles.ts), which the cluster election gives to
   * exactly one machine at a time.
   *
   * Required, never defaulted: on a clustered install a wrong `true` is two
   * machines spending at once.
   */
  readonly isPaymentsLeader: boolean;
  /**
   * The name of the machine that holds the payments role, when this one does
   * not; null while the group is still electing one. Named in the refusal so
   * the owner is referred there.
   */
  readonly paymentsHolder?: string | null | undefined;
}

/** The refusal a machine that does not run payments gives: it names the one that does. */
export function paymentsElsewhereReason(holder: string | null | undefined): string {
  return holder
    ? `Refused: in this group of machines purchases run on one machine at a time, and that is ${holder}. `
      + 'Ask there (its terminal app, web UI or channels); it buys with its own card, address and daily budget.'
    : 'Refused: in this group of machines purchases run on one machine at a time, and the group is choosing it '
      + 'right now. Try again in a few seconds; `goodvibes-daemon cluster status` on any machine shows which one holds payments.';
}

export interface GateRefusal {
  readonly code: RefusalCode;
  readonly reason: string;
}

/**
 * Run the terminal gates in order, returning the first refusal or null.
 *
 * Order matters only for the message the owner reads: the most fundamental
 * reason is reported rather than the first incidental one, so "payments are
 * off" beats "no card configured" when both are true.
 */
export function checkPaymentGates(input: GateInput): GateRefusal | null {
  if (!input.enabled) {
    return {
      code: 'disabled',
      reason:
        'Refused: the payment capability is off. Turn on payments.enabled and set a daily budget '
        + 'before I can buy anything.',
    };
  }
  if (!input.isOwnerDirectRequest && input.standingAuthorizationId === undefined) {
    return {
      code: 'not-owner-request',
      reason:
        'Refused: this purchase was not asked for by you directly and no live standing authorisation of '
        + 'yours covers it. A schedule, a trigger, or a message from a channel cannot authorize spending '
        + 'on its own; you can, in your own words, or in advance with /payments standing add.',
    };
  }
  if (!input.isPaymentsLeader) {
    return { code: 'disabled', reason: paymentsElsewhereReason(input.paymentsHolder) };
  }
  if (!input.hasUsableCard && input.cardWithheldByCvvPrompt === true) {
    return {
      code: 'no-card',
      reason:
        'Refused: payments.cvvHandling is set to prompt, so the card verification value is not '
        + 'stored, and this payment host has no way to ask you for it when a purchase reaches payment. '
        + 'Set payments.cvvHandling to stored (add the card again if it was created under prompt), '
        + 'or buy through the daemon your terminal app is paired with, where /payments pending asks for the code.',
    };
  }
  if (!input.hasUsableCard) {
    return {
      code: 'no-card',
      reason: 'Refused: no usable card is configured. Add one before asking me to buy something.',
    };
  }
  if (!input.hasShippingAddress) {
    return {
      code: 'no-shipping-address',
      reason:
        'Refused: no shipping address is configured, so I have nowhere to have this delivered.',
    };
  }
  return null;
}
