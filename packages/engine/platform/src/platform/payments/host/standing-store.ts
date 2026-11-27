/**
 * standing-store.ts, the owner's standing authorisations for purchases nobody
 * starts in the moment: "order dog food from shop.example, at most 60 a time and
 * 120 a month, until June".
 *
 * A purchase is normally admitted only when the owner asks for it in their own
 * words, now (gates.ts, `isOwnerDirectRequest`). A scheduled or triggered run
 * has no such request, so without this store it could never buy anything. An
 * entry here is the owner's answer given in advance: created only by the
 * owner's own command (`payments.standing.create`, confirmation-gated, owner-only),
 * it lets a begin that names it pass the origin gate when the item, the
 * merchant and the amount match what the owner wrote. Everything after the origin gate
 * is unchanged: budgets, the per-purchase ceiling, the veto or approval window,
 * the cart and merchant checks all still apply.
 *
 * The item, merchants and maximums are the owner's typed text, so a purchase
 * bound to an entry carries their words, not anything read from a page; the
 * maximum the purchase may come to is the smaller of the entry's per-purchase
 * maximum and what is left of its per-period maximum, and a total above it
 * opens an approval window that silence denies.
 *
 * Spend per period is counted from the payment operations store, the one owner
 * of what each purchase came to: a purchase that ended unbought counts nothing,
 * one that completed counts its total, and one still running (or uncertain)
 * counts the most it may come to. The store keeps only which purchases were
 * admitted under an entry and when.
 *
 * A small document held in memory and written whole on a real change. The
 * file is this machine's own, and only this daemon process writes it.
 */
import { randomBytes } from 'node:crypto';
import { readDocument, writeDocument } from '../../utils/atomic-json-store.js';
import { merchantDomain } from '../merchant-domain.js';
import { minorUnitExponent, parseRequestedMaximum } from '../money-parsing.js';
import { formatMinorUnits } from '../message.js';
import type { CurrencyCode } from '../types.js';

const FILE_VERSION = 1;
/** Entries one owner keeps; a standing order is a deliberate act, not a list that grows on its own. */
export const MAX_STANDING_AUTHORIZATIONS = 32;
/** Merchants one entry may name. */
export const MAX_STANDING_MERCHANTS = 8;
/** The longest period an entry may count spend over. */
export const MAX_STANDING_PERIOD_DAYS = 366;
const DAY_MS = 86_400_000;
const MAX_ITEM_LENGTH = 200;

/** One purchase admitted under an entry. */
export interface StandingAuthorizationUse {
  readonly purchaseId: string;
  readonly atMs: number;
  /** The most this purchase was admitted to come to, in minor units of the entry's currency. */
  readonly capMinorUnits: number;
}

export interface StandingAuthorization {
  readonly id: string;
  /** The owner's words for what may be bought. */
  readonly item: string;
  /** Registrable domains, lower case. */
  readonly merchants: readonly string[];
  readonly currency: string;
  readonly maxPerPurchaseMinorUnits: number;
  readonly maxPerPeriodMinorUnits: number;
  /** Spend is counted over the last this many days. */
  readonly periodDays: number;
  readonly createdAtMs: number;
  /** Null: until the owner removes it. */
  readonly expiresAtMs: number | null;
  readonly uses: readonly StandingAuthorizationUse[];
}

export interface StandingAuthorizationInput {
  readonly item: string;
  readonly merchants: readonly string[];
  readonly maxPerPurchase: string;
  readonly maxPerPeriod: string;
  readonly periodDays: number;
  /** `YYYY-MM-DD` (the end of that day, UTC) or an ISO instant; absent: no expiry. */
  readonly expires?: string | undefined;
}

/** What a purchase under an entry may come to, or why it may not start. */
export type StandingReservation =
  | { readonly ok: true; readonly entry: StandingAuthorization; readonly capMinorUnits: number }
  | { readonly ok: false; readonly reason: string };

/** What one admitted purchase counts against its entry's period, from the operations store. */
export type StandingUseCounter = (use: StandingAuthorizationUse) => number;

export class StandingAuthorizationError extends Error {
  override readonly name = 'StandingAuthorizationError';
  constructor(message: string, readonly kind: 'invalid' | 'full' | 'unavailable') { super(message); }
}

