/**
 * decide.ts, the decision order, as one pure function over a snapshot.
 *
 * Pure and injectable on purpose: this is the part that must be exercised
 * exhaustively, and a version that needed a browser, a card and a wall clock
 * would be tested thinly and then trusted anyway.
 *
 * ── The order (docs/payments.md §6) ───────────────────────────────────────
 *
 *   0.  GATES, terminal, no approval path, no downgrade path
 *       enabled / card / address / owner request
 *       TAINT: intent derived from untrusted content        → REFUSE
 *       LINK:  checkout url from untrusted content          → validate or REFUSE
 *       currency mismatch, recurring charge                 → REFUSE
 *
 *   1.  ITEM PRICE vs DAILY ITEM BUDGET; FULL TOTAL vs PER-PURCHASE CEILING
 *       over    → ABOVE BUDGET: explicit approval required
 *                 undeliverable → REFUSE ; silence → DENIED
 *       within  → continue
 *
 *   2.  UNAVOIDABLE + PREFERRED SHIPPING vs OVERAGE POOL
 *       exceeds → LADDER: step down one tier at a time
 *                 fits at a lower rung → record the step-down, continue
 *                 nothing fits         → tolerance pool, else REFUSE
 *
 *   2b. FULL TOTAL vs THE CARD'S DECLARED LIMIT, if the owner gave one
 *       over    → REFUSE: the issuer would decline it, no answer changes that
 *   2c. FULL TOTAL vs OWNER'S REQUESTED MAXIMUM, if supplied
 *       over    → explicit approval required; silence never raises the limit
 *   3.  RESERVE
 *   4.  WITHIN BUDGET → VETO WINDOW (silence PROCEEDS)
 *   5.  PAY, with challenge pauses
 *   6.  COMMIT, write the audit record
 *
 * The ladder is ALWAYS attempted before an overage refusal. Owner's words:
 *
 *   "if the notification can't be delivered, under/at budget items get through
 *    while over budget items do not. however, if it is over budget due to
 *    busting the overage budget, attempt to downgrade things like shipping. if
 *    no downgrade is possible, the overbudget item does not go though."
 */
import type { BudgetLimits, PoolSnapshot } from './budget.js';
import { walkShippingLadder, type ShippingLadderResult, type ShippingTiers } from './shipping.js';
import type {
  CurrencyCode,
  MinorUnits,
  RefusalCode,
  ShippingOption,
  ShippingTier,
  BudgetApprovalReason,
} from './types.js';
import { SHIPPING_TIERS } from './types.js';
import { formatMinorUnits } from './message.js';

/** What the checkout quoted, once parsed into integers we trust. */
export interface QuotedTotals {
  readonly itemMinorUnits: MinorUnits;
  readonly taxMinorUnits: MinorUnits;
  /** Mandatory handling or booking fees only. Never a discretionary add-on. */
  readonly mandatoryFeesMinorUnits: MinorUnits;
  readonly currency: CurrencyCode;
  readonly shippingOptions: readonly ShippingOption[];
  /** Which offered option each tier is, as `readShippingTiers` read it. */
  readonly shippingTiers: ShippingTiers;
}

export interface DecisionInput {
  readonly quoted: QuotedTotals;
  readonly limits: BudgetLimits;
  readonly pools: PoolSnapshot;
  readonly budgetCurrency: CurrencyCode;
  readonly preferredTier: ShippingTier;
  /** Owner's maximum for the entire purchase, including tax, fees and delivery. */
  readonly requestedMaximumMinorUnits?: MinorUnits | undefined;
  /** The most the chosen card can be charged at once, as the owner declared it when adding the card. */
  readonly cardLimitMinorUnits?: MinorUnits | null | undefined;
}

