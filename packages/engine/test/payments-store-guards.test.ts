/**
 * Payments stores and handlers: the ways a second operation, a failed write or
 * a malformed request used to leave a purchase, a card or the whole store in a
 * state nobody asked for.
 */
import * as fs from 'node:fs';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.js';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../platform/src/platform/daemon/control-plane.js';
import { PairingTokenManager } from '../platform/src/platform/pairing/pairing-token-store.js';
import type { BrowserCheckoutSeam } from '../platform/src/platform/control-plane/routes/browser-composition.js';
import { BudgetLedger, type BudgetLimits } from '../platform/src/platform/payments/budget.js';
import { CardMaterialRedactor } from '../platform/src/platform/payments/card-redaction.js';
import { MemoryCheckoutJournal } from '../platform/src/platform/payments/checkout-registry.js';
import type { CheckoutPageDriver } from '../platform/src/platform/payments/checkout-page.js';
import { classifyMerchant, type MerchantJudgePort } from '../platform/src/platform/payments/merchant-recourse.js';
import { DEFAULT_MARKETPLACE_LISTING_THRESHOLDS } from '../platform/src/platform/payments/marketplace-listing.js';
import type { PaymentNotifier } from '../platform/src/platform/payments/payment-ports.js';
import { readMerchantPolicy } from '../platform/src/platform/payments/payments-config.js';
import { getProcessUntrustedContentLedger } from '../platform/src/platform/security/untrusted-content.js';
import { DaemonApprovalStore, PaymentApprovalStoreError } from '../platform/src/platform/payments/host/approval-store.js';
import { DurableBudgetLedger } from '../platform/src/platform/payments/host/budget-store.js';
import {
  CardStoreUnreadableError,
  DaemonCardStore,
  cardSecretKey,
  newCardId,
  type CardCreateInput,
  type PaymentsSecretStore,
} from '../platform/src/platform/payments/host/card-store.js';
import { DaemonPurchaseLedger } from '../platform/src/platform/payments/host/purchase-ledger.js';
import { DurablePaymentOperations, PaymentOperationStoreError } from '../platform/src/platform/payments/host/operation-store.js';
import {
  ProtectedPaymentRequestError,
  ProtectedPaymentRequests,
  type PaymentRequestStore,
} from '../platform/src/platform/payments/host/protected-requests.js';
import { registerPaymentsMethods, type CheckoutComposition } from '../platform/src/platform/payments/host/register.js';
import type { PaymentOperationView } from '../platform/src/platform/payments/operation-view.js';
import { tryAcquireCrossProcessLock } from '../platform/src/platform/workspace/checkpoint/cross-process-lock.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { protectedPaymentRequest } from './helpers/protected-payment-request.ts';
import { protectedPaymentWindow } from './helpers/protected-payment-window.ts';
import { paymentReplyHistoryBinding } from '../platform/src/platform/payments/reply-history.js';
import { usePaymentsReadings } from './helpers/payments-readings.ts';

usePaymentsReadings();

const noop = () => {};

function gate(): { readonly wait: Promise<void>; release(): void } {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}

// ---------------------------------------------------------------------------
// Card store
// ---------------------------------------------------------------------------

function cardInput(overrides: Partial<CardCreateInput> = {}): CardCreateInput {
  return { label: 'daily', kind: 'virtual', number: '4111111111111111', expiryMonth: 7, expiryYear: 2029,
    cvv: '907', cardholderName: 'A Person', issuerCapMinorUnits: null, ...overrides };
}

function memorySecrets(): PaymentsSecretStore & { readonly values: Map<string, string>; hold: Promise<void> | null } {
  const values = new Map<string, string>();
  const secrets = {
    values,
    hold: null as Promise<void> | null,
    async get(key: string) { if (secrets.hold) await secrets.hold; return values.get(key) ?? null; },
    async set(key: string, value: string) { values.set(key, value); },
    async delete(key: string) { values.delete(key); },
  };
  return secrets;
}

