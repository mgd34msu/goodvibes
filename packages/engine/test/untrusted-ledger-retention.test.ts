/**
 * The retained window is everything still kept: once the ledger has dropped its
 * oldest ingests to stay bounded, exact-containment evidence over what remains
 * is still complete, while a turn window that reaches past the cap is not.
 */
import { expect, test } from 'bun:test';
import { UntrustedContentLedger } from '../platform/src/platform/security/untrusted-content.ts';

const ingest = (ledger: UntrustedContentLedger, n: number) => ledger.record({
  surface: 'web-page', origin: `https://page-${n}.example`, at: '2026-11-04T00:00:00Z', content: `page text ${n}`,
});

test('retained-window evidence stays complete after more than a thousand ingests', () => {
  const ledger = new UntrustedContentLedger();
  for (let n = 0; n < 1_100; n++) ingest(ledger, n);
  const retained = ledger.captureTaintEvidence('retained');
  expect(retained.complete).toBe(true);
  expect(retained.evicted).toBe(false);
  expect(retained.sources).toHaveLength(1_000);
});

test('a turn window that reaches past the retention cap is still incomplete', () => {
  const ledger = new UntrustedContentLedger();
  for (let n = 0; n < 1_100; n++) ingest(ledger, n);
  const turn = ledger.captureTaintEvidence('turn');
  expect(turn.evicted).toBe(true);
  expect(turn.complete).toBe(false);
});

test('an over-long outgoing field is an incomplete assessment, not a thrown refusal', async () => {
  const { assessOutwardContent } = await import('../platform/src/platform/security/untrusted-content.ts');
  const ledger = new UntrustedContentLedger();
  ingest(ledger, 1);
  const assessment = await assessOutwardContent(ledger, { body: 'x'.repeat(20_001) });
  expect(assessment).toEqual({ kind: 'incomplete', findings: [], reason: 'over-limit' });
});
