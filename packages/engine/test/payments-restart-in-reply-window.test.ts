// Proves: A daemon restart while a purchase waits on the owner buys twice, or turns "silence means no" into "silence buys".
// Red when: The resumed approval submits or records twice or not at all, or the restored window reopens as a notice whose silence buys.
// Proves: A stop the owner gave while the daemon was down is not read after the restart, or silence is assumed for a channel whose replies were never received, and the veto's silence buys.
// Red when: The daemon's stop withdraws a kept window's owner-inbox item, or the restored veto window counts silence without first reading the answer the owner recorded there before its deadline.
/**
 * A purchase waiting on the owner survives a daemon restart. The case that
 * matters is the follow-up: the owner answered the "goes ahead unless you stop
 * it" notice with something that was not a go-ahead, so the purchase was put
 * to them again as an approval, where silence means no. A restart during that
 * approval resumes it as that approval: a yes after the restart buys exactly
 * once, and silence buys nothing. It is never reopened as a notice whose silence buys.
 *
 * Real `runCheckout`, the checkpoint the host keeps, `restored-reply-window.ts`,
 * the owner inbox over its SQLite store, and the budget, journal and purchase
 * files. A second set of those objects over the same files is the restarted
 * daemon; the first daemon's stop is its own stop signal. Stand-ins: the
 * merchant (a loopback store that records each order POST), the channel that
 * carried the unclear reply, the card and address stores, and Jev's readings
 * (a fixture port).
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { CardMaterialRedactor } from '../platform/src/platform/payments/card-redaction.ts';
import type { CardMaterial, CardMaterialStore } from '../platform/src/platform/payments/card-material.ts';
import { CheckoutRegistry } from '../platform/src/platform/payments/checkout-registry.ts';
import { runCheckout, type CheckoutControls, type CheckoutFlowDeps, type CheckoutOutcome, type PurchaseRequest } from '../platform/src/platform/payments/checkout-flow.ts';
import { captureCheckoutWindowCheckpoint, type CheckoutWindowCheckpoint } from '../platform/src/platform/payments/checkout-window-checkpoint.ts';
import type { PaymentNotifier, PaymentNoticeWindow } from '../platform/src/platform/payments/payment-ports.ts';
import { PaymentReplyInbox } from '../platform/src/platform/payments/reply-inbox.ts';
import { parseCurrencyCode, unsafeOwnerSuppliedTextForTests, type CardMetadata, type CurrencyCode, type PostalAddress } from '../platform/src/platform/payments/types.ts';
import { DurableBudgetLedger } from '../platform/src/platform/payments/host/budget-store.ts';
import { DurableCheckoutJournal } from '../platform/src/platform/payments/host/checkout-journal-store.ts';
import { DaemonPurchaseLedger } from '../platform/src/platform/payments/host/purchase-ledger.ts';
import { purchaseInboxKey, withOwnerInbox } from '../platform/src/platform/payments/host/notifier.ts';
import { prepareRestoredPaymentReplyWindow } from '../platform/src/platform/payments/host/restored-reply-window.ts';
import { OwnerInbox, type OwnerItem } from '../platform/src/platform/control-plane/owner-inbox.ts';
import { QuestionStore } from '../platform/src/platform/control-plane/question-store.ts';
import { UntrustedContentLedger } from '../platform/src/platform/security/untrusted-content.ts';
import { startFixtureMerchant, type FixtureMerchant } from './helpers/fixture-merchant.ts';
import { FixtureCheckoutDriver, readFixtureCheckout } from './helpers/fixture-checkout-driver.ts';
import { usePaymentsReadings } from './helpers/payments-readings.ts';

usePaymentsReadings();

const ORIGIN = 'https://www.bestbuy.com';
const PURCHASE = 'p-restart';
const usd = parseCurrencyCode('USD') as CurrencyCode;
const CARD: CardMaterial = { number: '4539578763621486', expiryMonth: '07', expiryYear: '2029', cvv: '318', cardholderName: 'Pat Fixture' };
const METADATA: CardMetadata = { id: 'card-1', label: 'Test card', brand: 'visa', last4: '1486', kind: 'virtual',
  expiryMonth: 7, expiryYear: 2029, issuerCapMinorUnits: null, addedAt: '2026-07-01T00:00:00.000Z' };
const ADDRESS: PostalAddress = { name: 'Pat Fixture', line1: '500 Test Street', line2: '', city: 'Detroit', region: 'MI', postalCode: '48226', country: 'US' };
const CONTROLS: CheckoutControls = {
  cardFields: [{ field: 'number', target: 'ccnum' }, { field: 'expiry', target: 'ccexp' }, { field: 'cvv', target: 'cccvv' }, { field: 'cardholderName', target: 'ccname' }],
  shippingTargets: ['ship-standard', 'ship-two-day', 'ship-overnight'],
  placeOrderTarget: 'place',
};
const REQUEST: PurchaseRequest = {
  purchaseId: PURCHASE, merchantDomain: 'www.bestbuy.com', checkoutUrl: `${ORIGIN}/checkout`,
  item: unsafeOwnerSuppliedTextForTests('Mechanical keyboard, tenkeyless'),
  requestedLines: [{ label: 'Mechanical keyboard, tenkeyless', quantity: 1 }], cardId: 'card-1', preferredTier: 'normal',
};

let dir: string;
let merchant: FixtureMerchant;
const closers: Array<() => void | Promise<void>> = [];
beforeEach(async () => {
  dir = makeProjectTempDir('gv-payments-restart');
  merchant = await startFixtureMerchant('alpha');
});
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  await merchant.close();
});

/** One daemon's payment objects over the shared files. */
function daemon(now: () => number) {
  const questions = new QuestionStore({ path: join(dir, 'owner-questions.sqlite') });
  const inbox = new OwnerInbox({ questions });
  closers.push(() => inbox.dispose());
  const stop = new AbortController();
  closers.push(() => stop.abort());
  const ledger = new DurableBudgetLedger(join(dir, 'budget.json'), now);
  const registry = new CheckoutRegistry(new DurableCheckoutJournal(join(dir, 'checkout-journal.json')));
  const cards: CardMaterialStore = { metadata: async () => METADATA, read: async () => CARD };
  const deps = (notifier: PaymentNotifier): CheckoutFlowDeps => ({
    registry, cards, redactor: new CardMaterialRedactor(),
    driver: new FixtureCheckoutDriver({ merchant, pageUrl: `${ORIGIN}/checkout` }),
    ledger, purchases: new DaemonPurchaseLedger({ filePath: join(dir, 'purchases.json') }),
    addresses: { read: async () => ADDRESS },
    notifier: withOwnerInbox(notifier, inbox, kind => kind === 'approval' ? 60 : 10),
    untrusted: new UntrustedContentLedger(),
    merchantJudge: { judge: async () => ({ qualifies: true, confident: true, recourse: 'established retailer with a returns process' }) },
    limits: { dailyItemMinorUnits: 500_000, dailyOverageMinorUnits: 500_000,
      perPurchaseCeiling: { enabled: false, minorUnits: 0 }, overageTolerance: { enabled: false, dailyAllowanceMinorUnits: 0 } },
    budgetCurrency: usd, timezone: 'UTC',
    gates: { enabled: true, hasUsableCard: true, hasShippingAddress: true, isOwnerDirectRequest: true, isPaymentsLeader: true },
    approvalMinutes: 60, vetoMinutes: 10, now, signal: stop.signal,
    // A daemon stop leaves the open window for the next start to resume.
    keepWindowOnStop: () => true,
  });
  return { inbox, stop, deps };
}