/** An item compared by meaning, not spelling: case and spacing folded. */
export function standingItem(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** An amount as the owner may type it: plain, optionally with the budget currency's code or a currency sign. */
export function readOwnerAmount(raw: string, currency: CurrencyCode): number | null {
  const plain = raw.trim().replace(new RegExp(`^${currency}\\s*|\\s*${currency}$`, 'i'), '').replace(/^[$€£¥]\s*/, '').trim();
  return parseRequestedMaximum(plain, currency);
}

/** Minor units as the plain decimal a begin's `requestedMax` takes ("25.00"). */
export function plainAmount(minorUnits: number, currency: CurrencyCode): string {
  const exponent = minorUnitExponent(currency);
  if (exponent === 0) return String(minorUnits);
  const divisor = 10 ** exponent;
  return `${String(Math.floor(minorUnits / divisor))}.${String(minorUnits % divisor).padStart(exponent, '0')}`;
}

/** An example amount in the owner's currency, for a refusal that says what to type. */
export function plainAmountExample(currency: CurrencyCode): string {
  const exponent = minorUnitExponent(currency);
  return exponent === 0 ? '2500' : `25 or 25.${'0'.repeat(exponent)}`;
}

function isAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function readEntry(value: unknown): StandingAuthorization {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('an entry is not an object');
  const row = value as Record<string, unknown>;
  const { id, item, currency, merchants, uses, maxPerPurchaseMinorUnits, maxPerPeriodMinorUnits, periodDays, createdAtMs, expiresAtMs } = row;
  if (!isText(id) || !isText(item) || !isText(currency)
    || !Array.isArray(merchants) || merchants.length === 0 || !merchants.every(isText)
    || !isAmount(maxPerPurchaseMinorUnits) || !isAmount(maxPerPeriodMinorUnits)
    || !isAmount(periodDays) || periodDays < 1 || !isAmount(createdAtMs)
    || !(expiresAtMs === null || isAmount(expiresAtMs)) || !Array.isArray(uses)) throw new Error('an entry is missing a field');
  const readUses = uses.map((use: unknown): StandingAuthorizationUse => {
    if (!use || typeof use !== 'object' || Array.isArray(use)) throw new Error('a use is not an object');
    const { purchaseId, atMs, capMinorUnits } = use as Record<string, unknown>;
    if (!isText(purchaseId) || !isAmount(atMs) || !isAmount(capMinorUnits)) throw new Error('a use is missing a field');
    return Object.freeze({ purchaseId, atMs, capMinorUnits });
  });
  return Object.freeze({
    id, item, merchants: Object.freeze(merchants.filter(isText)), currency,
    maxPerPurchaseMinorUnits, maxPerPeriodMinorUnits, periodDays, createdAtMs, expiresAtMs,
    uses: Object.freeze(readUses),
  });
}

function readFile(parsed: unknown): readonly StandingAuthorization[] {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('the file is not an object');
  const envelope = parsed as Record<string, unknown>;
  if (envelope['version'] !== FILE_VERSION || !Array.isArray(envelope['entries'])) throw new Error('the file has no entries list of a known version');
  return Object.freeze(envelope['entries'].map(readEntry));
}

function readExpiry(raw: string | undefined, nowMs: number): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const text = raw.trim();
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(text) ? Date.parse(`${text}T23:59:59.999Z`) : Date.parse(text);
  if (!Number.isFinite(ms)) throw new StandingAuthorizationError('expires must be a date such as 2027-06-30. Nothing was added.', 'invalid');
  if (ms <= nowMs) throw new StandingAuthorizationError('expires is already past. Nothing was added.', 'invalid');
  return ms;
}

/** The owner's standing authorisations on this payment host. */
export class DaemonStandingAuthorizations {
  private entries: readonly StandingAuthorization[] | undefined;

  constructor(private readonly filePath: string, private readonly now: () => number = Date.now) {}

