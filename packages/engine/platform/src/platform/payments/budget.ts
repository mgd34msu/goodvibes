/**
 * budget.ts, the three daily pools, and why drawing on them is a two-step.
 *
 * ── The pools ─────────────────────────────────────────────────────────────
 *
 *  - ITEM      the item price is checked against this.
 *  - OVERAGE   only charges that cannot be avoided on an approved purchase:
 *              sales tax, mandatory handling or booking fees, and the delivery
 *              option actually used. Discretionary add-ons, expedited shipping
 *              beyond what the ladder picks, insurance, gift wrap, extended
 *              warranties, are purchase decisions, not delivery costs, and are
 *              never charged here.
 *  - TOLERANCE the shortfall when the overage pool cannot cover even the
 *              cheapest delivery. Default OFF with a zero allowance, so
 *              enabling it without setting an amount changes nothing.
 *
 * ── Why reserve-then-commit rather than check-then-charge ────────────────
 *
 * Two purchases evaluated at the same time can each individually fit what
 * remains and together exceed it. A veto window makes that likely rather than
 * theoretical: it is minutes wide by design, and the second purchase is decided
 * while the first is still waiting. So a decision TAKES a reservation, and the
 * money is unavailable to anything else from that moment until the purchase
 * either commits or releases.
 *
 * Checkout reservations remain held until commit or a known-safe release,
 * including across restarts. Elapsed time cannot prove that a charge failed.
 *
 * ── Currency ──────────────────────────────────────────────────────────────
 *
 * Every hold and spend records the currency it was made in (money.ts: an
 * amount is minor units IN a currency). A pool counts only what was spent in
 * the currency its limits are in, so changing `payments.currency` starts a new
 * pool for the rest of the day, and what was spent earlier that day is shown
 * in its own currency (`earlierSpend`), never re-read as the new one.
 */
import { dayKey, resolveTimezone, type DayKey } from './day.js';
import { samePaymentEvidence } from './evidence-equality.js';
import type { BudgetPool, CurrencyCode, MinorUnits } from './types.js';
import type { PaymentStoreStop } from './payment-host-health.js';

export interface BudgetLimits {
  /** The currency every amount here, and every pool they bound, is in. */
  readonly currency: CurrencyCode;
  readonly dailyItemMinorUnits: MinorUnits;
  readonly dailyOverageMinorUnits: MinorUnits;
  readonly perPurchaseCeiling: {
    readonly enabled: boolean;
    readonly minorUnits: MinorUnits;
  };
  readonly overageTolerance: {
    readonly enabled: boolean;
    readonly dailyAllowanceMinorUnits: MinorUnits;
  };
}

/** One completed draw. Keeps its UTC instant so totals can be re-derived. */
export interface SpendRecord {
  readonly purchaseId: string;
  readonly atMs: number;
  /** The currency the amounts are in: the budget's when the purchase was decided. */
  readonly currency: CurrencyCode;
  readonly itemMinorUnits: MinorUnits;
  readonly overageMinorUnits: MinorUnits;
  readonly toleranceMinorUnits: MinorUnits;
  /** The zone in force when the purchase was decided, and the calendar day the
   * spend was made on in it. Fixed at the spend, so a later timezone change
   * cannot move it out of that day. Absent on records from before they were kept. */
  readonly timezone?: string;
  readonly dayKey?: DayKey;
}

export interface BudgetReservation {
  readonly id: string;
  readonly dayKey: DayKey;
  /** The currency the held amounts are in. */
  readonly currency: CurrencyCode;
  readonly itemMinorUnits: MinorUnits;
  readonly overageMinorUnits: MinorUnits;
  readonly toleranceMinorUnits: MinorUnits;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  /** The zone `dayKey` was reckoned in. Absent on holds from before it was kept. */
  readonly timezone?: string;
  /** A live/uncertain checkout owns this hold until explicit settlement.
   * TTL and day rollover cannot make an unresolved charge spendable again. */
  readonly retainUntilSettled?: true;
}

/** What today spent in a currency other than the budget's: shown in its own currency, never counted in today's pools. */
export interface EarlierCurrencySpend {
  readonly currency: CurrencyCode;
  readonly item: MinorUnits;
  readonly overage: MinorUnits;
  readonly tolerance: MinorUnits;
}

