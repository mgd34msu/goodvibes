import { expect, test } from 'bun:test';
import { BudgetLedger, type BudgetLimits } from '../sdk/src/platform/payments/budget.js';
import { decidePurchase, type DecisionInput } from '../sdk/src/platform/payments/decide.js';
import { windowForPurchase } from '../sdk/src/platform/payments/merchant-recourse.js';
import { parseRequestedMaximum } from '../sdk/src/platform/payments/money-parsing.js';
import { formatMinorUnits, renderApprovalMessage, renderVetoMessage, type PurchaseFacts } from '../sdk/src/platform/payments/message.js';
import { parseCurrencyCode, unsafeOwnerSuppliedTextForTests } from '../sdk/src/platform/payments/types.js';

function input(maximum?: number): DecisionInput {
  const currency = parseCurrencyCode('USD'); if (!currency) throw new Error('Invalid fixture currency');
  const limits: BudgetLimits = { dailyItemMinorUnits: 10_000, dailyOverageMinorUnits: 1_000,
    perPurchaseCeiling: { enabled: false, minorUnits: 0 }, overageTolerance: { enabled: false, dailyAllowanceMinorUnits: 0 } };
  const normal = { rawLabel: 'Standard', costMinorUnits: 200 };
  return { quoted: { itemMinorUnits: 1_000, taxMinorUnits: 100, mandatoryFeesMinorUnits: 50,
    currency, shippingOptions: [normal], shippingTiers: new Map([['normal', normal]]) },
    limits, pools: new BudgetLedger().snapshot(limits, Date.parse('2026-11-08T12:00:00Z'), 'UTC'),
    budgetCurrency: currency, preferredTier: 'normal', requestedMaximumMinorUnits: maximum };
}

test.each([0, 1_000, 1_349])('full payable total above owner maximum %s requires explicit approval', maximum => {
  const result = decidePurchase(input(maximum));
  expect(result).toMatchObject({ kind: 'needs-approval', draw: { totalMinorUnits: 1_350 }, approvalReasons: ['requested-maximum'] });
  expect(windowForPurchase({ aboveBudget: false, aboveRequestedMaximum: true, merchantIsMajor: true })).toBe('approval');
});

test.each([undefined, 1_350, 2_000])('absent, equal or higher maximum %s preserves the ordinary budget decision', maximum => {
  expect(decidePurchase(input(maximum)).kind).toBe('within-budget');
});

test.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('invalid integer owner maximum %s refuses', maximum => {
  expect(decidePurchase(input(maximum))).toMatchObject({ kind: 'refuse', code: 'invalid-requested-maximum' });
});

test('all independent approval causes survive rather than mislabeling a ceiling as a daily budget', () => {
  const original = input(1_000);
  const limits = { ...original.limits, dailyItemMinorUnits: 500, perPurchaseCeiling: { enabled: true, minorUnits: 800 } };
  expect(decidePurchase({ ...original, limits, pools: new BudgetLedger().snapshot(limits, Date.now(), 'UTC') }))
    .toMatchObject({ kind: 'needs-approval', approvalReasons: ['daily-item-budget', 'per-purchase-ceiling', 'requested-maximum'] });
});

test('an owner maximum cannot create an approval escape from exhausted mandatory-charge pools', () => {
  const original = input(0), limits = { ...original.limits, dailyOverageMinorUnits: 0 };
  expect(decidePurchase({ ...original, limits, pools: new BudgetLedger().snapshot(limits, Date.now(), 'UTC') }))
    .toMatchObject({ kind: 'refuse', code: 'overage-pool-exhausted' });
  expect(decidePurchase({ ...original, limits: { ...original.limits, dailyItemMinorUnits: 0 } }))
    .toMatchObject({ kind: 'refuse', code: 'zero-budget' });
});

test.each([
  ['USD', '20.00', 2_000], ['USD', '0', 0], ['USD', ' 20.5 ', 2_050],
  ['JPY', '20', 20], ['JPY', '20.00', null], ['KWD', '20.123', 20_123],
  ['USD', '20.123', null], ['USD', '10 20', null], ['USD', '10+20', null],
  ['USD', '+20', null], ['USD', '-20', null], ['USD', 'up to 20', null],
  ['USD', '10-20', null], ['USD', '1e3', null], ['USD', '1,000', null],
  ['USD', 'EUR 20', null], ['USD', '', null], ['USD', '10000000000000', null],
] as const)('requested maximum %s %s has one exact interpretation', (code, raw, expected) => {
  const currency = parseCurrencyCode(code); if (!currency) throw new Error('Invalid fixture currency');
  expect(parseRequestedMaximum(raw, currency)).toBe(expected);
});

function facts(): PurchaseFacts {
  const original = input(1_000);
  return { merchantDomain: 'shop.example', item: unsafeOwnerSuppliedTextForTests('Original item'),
    itemMinorUnits: 1_000, taxMinorUnits: 100, feesMinorUnits: 50, shippingMinorUnits: 200,
    totalMinorUnits: 1_350, currency: original.budgetCurrency, cardLast4: '4242', shippingTier: 'normal',
    stepDown: null, poolsAfter: original.pools, requestedMaximumMinorUnits: 1_000, approvalReasons: ['requested-maximum'] };
}

test('the exact same owner notice exposes the full total and requested maximum without inventing a daily overrun', () => {
  const notice = renderApprovalMessage(facts(), 60);
  expect(notice).toContain('full total exceeds your requested maximum');
  expect(notice).toContain('TOTAL:    USD 13.50');
  expect(notice).toContain('Requested maximum: USD 10.00');
  expect(notice).not.toContain('remaining daily item budget');
  expect(renderVetoMessage({ ...facts(), requestedMaximumMinorUnits: 2_000 }, 10)).toContain('Requested maximum: USD 20.00');
});

test('merchant-only approval and a generic approval do not claim the item exceeded a budget', () => {
  expect(renderApprovalMessage({ ...facts(), approvalReasons: ['merchant-recourse'] }, 60)).toContain('merchant needs your explicit approval');
  expect(renderApprovalMessage({ ...facts(), approvalReasons: [] }, 60)).toStartWith('Approval needed before this purchase.');
  expect(renderApprovalMessage({ ...facts(), approvalReasons: ['per-purchase-ceiling'] }, 60)).toContain('per-purchase ceiling');
});

test('unsafe amounts cannot be rounded into owner notices', () => {
  expect(() => formatMinorUnits(Number.MAX_SAFE_INTEGER + 1, input().budgetCurrency)).toThrow(RangeError);
});
