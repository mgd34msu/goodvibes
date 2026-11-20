// Proves: A limit that cannot be read enforces nothing, or a page amount is read at a thousand times (or a thousandth of) its value.
// Red when: `readBudgetLimits` passes a non-number or a negative through, or a grouped three-decimal amount with no fraction is guessed instead of refused.
/**
 * Money amounts: an owner's limit is the number they would say out loud, it is
 * enforced as an exact whole count of the currency's smallest unit, and a page
 * amount is never read at a hundred or a thousand times its value, in either
 * direction. Pure functions over the real parsers and the real settings manager.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { readBudgetLimits } from '../platform/src/platform/payments/payments-config.ts';
import { extractCheckout } from '../platform/src/platform/payments/checkout-extraction.ts';
import { parseMinorUnits } from '../platform/src/platform/payments/money-parsing.ts';
import { parseCurrencyCode } from '../platform/src/platform/payments/types.ts';

/** The daemon's settings manager over a scratch home whose daemon settings file holds `budget`, as an owner's hand edit would. */
function settingsWithBudget(budget: Record<string, unknown>): ConfigManager {
  const home = makeProjectTempDir('gv-money-amounts');
  const daemonTierPath = join(home, '.goodvibes', 'daemon', 'settings.json');
  mkdirSync(join(home, '.goodvibes', 'daemon'), { recursive: true });
  mkdirSync(join(home, '.goodvibes', 'goodvibes'), { recursive: true });
  writeFileSync(daemonTierPath, JSON.stringify({ payments: { budget } }));
  return new ConfigManager({ configDir: join(home, '.goodvibes', 'goodvibes'), homeDir: home, surfaceRoot: 'goodvibes',
    daemonTierPath, ownsDaemonTier: true });
}

function currency(code: string) {
  const parsed = parseCurrencyCode(code); if (!parsed) throw new Error(`Invalid fixture currency ${code}`);
  return parsed;
}

// ─── What enforcement reads ────────────────────────────────────────────────

describe('enforcement reads the new form', () => {
  test('an unreadable setting falls back to nothing-allowed rather than being coerced', () => {
    const limits = readBudgetLimits(
      settingsWithBudget({ dailyItem: 'lots', dailyOverage: -5 }),
      currency('USD'),
    );
    expect(limits.dailyItemMinorUnits).toBe(0);
    expect(limits.dailyOverageMinorUnits).toBe(0);
  });
});

describe('three-decimal currencies on a checkout', () => {
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