export interface PoolSnapshot {
  readonly dayKey: DayKey;
  readonly timezone: string;
  /** The currency of every pool here (the budget's). */
  readonly currency: CurrencyCode;
  /** Present when today also spent in another currency before `payments.currency` changed. */
  readonly earlierSpend?: readonly EarlierCurrencySpend[];
  readonly item: { readonly limit: MinorUnits; readonly spent: MinorUnits; readonly reserved: MinorUnits; readonly remaining: MinorUnits };
  readonly overage: { readonly limit: MinorUnits; readonly spent: MinorUnits; readonly reserved: MinorUnits; readonly remaining: MinorUnits };
  readonly tolerance: { readonly limit: MinorUnits; readonly spent: MinorUnits; readonly reserved: MinorUnits; readonly remaining: MinorUnits };
}

/**
 * TTL for ordinary temporary reservations. A checkout-owned reservation ignores
 * it: configured windows and unknown merchant outcomes have no safe age limit.
 */
export const RESERVATION_TTL_MS = 4 * 60 * 60 * 1000;

/** Refuse new reservations at capacity; never evict another purchase's hold. */
export const MAX_RESERVATIONS = 256;

export interface BudgetStateSnapshot {
  readonly spend: readonly SpendRecord[];
  readonly reservations: readonly BudgetReservation[];
  readonly reconciliations?: readonly CheckoutBudgetSettlement[];
}
/** Durable once-only accounting receipt. Kept independently of daily spend
 * pruning so an old interrupted owner reconciliation cannot run twice. */
export interface CheckoutBudgetSettlement {
  readonly operationId: string;
  readonly purchaseId: string;
  readonly outcome: 'purchased' | 'not-purchased';
  readonly atMs: number;
  readonly reservation: BudgetReservation | null;
  readonly spend: SpendRecord | null;
}
/** Construction-owned continuity around one bookkeeping transition. */
export interface CheckoutBudgetSettlementOwner {
  assertCurrent(): void;
  settled(reservation: BudgetReservation | null, spend: SpendRecord | null, receipt: CheckoutBudgetSettlement): void;
}

const RECONCILIATION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Whether a draw made at `atMs`, on `recordedDay` in `recordedZone`, still
 * counts against today. It does while its own day has not ended in the zone it
 * was made in, while today's date in the current zone is the date it was made
 * on, and while it falls inside today in the current zone. A timezone change
 * can therefore only keep a draw counted longer, never let it go before its
 * own day is over.
 */
function countsToday(
  atMs: number,
  recordedZone: string | undefined,
  recordedDay: DayKey | undefined,
  today: DayKey,
  timezone: string,
  todayIn: (zone: string) => DayKey,
): boolean {
  if (dayKey(atMs, timezone) === today) return true;
  if (recordedDay === undefined) return false;
  if (recordedDay === today) return true;
  return recordedZone !== undefined && todayIn(recordedZone) === recordedDay;
}

/**
 * The pools, over a set of spend records and live reservations.
 *
 * Deliberately not a running counter: `snapshot()` reads each spend record's
 * own day every time it is asked. A spend keeps the day it was made on in the
 * zone then in force, so changing `daemon.timezone` cannot refill a spent pool
 * before that day is over, see `countsToday` and day.ts.
 */
/**
 * What the other machines of a group spent, and where this machine's own
 * spend is told to them (the authority record's per-day spend counter). A
 * group's daily budget is spent once in the group, not once per machine that
 * held the payments role that day.
 */
export interface GroupSpendSource {
  /** What every OTHER machine has spent on `day` in `currency`, from the record. */
  othersSpent(day: DayKey, currency: CurrencyCode): { readonly item: MinorUnits; readonly overage: MinorUnits; readonly tolerance: MinorUnits };
  /** This machine's whole spend on `day` in `currency`; written to the record (one slot per machine, only ever raised). */
  publish(day: DayKey, currency: CurrencyCode, own: { readonly item: MinorUnits; readonly overage: MinorUnits; readonly tolerance: MinorUnits }): void;
}

export class BudgetLedger {
  /** Why durable accounting stopped itself; an in-memory ledger never does. */
  stopped(): PaymentStoreStop | null { return null; }

  private group: GroupSpendSource | null = null;

  /** Count the group's spend in every pool from now on, and tell the group this machine's own. */
  attachGroupSpend(source: GroupSpendSource | null): void {
    this.group = source;
    if (!source) return;
    const pairs = new Map<string, { day: DayKey; currency: CurrencyCode }>();
    for (const record of this.spend) {
      if (record.dayKey !== undefined) pairs.set(`${record.dayKey}\u0000${record.currency}`, { day: record.dayKey, currency: record.currency });
    }
    for (const { day, currency } of pairs.values()) this.publishDay(day, currency);
  }