  private load(): readonly StandingAuthorization[] {
    if (this.entries) return this.entries;
    try {
      this.entries = readDocument(this.filePath, {
        label: 'payments/standing',
        validate: readFile,
        recovery: 'The standing purchase authorisations start empty: scheduled purchases are refused until the owner adds them again with "Allow a repeat purchase" in the Money place.',
      }) ?? Object.freeze([]);
    } catch {
      throw new StandingAuthorizationError('The standing purchase authorisations could not be read. Nothing was changed; restart the daemon, then check Repeat purchases in the Money place.', 'unavailable');
    }
    return this.entries;
  }

  private save(next: readonly StandingAuthorization[]): void {
    try { writeDocument(this.filePath, { version: FILE_VERSION, entries: next }, { mode: 0o600 }); }
    catch { throw new StandingAuthorizationError('The standing purchase authorisations could not be written. Nothing was changed.', 'unavailable'); }
    this.entries = Object.freeze([...next]);
  }

  /** Every entry, expired ones included until the next change prunes them. */
  list(): readonly StandingAuthorization[] {
    return this.load();
  }

  get(id: string): StandingAuthorization | undefined {
    return this.load().find(entry => entry.id === id);
  }

  /** The entry exists and has not expired. */
  isLive(id: string): boolean {
    const entry = this.get(id);
    return entry !== undefined && (entry.expiresAtMs === null || entry.expiresAtMs > this.now());
  }

  /** What the purchases admitted under an entry count against its current period. */
  spent(entry: StandingAuthorization, count: StandingUseCounter): number {
    const since = this.now() - entry.periodDays * DAY_MS;
    let total = 0;
    for (const use of entry.uses) if (use.atMs > since) total += count(use);
    return total;
  }

  add(input: StandingAuthorizationInput, currency: CurrencyCode): StandingAuthorization {
    const nowMs = this.now();
    const item = input.item.replace(/\s+/g, ' ').trim();
    if (item.length === 0 || item.length > MAX_ITEM_LENGTH) throw new StandingAuthorizationError(`item must be your words for what may be bought, at most ${String(MAX_ITEM_LENGTH)} characters. Nothing was added.`, 'invalid');
    const merchants = [...new Set(input.merchants.map(merchantDomain).filter(merchant => merchant.length > 0))];
    if (merchants.length === 0 || merchants.length > MAX_STANDING_MERCHANTS || merchants.some(merchant => !merchant.includes('.') || /\s/.test(merchant))) {
      throw new StandingAuthorizationError(`merchants must be 1 to ${String(MAX_STANDING_MERCHANTS)} shop domains such as shop.example. Nothing was added.`, 'invalid');
    }
    const perPurchase = readOwnerAmount(input.maxPerPurchase, currency);
    const perPeriod = readOwnerAmount(input.maxPerPeriod, currency);
    if (perPurchase === null || perPurchase === 0) throw new StandingAuthorizationError(`maxPerPurchase must be one amount above zero in ${currency}, such as ${plainAmountExample(currency)}. Nothing was added.`, 'invalid');
    if (perPeriod === null || perPeriod < perPurchase) throw new StandingAuthorizationError(`maxPerPeriod must be one amount in ${currency}, at least the per-purchase maximum. Nothing was added.`, 'invalid');
    if (!Number.isSafeInteger(input.periodDays) || input.periodDays < 1 || input.periodDays > MAX_STANDING_PERIOD_DAYS) {
      throw new StandingAuthorizationError(`periodDays must be a whole number of days from 1 to ${String(MAX_STANDING_PERIOD_DAYS)}. Nothing was added.`, 'invalid');
    }
    const expiresAtMs = readExpiry(input.expires, nowMs);
    const kept = this.load().filter(entry => entry.expiresAtMs === null || entry.expiresAtMs > nowMs);
    if (kept.length >= MAX_STANDING_AUTHORIZATIONS) {
      throw new StandingAuthorizationError(`${String(MAX_STANDING_AUTHORIZATIONS)} standing authorisations are already kept. Stop one under Repeat purchases in the Money place, then add this one. Nothing was added.`, 'full');
    }
    const entry: StandingAuthorization = Object.freeze({
      id: `standing-${randomBytes(4).toString('hex')}`, item, merchants: Object.freeze(merchants), currency: String(currency),
      maxPerPurchaseMinorUnits: perPurchase, maxPerPeriodMinorUnits: perPeriod, periodDays: input.periodDays,
      createdAtMs: nowMs, expiresAtMs, uses: Object.freeze([]),
    });
    this.save([...kept, entry]);
    return entry;
  }

