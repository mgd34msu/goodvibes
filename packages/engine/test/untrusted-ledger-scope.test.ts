/**
 * A daemon serves several owners from one ledger. One owner's fresh request
 * must not move the turn watermark past what another owner's session read.
 */
import { expect, test } from 'bun:test';
import { UntrustedContentLedger, withUntrustedContentScope } from '../platform/src/platform/security/untrusted-content.ts';

const page = (ledger: UntrustedContentLedger, name: string) => ledger.record({
  surface: 'web-page', origin: `https://${name}.example`, at: '2026-11-04T00:00:00Z', content: `text of ${name}`,
});
const origins = (ledger: UntrustedContentLedger, scope: string) => withUntrustedContentScope(scope, () => ledger.originsThisTurn());

test("another scope's turn start does not erase what this scope read", () => {
  const ledger = new UntrustedContentLedger();
  withUntrustedContentScope('a', () => page(ledger, 'read-by-a'));
  withUntrustedContentScope('b', () => ledger.startTurn());
  expect(origins(ledger, 'a')).toEqual(['https://read-by-a.example']);
  expect(origins(ledger, 'b')).toEqual([]);
});

test('a scope sees its own reads and unscoped reads, not another scope\'s', () => {
  const ledger = new UntrustedContentLedger();
  withUntrustedContentScope('a', () => page(ledger, 'a-page'));
  withUntrustedContentScope('b', () => page(ledger, 'b-page'));
  page(ledger, 'shared-page');
  expect(origins(ledger, 'a')).toEqual(['https://a-page.example', 'https://shared-page.example']);
  expect(origins(ledger, 'b')).toEqual(['https://b-page.example', 'https://shared-page.example']);
});

test('a scoped turn start clears the unscoped reads for that scope only', () => {
  const ledger = new UntrustedContentLedger();
  page(ledger, 'shared-page');
  withUntrustedContentScope('a', () => ledger.startTurn());
  expect(origins(ledger, 'a')).toEqual([]);
  expect(origins(ledger, 'b')).toEqual(['https://shared-page.example']);
});

test('work outside any scope still sees every read, and an unscoped turn start clears all scopes', () => {
  const ledger = new UntrustedContentLedger();
  withUntrustedContentScope('a', () => page(ledger, 'a-page'));
  expect(ledger.originsThisTurn()).toEqual(['https://a-page.example']);
  ledger.startTurn();
  expect(origins(ledger, 'a')).toEqual([]);
  expect(ledger.captureTaintEvidence('retained').sources).toHaveLength(1);
});

test("another scope's reads passing the retention cap leave this scope's turn evidence complete", () => {
  const ledger = new UntrustedContentLedger();
  withUntrustedContentScope('session:b', () => { page(ledger, 'b-earlier-turn'); ledger.startTurn(); });
  withUntrustedContentScope('session:a', () => { for (let i = 0; i < 1_001; i++) page(ledger, `a-${i}`); });
  const own = withUntrustedContentScope('session:b', () => ledger.captureTaintEvidence('turn'));
  expect(own.evicted).toBe(false);
  expect(own.sources.length).toBe(0);
  const reader = withUntrustedContentScope('session:a', () => ledger.captureTaintEvidence('turn'));
  expect(reader.evicted).toBe(true);
});