  /** This machine's spend on `day` in `currency`, told to the group. */
  protected publishDay(day: DayKey, currency: CurrencyCode): void {
    if (!this.group) return;
    let item = 0, overage = 0, tolerance = 0;
    for (const record of this.spend) {
      if (record.dayKey !== day || record.currency !== currency) continue;
      item += record.itemMinorUnits; overage += record.overageMinorUnits; tolerance += record.toleranceMinorUnits;
    }
    this.group.publish(day, currency, { item, overage, tolerance });
  }

  private spend: SpendRecord[] = [];
  private reservations: BudgetReservation[] = [];
  private reconciliations: CheckoutBudgetSettlement[] = [];

  constructor(initial?: BudgetStateSnapshot) {
    if (initial !== undefined) {
      this.spend = initial.spend.map(record => Object.freeze({ ...record }));
      this.reservations = initial.reservations.map(record => Object.freeze({ ...record }));
      this.reconciliations = (initial.reconciliations ?? []).map(record => Object.freeze({ ...record,
        reservation: record.reservation === null ? null : Object.freeze({ ...record.reservation }),
        spend: record.spend === null ? null : Object.freeze({ ...record.spend }) }));
    }
  }

  snapshot(limits: BudgetLimits, nowMs: number, timezone: string): PoolSnapshot {
    const today = dayKey(nowMs, timezone);
    const days = new Map<string, DayKey>([[timezone, today]]);
    const todayIn = (zone: string): DayKey => {
      let day = days.get(zone);
      if (day === undefined) { day = dayKey(nowMs, zone); days.set(zone, day); }
      return day;
    };
    // What the other machines of the group spent today counts against the same pools.
    const currency = limits.currency;
    const others = this.group?.othersSpent(today, currency) ?? { item: 0, overage: 0, tolerance: 0 };
    let itemSpent = others.item;
    let overageSpent = others.overage;
    let toleranceSpent = others.tolerance;
    const earlier = new Map<CurrencyCode, { item: MinorUnits; overage: MinorUnits; tolerance: MinorUnits }>();
    for (const record of this.spend) {
      if (!countsToday(record.atMs, record.timezone, record.dayKey, today, timezone, todayIn)) continue;
      if (record.currency !== currency) {
        // Spent before the currency changed: shown in its own currency, never counted in these pools.
        const sum = earlier.get(record.currency) ?? { item: 0, overage: 0, tolerance: 0 };
        sum.item += record.itemMinorUnits; sum.overage += record.overageMinorUnits; sum.tolerance += record.toleranceMinorUnits;
        earlier.set(record.currency, sum);
        continue;
      }
      itemSpent += record.itemMinorUnits;
      overageSpent += record.overageMinorUnits;
      toleranceSpent += record.toleranceMinorUnits;
    }

    let itemReserved = 0;
    let overageReserved = 0;
    let toleranceReserved = 0;
    for (const reservation of this.reservations) {
      // A hold in another currency binds no pool of this one; it settles in its own.
      if (reservation.currency !== currency) continue;
      if (reservation.retainUntilSettled !== true
        && (reservation.expiresAtMs <= nowMs
          || (reservation.dayKey !== today && (reservation.timezone === undefined || todayIn(reservation.timezone) !== reservation.dayKey)))) continue;
      itemReserved += reservation.itemMinorUnits;
      overageReserved += reservation.overageMinorUnits;
      toleranceReserved += reservation.toleranceMinorUnits;
    }

    const toleranceLimit = limits.overageTolerance.enabled
      ? limits.overageTolerance.dailyAllowanceMinorUnits
      : 0;

    return {
      dayKey: today,
      timezone,
      currency,
      ...(earlier.size === 0 ? {} : { earlierSpend: [...earlier].map(([spentIn, sum]) => Object.freeze({ currency: spentIn, ...sum })) }),
      item: pool(limits.dailyItemMinorUnits, itemSpent, itemReserved),
      overage: pool(limits.dailyOverageMinorUnits, overageSpent, overageReserved),
      tolerance: pool(toleranceLimit, toleranceSpent, toleranceReserved),
    };
  }

