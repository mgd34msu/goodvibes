import { expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { PurchaseRecord } from '@goodvibes-jev/engine/platform/platform/payments';
import { createOrderMailObserver } from '../../runtime/payments-composition.js';
import { createOwnerMailRelay } from '../../runtime/owner-mail-relay.js';

const settled = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

const PURCHASE = {
  purchaseId: 'p1', atUtc: new Date(1_700_000_000_000).toISOString(), merchantDomain: 'bestbuy.com', outcome: 'purchased',
} as PurchaseRecord;

function mail(id: string, senderAddress = 'orders@other-shop.example') {
  return { id, senderAddress, subject: 'Your order', body: 'Thanks', receivedAtMs: 1_700_000_600_000 };
}

function fixture(purchases: readonly PurchaseRecord[]) {
  let lists = 0;
  const delivered: string[] = [];
  const observe = createOrderMailObserver({
    purchases: { list: () => { lists++; return { purchases, total: purchases.length, reconciliations: [] }; } },
    notifier: { deliver: async ({ message }) => { delivered.push(message); return []; } },
  });
  return { observe, delivered, lists: () => lists };
}

test('mail while the ledger is empty is not read and notifies no one', async () => {
  const f = fixture([]);
  f.observe(mail('m1'));
  await settled();
  expect(f.lists()).toBe(1);
  expect(f.delivered).toEqual([]);
});

test('mail from a store nothing was bought at notifies no one', async () => {
  const f = fixture([PURCHASE]);
  f.observe(mail('m1'));
  await settled();
  expect(f.delivered).toEqual([]);
});

test('a message the poll offers again is handled once', async () => {
  const f = fixture([PURCHASE]);
  f.observe(mail('m1'));
  f.observe(mail('m1'));
  f.observe(mail('m2'));
  await settled();
  expect(f.lists()).toBe(2);
});

test('a ledger that cannot be read does not escape the mailbox poll', async () => {
  const observe = createOrderMailObserver({
    purchases: { list: () => { throw new Error('ledger unavailable'); } },
    notifier: { deliver: async () => [] },
  });
  expect(() => observe(mail('m1'))).not.toThrow();
  await settled();
});

test('the relay hands mail to the attached handler and stops after detach', () => {
  const relay = createOwnerMailRelay();
  const seen: string[] = [];
  relay.observe(mail('before'));
  const detach = relay.attach(m => { seen.push(m.id); });
  relay.observe(mail('during'));
  detach();
  relay.observe(mail('after'));
  expect(seen).toEqual(['during']);
});

test('detaching a replaced handler leaves the current one attached', () => {
  const relay = createOwnerMailRelay();
  const seen: string[] = [];
  const detachOld = relay.attach(() => { seen.push('old'); });
  relay.attach(m => { seen.push(m.id); });
  detachOld();
  relay.observe(mail('m1'));
  expect(seen).toEqual(['m1']);
});

/** Reads every yes/no question as yes, the order-mail pick as the first purchase, and every other choice as \"none\" when it has one, so a mail about a purchase is read as confirming it. */
function confirmingPort(): NonNullable<Parameters<typeof installJudgmentPort>[0]> {
  return {
    model: 'jev-1.13.0',
    async ask(request) {
      const answers = Object.fromEntries(Object.entries(request.questions).map(([name, question]) => {
        if (question.type === 'noul') return [name, { type: 'noul', noul: 0.97 }];
        if (question.type !== 'choice') throw new Error('Unexpected fixture question');
        const keys = Object.keys(question.criteria);
        const chosen = request.context?.battery === 'engine.payments.order-mail' ? keys[0] : keys.includes('none') ? 'none' : keys[0];
        if (!chosen) throw new Error('Unexpected fixture choice');
        return [name, { type: 'choice', choice: chosen, confidence: 0.95,
          probabilities: Object.fromEntries(keys.map(key => [key, key === chosen ? 0.95 : 0.05 / Math.max(1, keys.length - 1)])) }];
      }));
      return { answers: answers as never, model: 'jev-1.13.0', requestedModel: 'jev-1.13.0', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 0, requestId: undefined };
    },
  };
}

test('a store mail about the one purchase made there sends the owner a report', async () => {
  const previous = installJudgmentPort(confirmingPort());
  try {
    const f = fixture([{ ...PURCHASE, item: 'thing', currency: 'USD', totalMinorUnits: 100, cardLast4: '4242' } as PurchaseRecord]);
    f.observe(mail('m1', 'orders@bestbuy.com'));
    for (let turn = 0; turn < 200 && f.delivered.length === 0; turn++) await settled();
    expect(f.delivered).toHaveLength(1);
  } finally { installJudgmentPort(previous); }
});