describe('card store: a delete that overlaps another card write', () => {
  let filePath = '';
  let secrets: ReturnType<typeof memorySecrets>;
  const makeStore = (): DaemonCardStore => new DaemonCardStore({ filePath, secrets, cvvHandling: () => 'stored' });
  beforeEach(() => {
    filePath = join(makeProjectTempDir('gv-card-guards'), 'payments-cards.json');
    secrets = memorySecrets();
  });

  test('a card created while a delete is clearing secrets is still listed afterwards', async () => {
    const store = makeStore();
    const doomed = await store.create(cardInput({ label: 'doomed' }));
    const held = gate();
    secrets.hold = held.wait;
    const removal = store.remove(doomed.id);
    const created = await store.create(cardInput({ label: 'new' }));
    secrets.hold = null;
    held.release();
    expect(await removal).toEqual({ deleted: true, secretsCleared: 5 });
    expect(store.list().map((card) => card.id)).toEqual([created.id]);
    expect(await store.materialComplete(created.id)).toBe(true);
  });

  test('two overlapping deletes of different cards leave neither card listed', async () => {
    const store = makeStore();
    const first = await store.create(cardInput({ label: 'a' }));
    const second = await store.create(cardInput({ label: 'b' }));
    const held = gate();
    secrets.hold = held.wait;
    const removeFirst = store.remove(first.id);
    const removeSecond = store.remove(second.id);
    secrets.hold = null;
    held.release();
    await Promise.all([removeFirst, removeSecond]);
    expect(store.list()).toEqual([]);
  });

  test('every derived secret key has the documented shape', async () => {
    const id = newCardId();
    const documented = /^GOODVIBES_PAYMENTS_CARD_CARD_[0-9A-F]{12}_(NUMBER|EXPIRY_MONTH|EXPIRY_YEAR|CVV|CARDHOLDER_NAME)$/;
    for (const field of ['number', 'expiryMonth', 'expiryYear', 'cvv', 'cardholderName'] as const) {
      expect(cardSecretKey(id, field)).toMatch(documented);
    }
  });

  test('a differently spelled id does not clear the live card it normalizes to', async () => {
    const store = makeStore();
    const card = await store.create(cardInput());
    const result = await store.remove(card.id.toUpperCase().replace('-', '_'));
    expect(result).toEqual({ deleted: false, secretsCleared: 0 });
    expect(await store.materialComplete(card.id)).toBe(true);
  });

  test('material a crashed create stranded is still cleared by its exact generated id', async () => {
    const store = makeStore();
    const id = newCardId();
    await secrets.set(cardSecretKey(id, 'number'), '4111111111111111');
    expect(await store.remove(id)).toEqual({ deleted: false, secretsCleared: 1 });
  });

  test.each([
    ['a different version', '{"version":2,"cards":[]}'],
    ['a renamed cards key', '{"version":2,"entries":[]}'],
    ['a document with no version and no cards', '{"entries":[]}'],
    ['a non-object row', '{"version":1,"cards":["x"]}'],
  ])('%s is refused instead of being rewritten as an empty file', async (_name, contents) => {
    writeFileSync(filePath, contents);
    const store = makeStore();
    await expect(store.create(cardInput())).rejects.toBeInstanceOf(CardStoreUnreadableError);
    expect(readFileSync(filePath, 'utf-8')).toBe(contents);
    expect(secrets.values.size).toBe(0);
  });

  test('an empty document and a version 1 file without cards are still an empty store', async () => {
    writeFileSync(filePath, '{}');
    expect(makeStore().list()).toEqual([]);
    writeFileSync(filePath, '{"version":1}');
    expect(makeStore().list()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Budget ledger
// ---------------------------------------------------------------------------

const LIMITS: BudgetLimits = {
  dailyItemMinorUnits: 10_000,
  dailyOverageMinorUnits: 0,
  perPurchaseCeiling: { enabled: false, minorUnits: 0 },
  overageTolerance: { enabled: false, dailyAllowanceMinorUnits: 0 },
};

describe('budget ledger: a release whose write failed is still owed to disk', () => {
  let restore = () => {};
  afterEach(() => restore());

  test('a retry of the failed release writes the file without the reservation', () => {
    const path = join(makeProjectTempDir('gv-budget-guards'), 'payments-budget.json');
    const ledger = new DurableBudgetLedger(path);
    const nowMs = Date.now();
    expect(ledger.reserve({ id: 'hold-1', itemMinorUnits: 1_000, overageMinorUnits: 0, toleranceMinorUnits: 0,
      limits: LIMITS, nowMs, timezone: 'UTC' })).not.toBeNull();
    expect((JSON.parse(readFileSync(path, 'utf-8')) as { reservations: unknown[] }).reservations).toHaveLength(1);

    const actual = fs.fsyncSync;
    const failure = spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      if (fs.fstatSync(fd).isFile()) throw new Error('flush failed');
      actual(fd);
    });
    restore = () => failure.mockRestore();
    expect(() => ledger.release('hold-1')).toThrow();
    restore();

    // The reservation is already gone in memory, so the retry has nothing to
    // release; the write the first call owed must still land.
    expect(ledger.release('hold-1')).toBe(false);
    expect((JSON.parse(readFileSync(path, 'utf-8')) as { reservations: unknown[] }).reservations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Operation store
// ---------------------------------------------------------------------------

function view(purchaseId: string, state: PaymentOperationView['state'] = 'accepted'): PaymentOperationView {
  return { purchaseId, operationId: `operation:${purchaseId}`, state, phase: null, createdAtMs: 1, updatedAtMs: 1,
    outcome: null, totalMinorUnits: null, currency: null };
}

describe('operation store: the index is a record of the file, never the reason it is lost', () => {
  test('an admission that cannot be indexed leaves no published file behind and can be retried', () => {
    const directory = join(makeProjectTempDir('gv-operations-guards'), 'operations');
    const store = new DurablePaymentOperations(directory);
    const held: { release: (() => void) | null } = { release: null };
    expect(() => store.create(view('purchase-a'), 'owner', () => {
      held.release = tryAcquireCrossProcessLock(join(directory, '.index.lock'));
    })).toThrow(PaymentOperationStoreError);
    held.release?.();
    expect(store.get('purchase-a')).toBeNull();
    const writer = store.create(view('purchase-a'), 'owner', noop);
    expect(store.get('purchase-a')?.state).toBe('accepted');
    writer.release();
  });

  test('an admission whose staging file cannot be removed after publication leaves no unindexed file behind', () => {
    const directory = join(makeProjectTempDir('gv-operations-guards'), 'operations');
    const store = new DurablePaymentOperations(directory);
    const real = fs.unlinkSync;
    const failure = spyOn(fs, 'unlinkSync').mockImplementation(((path: fs.PathLike) => {
      if (String(path).includes('.new-')) throw Object.assign(new Error('input/output error'), { code: 'EIO' });
      return real(path);
    }) as typeof fs.unlinkSync);
    try {
      expect(() => store.create(view('purchase-c'), 'owner', noop)).toThrow(PaymentOperationStoreError);
    } finally { failure.mockRestore(); }
    expect(store.get('purchase-c')).toBeNull();
    const writer = store.create(view('purchase-c'), 'owner', noop);
    expect(store.get('purchase-c')?.state).toBe('accepted');
    writer.release();
  });

  test('a terminal state is kept and the writer stays usable when the index is briefly held elsewhere', () => {
    const directory = join(makeProjectTempDir('gv-operations-guards'), 'operations');
    const store = new DurablePaymentOperations(directory);
    const writer = store.create(view('purchase-b'), 'owner', noop);
    const releaseIndex = tryAcquireCrossProcessLock(join(directory, '.index.lock'))!;
    writer.update({ ...view('purchase-b', 'completed'), updatedAtMs: 2 });
    expect(store.get('purchase-b')?.state).toBe('completed');
    writer.read();
    releaseIndex();
    writer.release();
    const index = JSON.parse(readFileSync(join(directory, 'index'), 'utf-8')) as { open: string[] };
    expect(index.open).not.toContain('purchase-b');
  });
});

// ---------------------------------------------------------------------------
// Protected requests
// ---------------------------------------------------------------------------

describe('protected requests: a refusal about one request does not stop the store', () => {
  test('an owner that is no longer current is refused and a later purchase is still retained', async () => {
    const root = join(makeProjectTempDir('gv-protected-guards'), 'requests');
    const store = new ProtectedPaymentRequests(root);
    await expect(store.retain(protectedPaymentRequest('stale-owner'), () => { throw new Error('retired'); }))
      .rejects.toBeInstanceOf(ProtectedPaymentRequestError);
    await store.retain(protectedPaymentRequest('next-purchase'), noop);
    expect(existsSync(root)).toBe(true);
  });

  test('a failed update that left the request unchanged does not stop later purchases', async () => {
    const root = join(makeProjectTempDir('gv-protected-guards'), 'requests');
    let declarations = 0;
    const store = new ProtectedPaymentRequests(root, undefined, () => {
      if (declarations++ === 0) throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
    });
    const first = protectedPaymentRequest('first');
    const window = protectedPaymentWindow(first);
    await store.retain({ ...first, window }, noop);
    const entry = { accountId: '123', userId: '42', conversationId: '-100123', threadId: null, messageId: '52', updateId: '91',
      replyToMessageId: '51', sentAtMs: 3000, receivedAtMs: 4000, text: 'Hold on' };
    const binding = paymentReplyHistoryBinding(window);
    await expect(store.appendReply(first.purchaseId, first.operationId, binding, entry, noop)).rejects.toBeInstanceOf(ProtectedPaymentRequestError);
    await store.appendReply(first.purchaseId, first.operationId, binding, entry, noop);
    await store.retain(protectedPaymentRequest('second'), noop);
  });

  test('running out of descriptors while reading the key fails that call only', async () => {
    const root = join(makeProjectTempDir('gv-protected-guards'), 'requests');
    const store = new ProtectedPaymentRequests(root, () => undefined, () => undefined);
    const first = protectedPaymentRequest('first');
    const window = protectedPaymentWindow(first);
    await store.retain({ ...first, window }, noop);
    const entry = { accountId: '123', userId: '42', conversationId: '-100123', threadId: null, messageId: '52', updateId: '91',
      replyToMessageId: '51', sentAtMs: 3000, receivedAtMs: 4000, text: 'Hold on' };
    const binding = paymentReplyHistoryBinding(window);
    const real = fs.openSync;
    let failures = 0;
    const failure = spyOn(fs, 'openSync').mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
      if (failures === 0 && String(path).endsWith('.key')) { failures += 1; throw Object.assign(new Error('too many open files'), { code: 'EMFILE' }); }
      return (real as (...args: unknown[]) => number)(path, ...rest);
    }) as typeof fs.openSync);
    try {
      await expect(store.appendReply(first.purchaseId, first.operationId, binding, entry, noop)).rejects.toBeInstanceOf(ProtectedPaymentRequestError);
    } finally { failure.mockRestore(); }
    expect(failures).toBe(1);
    await store.appendReply(first.purchaseId, first.operationId, binding, entry, noop);
    await store.retain(protectedPaymentRequest('second'), noop);
  });

  test('a request the store will not accept is refused and a later purchase is still retained', async () => {
    const root = join(makeProjectTempDir('gv-protected-guards'), 'requests');
    const store = new ProtectedPaymentRequests(root);
    const good = protectedPaymentRequest('bad-quantity');
    const bad = { ...good, input: { ...good.input, requestedLines: [{ label: 'x', quantity: 0 }] } };
    await expect(store.retain(bad, noop)).rejects.toBeInstanceOf(ProtectedPaymentRequestError);
    await store.retain(protectedPaymentRequest('next-purchase'), noop);
  });
});

// ---------------------------------------------------------------------------
// Approval store
// ---------------------------------------------------------------------------

describe('approval store: a full store refuses instead of dropping an approval it already reported', () => {
  test('the seventeenth grant is refused and the first stays spendable', () => {
    const store = new DaemonApprovalStore(join(makeProjectTempDir('gv-approval-guards'), 'payments-approvals.json'));
    const action = 'payments.checkout.begin';
    const content = (index: number) => ({ merchant: 'example.invalid', item: `item-${String(index)}`, amount: '20.00' });
    for (let index = 0; index < 16; index += 1) store.grant({ action, content: content(index) });
    let refusal: unknown;
    try { store.grant({ action, content: content(16) }); } catch (error) { refusal = error; }
    expect(refusal).toBeInstanceOf(PaymentApprovalStoreError);
    expect((refusal as PaymentApprovalStoreError).kind).toBe('full');
    expect(store.take({ action, content: content(0) }).approval).not.toBeNull();
    // The refusal is an ordinary answer, not damage: the store keeps working,
    // and the slot the spent approval freed takes the one that was refused.
    store.grant({ action, content: content(16) });
    expect(store.take({ action, content: content(16) }).approval).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Merchant policy
// ---------------------------------------------------------------------------

describe('merchant policy', () => {
  test('an unreadable seller-reputation setting falls back to the shipped bar, not to zero', () => {
    for (const reader of [{ get: () => undefined }, { get: () => 'abc' }, { get: () => -5 }]) {
      const thresholds = readMerchantPolicy(reader).listingThresholds;
      expect(thresholds?.minSellerFeedbackCount).toBe(DEFAULT_MARKETPLACE_LISTING_THRESHOLDS.minSellerFeedbackCount);
      expect(thresholds?.minSellerPositivePercent).toBe(DEFAULT_MARKETPLACE_LISTING_THRESHOLDS.minSellerPositivePercent);
    }
  });

  const neverAsked: MerchantJudgePort = { judge: async () => { throw new Error('the owner added this domain, nothing is asked'); } };

  test('an owner-added marketplace still refuses an auction', async () => {
    const verdict = await classifyMerchant(
      { checkoutHost: 'www.ebay.com', listing: { format: 'auction' } }, neverAsked, { additional: 'ebay.com' },
    );
    expect(verdict.refused).toBe(true);
    expect(verdict.isMajor).toBe(false);
  });

  test('an owner-added marketplace with a fixed-price listing is major without the reputation bar', async () => {
    const verdict = await classifyMerchant(
      { checkoutHost: 'www.ebay.com', listing: { format: 'fixed-price' } }, neverAsked, { additional: 'ebay.com' },
    );
    expect(verdict.isMajor).toBe(true);
    expect(verdict.refused).not.toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const stubDriver: CheckoutPageDriver = {
  identity: () => ({ sessionId: 'stub-session', pageId: 'stub-page' }),
  url: async () => 'https://example.invalid/checkout',
  fill: async () => {},
  fillSecrets: async () => ({ filledTargets: [], failedTarget: null }),
  choose: async () => {},
  submitOrder: async () => ({ url: 'https://example.invalid/checkout', orderId: null, challenge: null, verified: false }),
};
const noopNotifier: PaymentNotifier = { deliver: async () => [], awaitAnswer: async () => null };
const unqualifiedJudge: MerchantJudgePort = { judge: async () => ({ qualifies: false, confident: false, recourse: 'test double' }) };

describe('payments handlers over a real catalog', () => {
  let catalog: GatewayMethodCatalog;
  let pairing: PairingTokenManager;
  let pairedToken: string;
  let settings: Map<string, unknown>;
  let sequence = 0;
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

  async function register(overrides: Partial<CheckoutComposition> = {}): Promise<void> {
    const dir = makeProjectTempDir('gv-handler-guards');
    pairing = new PairingTokenManager(join(dir, 'pairing.json'));
    pairedToken = pairing.mint({ name: 'Synthetic payment owner' }).token;
    settings = new Map<string, unknown>([['payments.enabled', true]]);
    catalog = new GatewayMethodCatalog();
    const seam: BrowserCheckoutSeam = { cardFieldGuard: new CardMaterialRedactor(), driverFor: () => stubDriver, armSubmitApproval: async () => {} };
    const registration = registerPaymentsMethods(catalog, {
      cards: new DaemonCardStore({ filePath: join(dir, 'payments-cards.json'), secrets: memorySecrets(), cvvHandling: () => 'stored' }),
      purchases: new DaemonPurchaseLedger({ filePath: join(dir, 'payments-purchases.json') }),
      budget: new BudgetLedger(),
      config: { get: (key: string) => settings.get(key) },
      isPaymentsLeader: () => true,
      checkout: {
        seam: () => seam, addresses: { read: async () => null }, notifier: noopNotifier, merchantJudge: unqualifiedJudge,
        untrusted: getProcessUntrustedContentLedger(),
        approvals: new DaemonApprovalStore(join(dir, 'payments-approvals.json')),
        journal: new MemoryCheckoutJournal(),
        operations: new DurablePaymentOperations(join(dir, 'operations')),
        requests: new ProtectedPaymentRequests(join(dir, 'requests')),
        ...overrides,
      },
    });
    closers.push(registration.close);
    await registration.ready;
  }

  async function invoke(id: string, body: unknown): Promise<Record<string, unknown>> {
    const helper = new DaemonControlPlaneHelper({ gatewayMethods: catalog, pairingTokens: pairing, authToken: () => 'synthetic-shared',
      userAuth: { validateSession: () => null } } as unknown as DaemonControlPlaneContext);
    const result = await helper.invokeGatewayMethodCall({ methodId: id, authToken: pairedToken, body,
      context: { ...helper.describeAuthenticatedPrincipal(pairedToken), explicitUserRequest: true } });
    const payload = result.body as Record<string, unknown>;
    if (!result.ok) throw Object.assign(new Error(String(payload['error'] ?? 'refused')), { code: payload['code'], status: result.status });
    return payload;
  }

  async function failureOf(id: string, body: unknown): Promise<{ code: string; status: number; message: string }> {
    try {
      await invoke(id, body);
    } catch (error) {
      const record = error as { code?: string; status?: number; message?: string };
      return { code: record.code ?? '', status: record.status ?? 0, message: record.message ?? '' };
    }
    return { code: '', status: 0, message: '' };
  }

  const beginBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    requestId: `guard-purchase-${String(++sequence)}`,
    sessionId: 'session-1', pageId: 'page-1', merchantDomain: 'example.invalid', checkoutUrl: 'https://example.invalid/checkout',
    item: 'a test item', cardId: 'card-that-does-not-exist', requestedMax: '20.00',
    requestedLines: [{ label: 'a test item', quantity: 1 }],
    lines: [{ label: 'a test item', quantity: '1', unitPrice: '1.00' }],
    shippingOptions: [{ label: 'standard', cost: '0.00' }],
    cardFields: [{ field: 'number', ref: 'e1' }],
    placeOrderTarget: 'e9',
    ...overrides,
  });
  const approve = (): Promise<Record<string, unknown>> => invoke('payments.checkout.approve',
    { confirm: true, merchantDomain: 'example.invalid', item: 'a test item', amount: '20.00' });

  test.each([
    ['a requested quantity of zero', { requestedLines: [{ label: 'a test item', quantity: 0 }] }, 'requestedLines[0].quantity'],
    ['more reading lines than a checkout can have', { lines: Array.from({ length: 51 }, () => ({ label: 'x', quantity: '1', unitPrice: '1.00' })) }, 'lines'],
    ['an over-long line label', { lines: [{ label: 'x'.repeat(401), quantity: '1', unitPrice: '1.00' }] }, 'lines[0].label'],
  ])('%s is refused by name before the approval is spent', async (_name, overrides, field) => {
    await register();
    await approve();
    const refusal = await failureOf('payments.checkout.begin', beginBody(overrides));
    expect(refusal.status).toBe(400);
    expect(refusal.code).toBe('INVALID_ARGUMENT');
    expect(refusal.message).toContain(field);
    // The approval survives, so the corrected begin goes through.
    const accepted = await invoke('payments.checkout.begin', beginBody());
    expect(accepted['outcome']).toBe('accepted');
  });

  test('a failure after the approval was spent says so and names the way forward', async () => {
    const failing: PaymentRequestStore = {
      retain: async () => { throw new ProtectedPaymentRequestError(); },
      read: async () => { throw new ProtectedPaymentRequestError(); },
      remove: async () => {},
    };
    await register({ requests: failing });
    settings.set('payments.confirmEveryPurchase', true);
    await approve();
    const refusal = await failureOf('payments.checkout.begin', beginBody());
    expect(refusal.status).toBe(409);
    expect(refusal.message).toContain('approval for this purchase was spent');
    expect(refusal.message).toContain('payments.checkout.approve');
    const next = await failureOf('payments.checkout.begin', beginBody());
    expect(next.code).toBe('OWNER_APPROVAL_REQUIRED');
  });

  test('a card cap that is not a whole non-negative number is refused, not silently dropped', async () => {
    await register();
    const card = { label: 'one', kind: 'virtual', number: '4111111111111111', expiryMonth: 7, expiryYear: 2029, cvv: '907', cardholderName: 'A Person' };
    for (const cap of ['5000', 50.5, -1]) {
      const refusal = await failureOf('payments.cards.create', { ...card, issuerCapMinorUnits: cap });
      expect(refusal.status).toBe(400);
      expect(refusal.message).toContain('issuerCapMinorUnits');
    }
    const created = await invoke('payments.cards.create', { ...card, issuerCapMinorUnits: 5000 });
    expect((created['card'] as Record<string, unknown>)['issuerCapMinorUnits']).toBe(5000);
  });

  test('a default card that no longer exists is reported as no default', async () => {
    await register();
    settings.set('payments.defaultCardId', 'card-deleted-long-ago');
    expect((await invoke('payments.cards.list', {}))['defaultCardId']).toBe('');
    const created = await invoke('payments.cards.create', { label: 'one', kind: 'virtual', number: '4111111111111111',
      expiryMonth: 7, expiryYear: 2029, cvv: '907', cardholderName: 'A Person' });
    const id = (created['card'] as Record<string, unknown>)['id'];
    settings.set('payments.defaultCardId', id);
    expect((await invoke('payments.cards.list', {}))['defaultCardId']).toBe(id);
  });
});