/**
 * The channel side of the notices: the veto notice gets a reply Jev did not
 * read as a go-ahead; any later window hears nothing until the daemon stops.
 */
function channel(vetoAnswer: 'not-understood' | null | 'quiet'): PaymentNotifier {
  const quiet = (signal: AbortSignal | undefined) => new Promise<never>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  return {
    deliver: async () => [],
    awaitAnswer: async () => null,
    prepareWindow: (input): PaymentNoticeWindow => ({
      deliveries: Promise.resolve([]),
      cancel: () => {},
      awaitAnswer: async () => input.kind === 'veto' && vetoAnswer !== 'quiet'
        ? vetoAnswer === null ? null : { answer: vetoAnswer, channel: 'telegram' }
        : quiet(input.signal),
    }),
  };
}

/**
 * The first daemon runs the purchase until the follow-up approval is armed and
 * its checkpoint kept, then stops. Returns the checkpoint as the host stored it.
 */
async function firstDaemonStopsDuringFollowUp(now: () => number, window: 'approval' | 'veto' = 'approval'): Promise<CheckoutWindowCheckpoint> {
  const first = daemon(now);
  const file = join(dir, 'window-checkpoint.json');
  let armed!: () => void;
  const followUpArmed = new Promise<void>(resolve => { armed = resolve; });
  const run = runCheckout(REQUEST, await readFixtureCheckout(merchant), CONTROLS, {
    ...first.deps(channel(window === 'approval' ? 'not-understood' : 'quiet')),
    retainWindowCheckpoint: async checkpoint => {
      writeFileSync(file, JSON.stringify(checkpoint));
      if (checkpoint.record.windowKind === window) armed();
    },
  });
  const settled = run.then(() => 'returned', () => 'stopped');
  await Promise.race([followUpArmed, settled]);
  first.stop.abort();
  expect(await settled).toBe('stopped');
  expect(merchant.submissions).toHaveLength(0);
  const checkpoint = captureCheckoutWindowCheckpoint(JSON.parse(readFileSync(file, 'utf8')));
  expect(checkpoint.record).toMatchObject(window === 'approval' ? { windowKind: 'approval', windowHeldReply: true } : { windowKind: 'veto' });
  return checkpoint;
}