/** The owner's limit a purchase did not fit, with the amounts, in the budget currency's minor units. */
export interface ExceededLimit {
  readonly limit: 'daily-item-budget' | 'per-purchase-ceiling' | 'requested-maximum' | 'daily-overage-budget' | 'card-limit';
  /** The setting that holds it, so a surface can offer to change it. */
  readonly setting?: string | undefined;
  /** What the limit allows right now (for a daily budget, what is left of it today). */
  readonly availableMinorUnits: MinorUnits;
  readonly neededMinorUnits: MinorUnits;
  readonly excessMinorUnits: MinorUnits;
  readonly currency: CurrencyCode;
  /** True when the limit is 0 because it was never set; the owner is offered to set it. */
  readonly unset: boolean;
}

export type DecisionOutcome =
  | {
      readonly kind: 'refuse';
      readonly code: RefusalCode;
      readonly reason: string;
      readonly exceeded?: ExceededLimit | undefined;
    }
  | {
      readonly kind: 'needs-approval';
      readonly draw: BudgetDraw;
      readonly shipping: ShippingLadderResult;
      /** Which limit and by how much, with formatted amounts; the owner's notice and any refusal repeat it. */
      readonly reason: string;
      readonly approvalReasons: readonly BudgetApprovalReason[];
      /** The first limit the purchase did not fit, with its amounts. */
      readonly exceeded: ExceededLimit;
    }
  | {
      readonly kind: 'within-budget';
      readonly draw: BudgetDraw;
      readonly shipping: ShippingLadderResult;
    };

export interface BudgetDraw {
  readonly itemMinorUnits: MinorUnits;
  readonly overageMinorUnits: MinorUnits;
  readonly toleranceMinorUnits: MinorUnits;
  readonly totalMinorUnits: MinorUnits;
}

/**
 * Steps 1 and 2 of the order, over an already-gated purchase.
 *
 * Gate 0 lives in its own modules (taint-gate.ts, link validation, cart.ts)
 * because each is a hard refusal with its own evidence and its own message; by
 * the time control reaches here those have all passed.
 */
