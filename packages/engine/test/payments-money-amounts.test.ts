/**
 * Money amounts: an owner's limit is the number they would say out loud, it is
 * enforced as an exact whole count of the currency's smallest unit, and a page
 * amount is never read at a hundred or a thousand times its value, in either
 * direction. Pure functions over the real parsers and the real settings manager.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { MAX_MONEY_AMOUNT, parseMoneyAmount } from '../platform/src/platform/config/money-value.ts';
import { readBudgetLimits } from '../platform/src/platform/payments/payments-config.ts';
import { extractCheckout } from '../platform/src/platform/payments/checkout-extraction.ts';
import { parseMinorUnits, parseRequestedMaximum } from '../platform/src/platform/payments/money-parsing.ts';
import { parseCurrencyCode } from '../platform/src/platform/payments/types.ts';

/** The daemon's own settings manager: the one that writes payment limits. */
function makeManager(): ConfigManager {
  const home = makeProjectTempDir('gv-money-home');
  const configDir = join(home, '.goodvibes', 'tui');
  mkdirSync(configDir, { recursive: true });
  return new ConfigManager({ configDir, homeDir: home, surfaceRoot: 'tui', daemonTierPath: join(home, '.goodvibes', 'daemon', 'settings.json'), ownsDaemonTier: true });
}

function budgetReader(values: Record<string, unknown>): { get(key: string): unknown } {
  return { get: (key: string): unknown => values[key] };
}

function currency(code: string) {
  const parsed = parseCurrencyCode(code); if (!parsed) throw new Error(`Invalid fixture currency ${code}`);
  return parsed;
}

// ─── The grammar ───────────────────────────────────────────────────────────

describe('what an amount setting accepts', () => {
  test('a whole number is the number', () => {
    expect(parseMoneyAmount(100)).toEqual({ ok: true, value: 100 });
    expect(parseMoneyAmount('100')).toEqual({ ok: true, value: 100 });
    expect(parseMoneyAmount(0)).toEqual({ ok: true, value: 0 });
  });

  test('a decimal is kept exactly as written: nothing is padded to two places', () => {
    expect(parseMoneyAmount('19.99')).toEqual({ ok: true, value: 19.99 });
    expect(parseMoneyAmount('100.5')).toEqual({ ok: true, value: 100.5 });
    expect(parseMoneyAmount(0.29)).toEqual({ ok: true, value: 0.29 });
  });

  test('a leading currency symbol is tolerated and dropped', () => {
    expect(parseMoneyAmount('$100')).toEqual({ ok: true, value: 100 });
    expect(parseMoneyAmount('£19.99')).toEqual({ ok: true, value: 19.99 });
    expect(parseMoneyAmount('€ 250.50')).toEqual({ ok: true, value: 250.5 });
  });

  test('thousands grouping is tolerated, because people write numbers that way', () => {
    expect(parseMoneyAmount('1,250')).toEqual({ ok: true, value: 1250 });
    expect(parseMoneyAmount('$12,500.75')).toEqual({ ok: true, value: 12500.75 });
  });

  test('anything that is not one non-negative amount is refused', () => {
    for (const bad of ['lots', '', 'abc', '1.2.3', '-5', -5, Number.NaN, Number.POSITIVE_INFINITY, true, null]) {
      expect(parseMoneyAmount(bad).ok).toBe(false);
    }
  });

  test('more decimal places than an amount can carry is refused', () => {
    expect(parseMoneyAmount('100.555').ok).toBe(false);
    expect(parseMoneyAmount(100.555).ok).toBe(false);
  });

  test('a figure past the ceiling on the ceiling is refused', () => {
    expect(parseMoneyAmount(MAX_MONEY_AMOUNT).ok).toBe(true);
    expect(parseMoneyAmount(MAX_MONEY_AMOUNT + 1).ok).toBe(false);
  });

});

// ─── Setting one ───────────────────────────────────────────────────────────

describe('setting an amount', () => {
  test('a decimal or a currency symbol is stored as the amount typed', () => {
    const manager = makeManager();
    manager.set('payments.budget.dailyItem', 19.99);
    manager.set('payments.budget.dailyOverage', '$40' as unknown as number);
    expect(manager.get('payments.budget.dailyItem')).toBe(19.99);
    expect(manager.get('payments.budget.dailyOverage')).toBe(40);
  });

  test('garbage or too many decimal places is refused rather than coerced or rounded', () => {
    const manager = makeManager();
    manager.set('payments.budget.dailyItem', 25);
    expect(() => manager.set('payments.budget.dailyItem', 'lots' as unknown as number)).toThrow();
    expect(() => manager.set('payments.budget.dailyItem', 100.555)).toThrow();
    expect(manager.get('payments.budget.dailyItem')).toBe(25);
  });
});

// ─── What enforcement reads ────────────────────────────────────────────────