  /** True when an entry was removed. Purchases already admitted under it run on; new ones are refused. */
  remove(id: string): boolean {
    const entries = this.load();
    if (!entries.some(entry => entry.id === id)) return false;
    this.save(entries.filter(entry => entry.id !== id));
    return true;
  }

  /**
   * Bind one purchase to an entry, or say why it cannot be. Synchronous from
   * the check to the write, so two purchases under one entry cannot both take
   * the last of its period. The use is written before the purchase is admitted.
   */
  reserve(request: {
    readonly id: string;
    readonly purchaseId: string;
    readonly merchantDomain: string;
    readonly item: string;
    readonly requestedMaxMinorUnits: number | undefined;
    readonly currency: CurrencyCode;
  }, count: StandingUseCounter): StandingReservation {
    const nowMs = this.now();
    const entry = this.get(request.id);
    const listHint = 'payments.standing.list shows the standing authorisations the owner created.';
    if (!entry) return { ok: false, reason: `There is no standing authorisation ${request.id}. ${listHint}` };
    if (entry.expiresAtMs !== null && entry.expiresAtMs <= nowMs) {
      return { ok: false, reason: `Standing authorisation ${entry.id} expired on ${new Date(entry.expiresAtMs).toISOString().slice(0, 10)}. Ask the owner to add a new one with "Allow a repeat purchase" in the Money place.` };
    }
    if (entry.currency !== String(request.currency)) {
      return { ok: false, reason: `Standing authorisation ${entry.id} was written in ${entry.currency}, and purchases are now made in ${String(request.currency)}. Ask the owner to add it again in ${String(request.currency)}.` };
    }
    const merchant = merchantDomain(request.merchantDomain);
    // Stored merchants are read again the same way, so an entry saved by an earlier reading still matches.
    if (!entry.merchants.some(stored => merchantDomain(stored) === merchant)) {
      return { ok: false, reason: `Standing authorisation ${entry.id} covers ${entry.merchants.join(', ')}, not ${merchant}. Buy from one of those, or ask the owner.` };
    }
    if (standingItem(request.item) !== standingItem(entry.item)) {
      return { ok: false, reason: `Standing authorisation ${entry.id} covers "${entry.item}". Begin with exactly that item text, or ask the owner.` };
    }
    const spent = this.spent(entry, count);
    const left = Math.max(0, entry.maxPerPeriodMinorUnits - spent);
    const currency = request.currency;
    if (left === 0) {
      return { ok: false, reason: `Standing authorisation ${entry.id} allows ${formatMinorUnits(entry.maxPerPeriodMinorUnits, currency)} every ${String(entry.periodDays)} days, and ${formatMinorUnits(spent, currency)} of it is spent or held, so nothing is left for another purchase now. Ask the owner, or wait until earlier purchases fall out of the period.` };
    }
    let cap = Math.min(entry.maxPerPurchaseMinorUnits, left);
    if (request.requestedMaxMinorUnits !== undefined) cap = Math.min(cap, request.requestedMaxMinorUnits);
    const uses = entry.uses.filter(use => use.atMs > nowMs - entry.periodDays * DAY_MS && use.purchaseId !== request.purchaseId);
    const bound: StandingAuthorization = Object.freeze({ ...entry,
      uses: Object.freeze([...uses, Object.freeze({ purchaseId: request.purchaseId, atMs: nowMs, capMinorUnits: cap })]) });
    this.save(this.load().map(row => (row.id === entry.id ? bound : row)));
    return { ok: true, entry: bound, capMinorUnits: cap };
  }

  /** Undo a reservation whose purchase was never admitted. */
  release(id: string, purchaseId: string): void {
    const entries = this.load(), entry = entries.find(row => row.id === id);
    if (!entry || !entry.uses.some(use => use.purchaseId === purchaseId)) return;
    const freed: StandingAuthorization = Object.freeze({ ...entry, uses: Object.freeze(entry.uses.filter(use => use.purchaseId !== purchaseId)) });
    this.save(entries.map(row => (row.id === id ? freed : row)));
  }
}