/** The restarted daemon resumes the purchase from the kept checkpoint. */
function restartedDaemon(now: () => number, checkpoint: CheckoutWindowCheckpoint) {
  const next = daemon(now);
  const replies = new PaymentReplyInbox();
  closers.push(() => replies.close());
  const inboxDelivery = checkpoint.record.windowDeliveries?.find(delivery => delivery.channel === 'owner-inbox');
  if (!inboxDelivery) throw new Error('The follow-up was not posted to the owner inbox');
  const run = (): Promise<CheckoutOutcome> => readFixtureCheckout(merchant).then(reading => runCheckout(REQUEST, reading, CONTROLS, {
    ...next.deps(channel(null)),
    resumeWindow: {
      checkpoint,
      prepare: owner => prepareRestoredPaymentReplyWindow({
        purchaseId: PURCHASE, checkpoint, recipients: [], readHistory: undefined, replies,
        router: { deliver: async () => { throw new Error('No channel recipient to notify again'); } },
        signal: owner.signal ?? next.stop.signal, assertCurrent: () => owner.assertCurrent?.(), renewMinutes: 60,
        inbox: { port: next.inbox, key: purchaseInboxKey(PURCHASE, checkpoint.record.windowKind ?? 'approval'), delivery: inboxDelivery },
      }),
    },
  }));
  return { inbox: next.inbox, run };
}

function budget(now: () => number) {
  const ledger = new DurableBudgetLedger(join(dir, 'budget.json'), now);
  const limits = { dailyItemMinorUnits: 500_000, dailyOverageMinorUnits: 500_000,
    perPurchaseCeiling: { enabled: false, minorUnits: 0 }, overageTolerance: { enabled: false, dailyAllowanceMinorUnits: 0 } };
  const pools = ledger.snapshot(limits, now(), 'UTC');
  return { spent: pools.item.spent + pools.overage.spent, reserved: pools.item.reserved + pools.overage.reserved };
}

