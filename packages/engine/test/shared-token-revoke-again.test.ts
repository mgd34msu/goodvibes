/**
 * Revoking the shared operator token ends the value in use. After the first
 * revoke the daemon's own machine holds a replacement; a copy of it taken off
 * the machine signs in from anywhere, so revoking again must end that value
 * too, while the machine's own apps read the new one. Real pairing store and
 * real operator-token file in a daemon home; the custody is wired the way the
 * daemon wires it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PairingTokenManager } from '../platform/src/platform/pairing/pairing-token-store.ts';
import { getOrCreateCompanionToken, readCompanionTokenValue, replaceCompanionToken } from '../platform/src/platform/pairing/companion-token.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('shared operator token revocation', () => {
  test('each revoke ends the value in use, the replacement included', () => {
    const daemonHomeDir = mkdtempSync(join(tmpdir(), 'gv-shared-revoke-'));
    roots.push(daemonHomeDir);
    let served: string = getOrCreateCompanionToken({ daemonHomeDir }).token;
    const store = new PairingTokenManager(join(daemonHomeDir, 'pairing-tokens.json'));
    const unbind = store.bindSharedTokenCustody({
      current: () => served,
      replacementRefusal: () => (readCompanionTokenValue(daemonHomeDir) === served ? null : 'the served token is not the stored one'),
      replace: (commit) => { served = replaceCompanionToken({ daemonHomeDir }, commit).token; },
    });
    try {
      const original = served;
      store.revokeLegacyShared();
      const firstReplacement = served;
      expect(firstReplacement).not.toBe(original);
      expect(store.refusesSharedToken(original)).toBe(true);
      expect(store.refusesSharedToken(firstReplacement)).toBe(false);

      store.revokeLegacyShared();
      const secondReplacement = served;
      expect(secondReplacement).not.toBe(firstReplacement);
      expect(store.refusesSharedToken(firstReplacement)).toBe(true);
      expect(store.refusesSharedToken(secondReplacement)).toBe(false);
      expect(readCompanionTokenValue(daemonHomeDir)).toBe(secondReplacement);
    } finally {
      unbind();
    }
  });
});
