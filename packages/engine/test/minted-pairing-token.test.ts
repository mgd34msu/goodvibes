import { describe, expect, test } from 'bun:test';
import { parseMintedPairingToken } from '../terminal-shell/src/native/native-paired-principal.ts';

const valid = { token: { id: 'pair-12345678-1234-1234-1234-123456789abc', token: `gvp_${'a'.repeat(32)}`, name: 'Agent', createdAt: 1_700_000_000_000 } };

describe('parseMintedPairingToken', () => {
  test('accepts a well-formed migration response', () => {
    expect(parseMintedPairingToken(valid, 'Agent')).toEqual(valid.token);
  });

  test.each([-1, 0, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, '1700000000000'])('refuses createdAt %p', (createdAt) => {
    expect(parseMintedPairingToken({ token: { ...valid.token, createdAt } }, 'Agent')).toBeNull();
  });

  test('refuses a different name, a malformed id or secret, and a missing token object', () => {
    expect(parseMintedPairingToken(valid, 'Other')).toBeNull();
    expect(parseMintedPairingToken({ token: { ...valid.token, id: 'pair-x' } }, 'Agent')).toBeNull();
    expect(parseMintedPairingToken({ token: { ...valid.token, token: 'gvp_short' } }, 'Agent')).toBeNull();
    expect(parseMintedPairingToken({ token: 'secret' }, 'Agent')).toBeNull();
    expect(parseMintedPairingToken(null, 'Agent')).toBeNull();
  });
});
