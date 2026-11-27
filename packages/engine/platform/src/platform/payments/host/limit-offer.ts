/**
 * limit-offer.ts, the owner's chance to set a spending limit they never set.
 *
 * The daily item budget and the per-purchase ceiling ship at 0, so every
 * purchase asks the owner first. The first time a purchase meets one of them
 * at 0, the owner inbox gets one question for that limit, answered with the
 * amount; the daemon that posted it writes the answer to the setting. It is
 * asked once per limit: a later purchase never posts it again, whether the
 * question is still open, was answered, or was taken back because the limit
 * was set some other way. An answer that is not an amount (or a setting that
 * would not take it) is followed by the question again, saying why.
 *
 * Cost: nothing on a purchase within set limits. A purchase meeting an unset
 * limit reads the inbox's cached rows once; the first one adds one row write.
 * While a question is open the inbox's change feed is heard (no polling) and
 * each purchase compares the limit with 0; an answer is one row write (the
 * claim) and one settings write. Start-up reads the cached rows once, so an
 * answer given from a terminal app while the daemon was down is applied.
 */
import type { NewOwnerItem, OwnerItem } from '../../control-plane/owner-inbox.js';
import { parseMoneyAmount } from '../../config/money-value.js';
import type { ExceededLimit } from '../decide.js';
import { logger } from '../../utils/logger.js';

/** The two settings a purchase can meet unset (0). */
export type OfferableLimitSetting = 'payments.budget.dailyItem' | 'payments.budget.perPurchaseCeiling';

const OFFERABLE: readonly OfferableLimitSetting[] = ['payments.budget.dailyItem', 'payments.budget.perPurchaseCeiling'];

const KEY_PREFIX = 'payments-limit-offer:';

/** The owner-inbox key of the offer for `setting`. */
export function limitOfferKey(setting: OfferableLimitSetting): string {
  return `${KEY_PREFIX}${setting}`;
}

/** The part of the owner inbox (control-plane/owner-inbox.ts) the offer uses. */
export interface LimitOfferInbox {
  postNow(item: NewOwnerItem): { readonly item: OwnerItem };
  latestByKey(kind: 'question', key: string): OwnerItem | undefined;
  subscribe(listener: (item: OwnerItem) => void): () => void;
  /** Marks the answer taken by this process: true for the first taker (owner-inbox.ts take). */
  take(id: string): boolean;
  /** The taken answers were applied: they are delivered and no process takes them again. */
  confirmDelivered(ids: readonly string[]): void;
  withdraw(id: string, reason: string): unknown;
}

/** Where the limits are read and the owner's answer is written. */
export interface LimitOfferSettings {
  get(key: OfferableLimitSetting): unknown;
  set(key: OfferableLimitSetting, value: number): void;
}

export interface LimitOffers {
  /**
   * Called after each purchase decision with the limit it did not fit, if any:
   * offers to set a limit met unset, and takes back an open offer whose limit
   * was set since.
   */
  observe(exceeded: ExceededLimit | undefined): void;
  close(): void;
}

const DECLINES: ReadonlySet<string> = new Set(['0', 'no']);

function offerableSetting(setting: string | undefined): OfferableLimitSetting | undefined {
  return OFFERABLE.find((candidate) => candidate === setting);
}

function settingOfKey(key: string | undefined): OfferableLimitSetting | undefined {
  return key !== undefined && key.startsWith(KEY_PREFIX) ? offerableSetting(key.slice(KEY_PREFIX.length)) : undefined;
}