test('a yes to the follow-up approval after a restart buys exactly once', async () => {
  const now = () => Date.now();
  const checkpoint = await firstDaemonStopsDuringFollowUp(now);
  const restarted = restartedDaemon(now, checkpoint);
  // The owner answers the approval the restarted daemon is waiting on: the item the stop left open, or the one posted again.
  const answered = new Promise<void>(resolve => {
    const answer = (item: OwnerItem): boolean => {
      if (item.key !== purchaseInboxKey(PURCHASE, 'approval') || item.status !== 'open') return false;
      void restarted.inbox.answer(item.id, { option: 'approve' }).then(() => resolve());
      return true;
    };
    const open = restarted.inbox.listNow({ status: 'open' }).find(answer);
    if (open) return;
    const stop = restarted.inbox.subscribe((item: OwnerItem) => { if (answer(item)) stop(); });
  });
  const outcome = await restarted.run();
  await answered;
  expect(outcome.kind).toBe('purchased');
  expect(merchant.submissions).toHaveLength(1);
  expect(new DaemonPurchaseLedger({ filePath: join(dir, 'purchases.json') }).list({ limit: 10, dayKey: undefined }).total).toBe(1);
  expect(budget(now)).toEqual({ spent: checkpoint.record.totalMinorUnits ?? Number.NaN, reserved: 0 });
});

test('silence on the follow-up approval across a restart buys nothing and frees the money', async () => {
  // The first daemon ran two hours ago, so the approval's deadline passed while it was down.
  const earlier = Date.now() - 2 * 60 * 60_000;
  const now = () => earlier;
  const checkpoint = await firstDaemonStopsDuringFollowUp(now);
  expect(checkpoint.record.windowDeadlineMs).toBeLessThan(Date.now());
  const outcome = await restartedDaemon(now, checkpoint).run();
  expect(outcome.kind).toBe('refused');
  expect(merchant.submissions).toHaveLength(0);
  expect(new DaemonPurchaseLedger({ filePath: join(dir, 'purchases.json') }).list({ limit: 10, dayKey: undefined }).total).toBe(0);
  expect(budget(now)).toEqual({ spent: 0, reserved: 0 });
});

test('a stop the owner recorded while the daemon was down is read after the restart; without it the veto\'s silence buys once', async () => {
  // The veto window opened two hours ago, so its deadline passed while the daemon was down.
  const earlier = Date.now() - 2 * 60 * 60_000;
  const now = () => earlier;
  const checkpoint = await firstDaemonStopsDuringFollowUp(now, 'veto');
  // A terminal app answers the inbox item a minute into the window, while the daemon is down.
  const terminal = new OwnerInbox({ questions: new QuestionStore({ path: join(dir, 'owner-questions.sqlite') }), now: () => earlier + 60_000 });
  closers.push(() => terminal.dispose());
  const item = terminal.listNow({ status: 'open' }).find(entry => entry.key === purchaseInboxKey(PURCHASE, 'veto'))!;
  expect((await terminal.answer(item.id, { option: 'stop' })).applied).toBe(true);
  expect((await restartedDaemon(now, checkpoint).run()).kind).toBe('cancelled');
  expect(merchant.submissions).toHaveLength(0);
  expect(budget(now)).toEqual({ spent: 0, reserved: 0 });

  // Control: the same restart with nothing recorded lets the veto's silence buy, once.
  dir = makeProjectTempDir('gv-payments-restart');
  const unanswered = await firstDaemonStopsDuringFollowUp(now, 'veto');
  expect((await restartedDaemon(now, unanswered).run()).kind).toBe('purchased');
  expect(merchant.submissions).toHaveLength(1);
});
