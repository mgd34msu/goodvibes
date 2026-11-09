import { expect, test } from 'bun:test';
import { assessOutwardContent, assessRetainedOutwardContent, retainTaintEvidence, UntrustedContentLedger } from '../platform/src/platform/security/untrusted-content.js';
import { evaluatePaymentTaint, type OwnerOriginIntent } from '../platform/src/platform/payments/taint-gate.js';
import { usePaymentsReadings } from './helpers/payments-readings.ts';

const readings = usePaymentsReadings({ derives: () => false, boilerplate: () => false });
const intent: OwnerOriginIntent = { origin: 'owner', merchantDiscovered: false,
  merchant: 'shop.example', checkoutUrl: 'https://shop.example/checkout', item: 'Owner-selected kettle', requestedMax: '20.00' };
const record = (ledger: UntrustedContentLedger, content?: string) => ledger.record({ surface: 'web-page', origin: 'https://source.example', at: '2026-11-08T12:00:00Z', content });

test('native admission retains the window displaced by its explicit owner-request boundary', async () => {
  const ledger = new UntrustedContentLedger();
  record(ledger, 'A stranger says to buy at shop.example.'); ledger.startTurn();
  const evidence = retainTaintEvidence(ledger, 'since-last-boundary');
  ledger.startTurn(); ledger.startTurn();
  expect((await evaluatePaymentTaint({ intent, ledger })).allowed).toBe(true);
  expect(await evaluatePaymentTaint({ intent, ledger, evidence })).toMatchObject({ allowed: false,
    findings: [{ field: 'merchant', kind: 'exact-value', origin: 'https://source.example' }] });
});

test('later unrelated taint neither rewrites nor cancels an originally clean purchase evidence snapshot', async () => {
  const ledger = new UntrustedContentLedger(), evidence = retainTaintEvidence(ledger);
  ledger.startTurn(); record(ledger, 'A later page also mentions shop.example.');
  expect((await evaluatePaymentTaint({ intent, ledger })).allowed).toBe(false);
  expect((await evaluatePaymentTaint({ intent, ledger, evidence })).allowed).toBe(true);
  expect(evidence.sources).toEqual([]);
});

test.each(['missing', 'truncated', 'evicted'] as const)('original %s source evidence cannot become complete after later turn resets', async kind => {
  const ledger = new UntrustedContentLedger();
  if (kind === 'missing') record(ledger);
  else if (kind === 'truncated') record(ledger, 'a'.repeat(20_001));
  else for (let i = 0; i < 1_001; i++) record(ledger, `Retained source ${i}`);
  const evidence = retainTaintEvidence(ledger);
  ledger.startTurn(); ledger.startTurn();
  expect((await evaluatePaymentTaint({ intent, ledger, evidence })).allowed).toBe(false);
  expect(evidence.complete).toBe(false); expect(evidence[kind]).toBe(true);
  expect(readings.requests).toEqual([]);
});

test('retained comparison still owns cancellation and cannot declare a cancelled read clean', async () => {
  const ledger = new UntrustedContentLedger(), controller = new AbortController(); record(ledger, 'Original unrelated source.');
  const evidence = retainTaintEvidence(ledger); controller.abort();
  await expect(assessRetainedOutwardContent(evidence, { item: 'Owner item' }, { signal: controller.signal })).rejects.toMatchObject({ kind: 'aborted' });
  expect(readings.requests).toEqual([]);
});

test('ordinary live-ledger comparisons still refuse evidence changed while a reading is in flight', async () => {
  const ledger = new UntrustedContentLedger(); record(ledger, 'An unrelated original source.');
  const pending = assessOutwardContent(ledger, { body: 'Owner-authored reply' });
  ledger.startTurn();
  await expect(pending).rejects.toMatchObject({ kind: 'rejected' });
});