describe('enforcement reads the new form', () => {
  test('an amount becomes an exact whole count of the currency\'s smallest division', () => {
    const limits = readBudgetLimits(
      budgetReader({
        'payments.budget.dailyItem': 100,
        'payments.budget.dailyOverage': 19.99,
        'payments.budget.perPurchaseCeiling': 0.29,
        'payments.budget.overageToleranceDailyAllowance': 2.5,
      }),
      'USD',
    );

    expect(limits.dailyItemMinorUnits).toBe(10_000);
    expect(limits.dailyOverageMinorUnits).toBe(1999);
    expect(limits.perPurchaseCeiling.minorUnits).toBe(29);
    expect(limits.overageTolerance.dailyAllowanceMinorUnits).toBe(250);
  });

  test('a limit set through the manager is the limit enforcement sees', () => {
    const manager = makeManager();
    manager.set('payments.budget.perPurchaseCeiling', 100);

    const limits = readBudgetLimits(
      { get: (key: string): unknown => manager.get(key as Parameters<typeof manager.get>[0]) },
      'USD',
    );
    // A hundred, enforced as a hundred, not as one dollar, which is what the
    // old keys produced when he typed what he meant.
    expect(limits.perPurchaseCeiling.minorUnits).toBe(10_000);
  });

  test('an unreadable setting falls back to nothing-allowed rather than being coerced', () => {
    const limits = readBudgetLimits(
      budgetReader({ 'payments.budget.dailyItem': 'lots', 'payments.budget.dailyOverage': -5 }),
      'USD',
    );
    expect(limits.dailyItemMinorUnits).toBe(0);
    expect(limits.dailyOverageMinorUnits).toBe(0);
  });
});

describe('discount lines on a checkout', () => {
  test('a promotion is read as its own line and subtracted, so the page total agrees', () => {
    const usd = currency('USD');
    const reading = { lines: [{ label: 'Cable', quantity: '1', unitPrice: '$10.00' }], tax: null, fees: [],
      shippingOptions: [{ label: 'Standard', cost: '$4.99' }], statedTotal: '$9.99', currency: 'USD', orderSummaryText: 'Cable' };
    expect(extractCheckout(reading, usd)).toMatchObject({ ok: false, field: 'statedTotal' });
    for (const amount of ['-$5.00', '−5.00', '($5.00)', '5.00', 'USD -5.00']) {
      const result = extractCheckout({ ...reading, discounts: [{ label: 'SPRING5', amount }] }, usd);
      expect(result).toMatchObject({ ok: true, checkout: { discountMinorUnits: 500, subtotalMinorUnits: 500 } });
    }
  });

  test('a discount larger than the items is refused rather than becoming a credit', () => {
    const usd = currency('USD');
    const result = extractCheckout({ lines: [{ label: 'Cable', quantity: '1', unitPrice: '$10.00' }], tax: null, fees: [],
      discounts: [{ label: 'Gift card', amount: '-$12.00' }], shippingOptions: [{ label: 'Standard', cost: '$0.00' }],
      statedTotal: null, currency: 'USD', orderSummaryText: 'Cable' }, usd);
    expect(result).toMatchObject({ ok: false, field: 'discounts' });
  });
});

describe('three-decimal currencies on a checkout', () => {
  test('a price written with three decimals is that price, as the owner\'s maximum is', () => {
    expect(parseMinorUnits('KWD 0.750', 'KWD')).toBe(750);
    expect(parseMinorUnits('12.500', 'KWD')).toBe(12_500);
    expect(parseMinorUnits('1.234', 'KWD')).toBe(parseRequestedMaximum('1.234', currency('KWD')));
    expect(parseMinorUnits('1,234.500', 'KWD')).toBe(1_234_500);
    expect(parseMinorUnits('1.234', 'USD')).toBe(123_400);
  });

  test('the page decides a three-digit group, and a page that cannot is refused', () => {
    const kwd = currency('KWD');
    const reading = { lines: [{ label: 'Tea', quantity: '2', unitPrice: 'KWD 0.750' }], tax: null, fees: [],
      shippingOptions: [{ label: 'Standard', cost: '1.000' }], statedTotal: '2.500', currency: 'KWD', orderSummaryText: 'Tea' };
    expect(extractCheckout(reading, kwd)).toMatchObject({ ok: true, checkout: { itemMinorUnits: 1_500, subtotalMinorUnits: 1_500 } });
    const grouped = { ...reading, lines: [{ label: 'Rug', quantity: '1', unitPrice: '1,234' }], shippingOptions: [{ label: 'Standard', cost: '5' }] };
    expect(extractCheckout({ ...grouped, statedTotal: '1,239.000' }, kwd)).toMatchObject({ ok: true, checkout: { itemMinorUnits: 1_234_000 } });
    expect(extractCheckout({ ...grouped, statedTotal: null }, kwd)).toMatchObject({ ok: false, field: 'amounts' });
  });

  test('a three-decimal amount written with grouping and no decimals is never read as a fraction', () => {
    // "1,234" dinars is 1,234 whole dinars on a page that writes "." for the
    // fraction; read as 1.234 it would be a thousandth of the real price.
    expect(parseMinorUnits('1,234', 'KWD')).toBeNull();
    expect(parseMinorUnits('KWD 1,234', 'KWD')).toBeNull();
    expect(parseMinorUnits('1,234', 'KWD', '.')).toBe(1_234_000);
    expect(parseMinorUnits('1,234,567', 'KWD')).toBe(1_234_567_000);
    const kwd = currency('KWD');
    const page = { lines: [{ label: 'Rug', quantity: '1', unitPrice: 'KWD 1,234' }], tax: null, fees: [],
      shippingOptions: [{ label: 'Standard', cost: '5' }], statedTotal: null, currency: 'KWD', orderSummaryText: 'Rug' };
    expect(extractCheckout(page, kwd)).toMatchObject({ ok: false });
    expect(extractCheckout({ ...page, statedTotal: '1,239.000' }, kwd)).toMatchObject({ ok: true, checkout: { itemMinorUnits: 1_234_000 } });
  });
});