function isSet(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function offerItem(setting: OfferableLimitSetting, currency: string, problem?: string): NewOwnerItem {
  const ceiling = setting === 'payments.budget.perPurchaseCeiling';
  const what = ceiling ? 'the per-purchase ceiling' : 'the daily item budget';
  const most = ceiling ? 'one purchase may come to in total' : 'may be spent on items in one day';
  return {
    kind: 'question',
    key: limitOfferKey(setting),
    title: ceiling ? 'Set your per-purchase ceiling?' : 'Set your daily item budget?',
    detail: [
      ...(problem !== undefined ? [problem, ''] : []),
      `A purchase asked you first because ${what} (${setting}) is not set, and while it is 0 every purchase asks you.`,
      `Answer with the most that ${most}, in ${currency}, for example 50 or 19.99. Purchases within it then go ahead without asking; one over it still asks.`,
      'Answer 0 or no to keep being asked about every purchase. You can change it later in /settings.',
    ].join('\n'),
    askedBy: 'payments',
  };
}

/**
 * The daemon's limit offers over its owner inbox. `currency` is read when an
 * offer is posted, so the question names the budget's currency.
 */
export function createLimitOffers(inbox: LimitOfferInbox, settings: LimitOfferSettings, currency: () => string): LimitOffers {
  /** Open offers by setting, so a purchase compares the limit with 0 only while one is open. */
  const open = new Map<OfferableLimitSetting, string>();
  let unsubscribe: (() => void) | null = null;

  const listen = (): void => {
    if (open.size > 0 && unsubscribe === null) unsubscribe = inbox.subscribe(heard);
    if (open.size === 0 && unsubscribe !== null) { unsubscribe(); unsubscribe = null; }
  };

  const post = (setting: OfferableLimitSetting, problem?: string): void => {
    const { item } = inbox.postNow(offerItem(setting, currency(), problem));
    if (item.status === 'open') open.set(setting, item.id);
    listen();
  };

  const apply = (item: OwnerItem, setting: OfferableLimitSetting): void => {
    // Taking it is the store's once-only mark: of two processes hearing the answer, one writes it;
    // it is delivered at once, so this process does not apply it a second time either.
    if (!inbox.take(item.id)) return;
    inbox.confirmDelivered([item.id]);
    const text = (item.answer?.text ?? item.answer?.option ?? '').trim();
    if (DECLINES.has(text.toLowerCase())) {
      logger.info('The owner kept a spending limit unset; every purchase keeps asking', { setting });
      return;
    }
    const parsed = parseMoneyAmount(text);
    if (!parsed.ok) { post(setting, `"${text.slice(0, 60)}" is not an amount: ${parsed.reason}`); return; }
    try {
      settings.set(setting, parsed.value);
      logger.info('The owner set a spending limit from the owner inbox', { setting });
    } catch (error) {
      post(setting, `Your answer ${parsed.value} was not saved: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  function heard(item: OwnerItem): void {
    const setting = settingOfKey(item.key);
    if (setting === undefined || item.kind !== 'question' || item.status === 'open') return;
    if (open.get(setting) === item.id) open.delete(setting);
    try {
      if (item.status === 'answered') apply(item, setting);
    } catch (error) {
      logger.warn('A spending-limit answer could not be applied', { setting, error: error instanceof Error ? error.message : String(error) });
    }
    listen();
  }

  // An answer given while no daemon ran (a terminal app answers the store itself) is applied now.
  for (const setting of OFFERABLE) {
    try {
      const latest = inbox.latestByKey('question', limitOfferKey(setting));
      if (latest?.status === 'open') open.set(setting, latest.id);
      else if (latest?.status === 'answered') apply(latest, setting);
    } catch (error) {
      logger.warn('Spending-limit offers could not be read at start', { setting, error: error instanceof Error ? error.message : String(error) });
    }
  }
  listen();

  return {
    observe(exceeded) {
      try {
        for (const [setting, id] of open) {
          if (!isSet(settings.get(setting))) continue;
          open.delete(setting);
          inbox.withdraw(id, `${setting} was set, so this is no longer needed.`);
        }
        const setting = exceeded?.unset === true ? offerableSetting(exceeded.setting) : undefined;
        if (setting !== undefined && !open.has(setting) && inbox.latestByKey('question', limitOfferKey(setting)) === undefined) post(setting);
        listen();
      } catch (error) {
        // An offer is a convenience; it never stands in the way of the purchase's own ask.
        logger.warn('A spending-limit offer could not be posted', { error: error instanceof Error ? error.message : String(error) });
      }
    },
    close() {
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