  /**
   * Hold budget for a purchase in flight.
   *
   * Returns null when the draw does not fit what remains, the caller must treat
   * that as the decision, never as a reason to charge anyway.
   */
  reserve(input: {
    readonly id: string;
    readonly itemMinorUnits: MinorUnits;
    readonly overageMinorUnits: MinorUnits;
    readonly toleranceMinorUnits: MinorUnits;
    readonly limits: BudgetLimits;
    readonly nowMs: number;
    readonly timezone: string;
    readonly ttlMs?: number;
    readonly retainUntilSettled?: true;
  }): BudgetReservation | null {
    // A reservation belongs to one purchase. Never create a second hold with
    // the same ID: releasing a failed attempt could otherwise release another's.
    if (this.reservations.some(entry => entry.id === input.id)
      || this.spend.some(entry => entry.purchaseId === input.id)
      || this.reservations.length >= MAX_RESERVATIONS) return null;
    const snapshot = this.snapshot(input.limits, input.nowMs, input.timezone);
    if (input.itemMinorUnits > snapshot.item.remaining) return null;
    if (input.overageMinorUnits > snapshot.overage.remaining) return null;
    if (input.toleranceMinorUnits > snapshot.tolerance.remaining) return null;

    const reservation: BudgetReservation = Object.freeze({
      id: input.id,
      dayKey: snapshot.dayKey,
      currency: input.limits.currency,
      itemMinorUnits: input.itemMinorUnits,
      overageMinorUnits: input.overageMinorUnits,
      toleranceMinorUnits: input.toleranceMinorUnits,
      createdAtMs: input.nowMs,
      expiresAtMs: input.nowMs + (input.ttlMs ?? RESERVATION_TTL_MS),
      timezone: resolveTimezone(input.timezone),
      ...(input.retainUntilSettled === true ? { retainUntilSettled: true as const } : {}),
    });
    this.reservations.push(reservation);
    return reservation;
  }

  /** The purchase happened. The reservation becomes a spend record. */
  commit(reservationId: string, atMs: number): SpendRecord | null {
    const index = this.reservations.findIndex((entry) => entry.id === reservationId);
    if (index === -1) return null;
    const [reservation] = this.reservations.splice(index, 1);
    if (reservation === undefined) return null;
    const record: SpendRecord = spendFromHold(reservation, atMs);
    this.spend.push(record);
    if (record.dayKey !== undefined) this.publishDay(record.dayKey, record.currency);
    return record;
  }

  /** The purchase did not happen. The money goes back. */
  release(reservationId: string): boolean {
    const index = this.reservations.findIndex((entry) => entry.id === reservationId);
    if (index === -1) return false;
    this.reservations.splice(index, 1);
    return true;
  }

  /**
   * Reclaim reservations whose purchase died, and report what was reclaimed.
   *
   * Returns the swept entries rather than a count, because the platform rule for
   * anything persisted across restarts is that its recoveries are DISCLOSED,
   * an audit record naming what was reclaimed, not a silent tidy-up.
   */
  sweep(nowMs: number): readonly BudgetReservation[] {
    const expired = this.reservations.filter((entry) => entry.retainUntilSettled !== true && entry.expiresAtMs <= nowMs);
    if (expired.length > 0) {
      this.reservations = this.reservations.filter((entry) => entry.retainUntilSettled === true || entry.expiresAtMs > nowMs);
    }
    return expired;
  }

  state(): BudgetStateSnapshot {
    return { spend: [...this.spend], reservations: [...this.reservations],
      ...(this.reconciliations.length === 0 ? {} : { reconciliations: [...this.reconciliations] }) };
  }

  /** Apply the original hold and its receipt together. The daemon persists
   * this whole snapshot in one atomic write, rather than inferring a previous
   * settlement from the absence of a reservation after a crash. */
  settleReconciliation(receipt: CheckoutBudgetSettlement, owner?: CheckoutBudgetSettlementOwner): void {
    owner?.assertCurrent();
    const previous = this.reconciliations.find(row => row.operationId === receipt.operationId);
    if (previous) {
      if (!samePaymentEvidence(previous, receipt)) throw new Error('The original payment accounting settlement differs.');
      return;
    }
    const held = this.reservations.find(row => row.id === receipt.purchaseId) ?? null;
    const spent = this.spend.find(row => row.purchaseId === receipt.purchaseId) ?? null;
    if (!samePaymentEvidence(held, receipt.reservation) || !samePaymentEvidence(spent, receipt.spend)) throw new Error('The original payment accounting changed.');
    // A purchase recorded as bought with no hold and no spend would leave the budget uncharged.
    if (receipt.outcome === 'purchased' && !held && !spent) throw new Error('The original payment hold and spend are both missing, so this purchase cannot be settled as bought without charging the budget.');
    // Save, then publish: the next ledger is computed here, written by
    // persistSettlement, and only then told to the owner; a failed write puts
    // the ledger back as it was and throws, so memory never runs ahead of disk.
    const before = { reservations: this.reservations, spend: [...this.spend], reconciliations: [...this.reconciliations] };
    let finalSpend = spent;
    if (held) {
      if (spent || held.retainUntilSettled !== true || held.id !== receipt.purchaseId) throw new Error('The original payment hold is unavailable.');
      this.reservations = this.reservations.filter(row => row !== held);
      if (receipt.outcome === 'purchased') {
        finalSpend = spendFromHold(held, receipt.atMs);
        this.spend.push(finalSpend);
        if (finalSpend.dayKey !== undefined) this.publishDay(finalSpend.dayKey, finalSpend.currency);
      }
    }
    const stored = Object.freeze({ ...receipt, reservation: held === null ? null : Object.freeze({ ...held }),
      spend: spent === null ? null : Object.freeze({ ...spent }) });
    this.reconciliations.push(stored);
    try {
      this.persistSettlement(owner);
    } catch (error) {
      this.reservations = before.reservations;
      this.spend = before.spend;
      this.reconciliations = before.reconciliations;
      throw error;
    }
    owner?.settled(null, finalSpend, stored);
    owner?.assertCurrent();
  }