export function decidePurchase(input: DecisionInput): DecisionOutcome {
  const { quoted, limits, pools } = input;

  if (quoted.currency !== input.budgetCurrency) {
    return {
      kind: 'refuse',
      code: 'currency-mismatch',
      reason:
        `Refused: this checkout is priced in ${quoted.currency} and your budget is in `
        + `${input.budgetCurrency}. I will not convert, the issuer converts at its own rate on its `
        + 'own date, so any number I showed you would not be the number you are charged.',
    };
  }

  // Wording only: an amount the formatter will not render (never expected from the pools) is shown as its integer.
  const money = (amount: MinorUnits): string => Number.isSafeInteger(amount) && amount >= 0 ? formatMinorUnits(amount, quoted.currency) : String(amount);
  // A daily item budget of 0 is the shipped default: nothing is spent without
  // the owner, so every purchase goes to them for a yes (below, as over the
  // daily item budget); the host offers them, once, to set the limit
  // (host/limit-offer.ts), and a refusal names the setting.
  const itemBudgetUnset = limits.dailyItemMinorUnits <= 0;

  const requestedMaximum = input.requestedMaximumMinorUnits;
  if (requestedMaximum !== undefined && (!Number.isSafeInteger(requestedMaximum) || requestedMaximum < 0)) {
    return { kind: 'refuse', code: 'invalid-requested-maximum', reason: 'Refused: the requested maximum must be an exact non-negative amount in the budget currency.' };
  }

  // ── Step 1: item price against the daily item budget ─────────────────
  // The per-purchase ceiling is checked against the full total below, once
  // the delivery option is known: it is "the most one purchase may come to".
  const overDaily = quoted.itemMinorUnits > (itemBudgetUnset ? 0 : pools.item.remaining);

  // ── Step 2: the unavoidable charges, with the ladder ───────────────────
  const fixedUnavoidable = quoted.taxMinorUnits + quoted.mandatoryFeesMinorUnits;
  const overageAvailable = pools.overage.remaining;

  let shipping = walkShippingLadder({
    preferred: input.preferredTier,
    tiers: quoted.shippingTiers,
    fixedUnavoidableMinorUnits: fixedUnavoidable,
    budgetForOverageMinorUnits: overageAvailable,
  });

  let toleranceDraw = 0;

  if (shipping === null) {
    // Nothing fits even at the lowest rung. The tolerance pool is the only
    // remaining path, and it is OFF by default with a zero allowance. The
    // shortfall is measured at the lowest rung offered, standard delivery when
    // it is: tolerance covers the least the checkout can cost, never the tier
    // the owner would have preferred.
    const lowestTier = SHIPPING_TIERS.find((tier) => quoted.shippingTiers.has(tier));
    const lowest = lowestTier === undefined ? null : walkShippingLadder({
      preferred: lowestTier,
      tiers: quoted.shippingTiers,
      fixedUnavoidableMinorUnits: fixedUnavoidable,
      budgetForOverageMinorUnits: Number.MAX_SAFE_INTEGER,
    });
    const preferredOption = quoted.shippingTiers.get(input.preferredTier);
    const ladderAtAnyPrice: ShippingLadderResult | null = lowest === null ? null : {
      ...lowest,
      stepDown: lowest.tier === input.preferredTier || preferredOption === undefined
        ? null
        : {
            from: input.preferredTier,
            to: lowest.tier,
            savedMinorUnits: preferredOption.costMinorUnits - lowest.costMinorUnits,
            reason: 'overage-pool-insufficient',
          },
    };
    if (ladderAtAnyPrice === null) {
      return {
        kind: 'refuse',
        code: 'overage-pool-exhausted',
        reason: quoted.shippingOptions.length === 0
          ? 'Refused: this checkout offers no delivery option, so I cannot work out what the '
            + 'unavoidable charges would be.'
          : 'Refused: I could not tell which of this checkout\'s delivery options is standard or '
            + 'faster, so I cannot choose one within your budget.',
      };
    }
    const lowestDraw = fixedUnavoidable + ladderAtAnyPrice.costMinorUnits;
    const shortfall = lowestDraw - overageAvailable;
    if (!limits.overageTolerance.enabled || shortfall > pools.tolerance.remaining) {
      const overageUnset = limits.dailyOverageMinorUnits <= 0;
      return {
        kind: 'refuse',
        code: 'overage-pool-exhausted',
        reason:
          `Refused: tax, fees and even the lowest delivery option I could choose come to ${money(lowestDraw)} and only `
          + `${money(overageAvailable)} is left in today's overage budget, ${money(shortfall)} short. I stepped delivery all the way `
          + 'down and it still does not fit, so this does not go through.'
          + (overageUnset
            ? ' The daily overage budget is not set (0). Set payments.budget.dailyOverage to what tax, fees and delivery may add in a day, and purchases like this one can go ahead.'
            : ''),
        exceeded: {
          limit: 'daily-overage-budget', setting: 'payments.budget.dailyOverage',
          availableMinorUnits: overageAvailable, neededMinorUnits: lowestDraw, excessMinorUnits: shortfall,
          currency: quoted.currency, unset: overageUnset,
        },
      };
    }
    toleranceDraw = shortfall;
    shipping = ladderAtAnyPrice;
  }

  const overageDraw = Math.min(fixedUnavoidable + shipping.costMinorUnits, overageAvailable);
  const draw: BudgetDraw = {
    itemMinorUnits: quoted.itemMinorUnits,
    overageMinorUnits: overageDraw,
    toleranceMinorUnits: toleranceDraw,
    totalMinorUnits: quoted.itemMinorUnits + fixedUnavoidable + shipping.costMinorUnits,
  };

  // ── Step 2b: the card's own declared limit ──────────────────────────────
  const cardLimit = input.cardLimitMinorUnits;
  if (cardLimit !== undefined && cardLimit !== null && Number.isSafeInteger(cardLimit) && cardLimit >= 0 && draw.totalMinorUnits > cardLimit) {
    const excess = draw.totalMinorUnits - cardLimit;
    return {
      kind: 'refuse',
      code: 'card-limit-exceeded',
      reason: `Refused: this purchase comes to ${money(draw.totalMinorUnits)}, ${money(excess)} over the card's declared limit of ${money(cardLimit)}, `
        + `so the issuer would decline it. Nothing was bought. Pay with another card, or update the card's declared limit if it has changed.`,
      exceeded: { limit: 'card-limit', availableMinorUnits: cardLimit, neededMinorUnits: draw.totalMinorUnits,
        excessMinorUnits: excess, currency: quoted.currency, unset: false },
    };
  }

  const overCeiling = limits.perPurchaseCeiling.enabled && draw.totalMinorUnits > limits.perPurchaseCeiling.minorUnits;
  const aboveBudget = overCeiling || overDaily;
  const approvalReasons: BudgetApprovalReason[] = [];
  if (overDaily) approvalReasons.push('daily-item-budget');
  if (overCeiling) approvalReasons.push('per-purchase-ceiling');
  if (requestedMaximum !== undefined && draw.totalMinorUnits > requestedMaximum) approvalReasons.push('requested-maximum');
  if (approvalReasons.length > 0) {
    const item = quoted.itemMinorUnits;
    const exceeded: ExceededLimit = itemBudgetUnset
      ? { limit: 'daily-item-budget', setting: 'payments.budget.dailyItem', availableMinorUnits: 0, neededMinorUnits: item, excessMinorUnits: item, currency: quoted.currency, unset: true }
      : overCeiling
        ? { limit: 'per-purchase-ceiling', setting: 'payments.budget.perPurchaseCeiling', availableMinorUnits: limits.perPurchaseCeiling.minorUnits,
            neededMinorUnits: draw.totalMinorUnits, excessMinorUnits: draw.totalMinorUnits - limits.perPurchaseCeiling.minorUnits, currency: quoted.currency, unset: limits.perPurchaseCeiling.minorUnits <= 0 }
        : overDaily
          ? { limit: 'daily-item-budget', setting: 'payments.budget.dailyItem', availableMinorUnits: pools.item.remaining,
              neededMinorUnits: item, excessMinorUnits: item - pools.item.remaining, currency: quoted.currency, unset: false }
          : { limit: 'requested-maximum', availableMinorUnits: requestedMaximum!, neededMinorUnits: draw.totalMinorUnits,
              excessMinorUnits: draw.totalMinorUnits - requestedMaximum!, currency: quoted.currency, unset: false };
    const ceiling = exceeded.limit === 'per-purchase-ceiling';
    const reason = exceeded.unset
      ? `${ceiling ? `This purchase comes to ${money(draw.totalMinorUnits)}` : `This item costs ${money(item)}`} and ${ceiling ? 'the per-purchase ceiling' : 'the daily item budget'} is not set (0), so every purchase asks you first. `
        + `Set ${exceeded.setting} to the most you want ${ceiling ? 'one purchase to come to' : 'spent on items in a day'}, and purchases within it will go ahead without asking.`
      : aboveBudget
        ? overCeiling
          ? `This purchase comes to ${money(draw.totalMinorUnits)} and is over the per-purchase ceiling of ${money(limits.perPurchaseCeiling.minorUnits)} by ${money(exceeded.excessMinorUnits)}.`
          : `This item costs ${money(item)} and only ${money(pools.item.remaining)} is left in today's item budget, ${money(exceeded.excessMinorUnits)} short.`
        : `The full purchase total ${money(draw.totalMinorUnits)} exceeds the owner's requested maximum ${money(requestedMaximum!)} by ${money(exceeded.excessMinorUnits)}.`;
    return {
      kind: 'needs-approval',
      draw,
      shipping,
      reason,
      approvalReasons: Object.freeze(approvalReasons),
      exceeded,
    };
  }

  return { kind: 'within-budget', draw, shipping };
}