  /** Writes a settlement before it is published. Memory ledgers have no durable sink; the daemon's writes its file here and throws when it could not. */
  protected persistSettlement(_owner?: CheckoutBudgetSettlementOwner): void {}

  /** Ensure preceding settlement is durable before removing its crash journal.
   * Memory ledgers have no durable sink; the daemon overrides this boundary. */
  flush(assertCurrent?: () => void): void { assertCurrent?.(); }

  /**
   * Drop spend records that can no longer affect any pool.
   *
   * Anything older than two days cannot be "today" in any timezone on earth
   * (the widest real offset span is under 27 hours), so retaining more is a
   * daemon-lifetime leak with no decision riding on it. The audit ledger, not
   * this, is the long-term record.
   */
  prune(nowMs: number, retainPendingSpend?: (purchaseId: string) => boolean): void {
    const cutoff = nowMs - 2 * 24 * 60 * 60 * 1000;
    // Receipts only guard a replayed reconciliation, which finds nothing left to settle once its
    // hold is gone; keeping them past this window grows the persisted snapshot without bound.
    this.reconciliations = this.reconciliations.filter(record => record.atMs >= nowMs - RECONCILIATION_RETENTION_MS);
    const settled = new Set(this.reconciliations.map(record => record.purchaseId));
    this.spend = this.spend.filter(record => record.atMs >= cutoff
      || (!settled.has(record.purchaseId) && retainPendingSpend?.(record.purchaseId) === true));
  }
}

/**
 * The spend a hold becomes. It keeps the day it was made on: the day of `atMs`
 * in the zone the hold was decided in.
 */
export function spendFromHold(hold: BudgetReservation, atMs: number): SpendRecord {
  const zone = hold.timezone;
  return Object.freeze({
    purchaseId: hold.id,
    atMs,
    currency: hold.currency,
    itemMinorUnits: hold.itemMinorUnits,
    overageMinorUnits: hold.overageMinorUnits,
    toleranceMinorUnits: hold.toleranceMinorUnits,
    ...(zone === undefined ? {} : { timezone: zone, dayKey: dayKey(atMs, zone) }),
  });
}

function pool(
  limit: MinorUnits,
  spent: MinorUnits,
  reserved: MinorUnits,
): { limit: MinorUnits; spent: MinorUnits; reserved: MinorUnits; remaining: MinorUnits } {
  return { limit, spent, reserved, remaining: Math.max(0, limit - spent - reserved) };
}

/**
 * The item limit, raised by exactly this purchase's shortfall.
 *
 * Used only for a purchase the decision layer classified as needing the owner's
 * yes, and only so the money can be HELD while they are asked. It grants nothing:
 * a denial or a silence releases the reservation in full, and the pool it was
 * held against is otherwise unchanged, so the next purchase is measured against
 * the same daily limit it always was.
 *
 * Returns the limits object unchanged when nothing needs raising, so the common
 * path, over the per-purchase CEILING but still inside the daily pool, takes
 * a perfectly ordinary reservation.
 */
export function admitApprovedItemOverdraw(
  limits: BudgetLimits,
  itemMinorUnits: MinorUnits,
  itemRemaining: MinorUnits,
): BudgetLimits {
  const shortfall = itemMinorUnits - itemRemaining;
  if (shortfall <= 0) return limits;
  return { ...limits, dailyItemMinorUnits: limits.dailyItemMinorUnits + shortfall };
}
