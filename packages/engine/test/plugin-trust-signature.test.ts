/** Public verification must not reveal a secret that can mint publisher signatures. */
import { describe, expect, test } from 'bun:test';
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { PluginTrustStore, pluginManifestSignaturePayload, validatePluginSignature } from '../platform/src/platform/runtime/plugins/trust.ts';

const publisher = generateKeyPairSync('ed25519');
const otherPublisher = generateKeyPairSync('ed25519');
const publicKey = publisher.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const manifest = { name: 'repo-tools', version: '1.2.0', capabilities: ['filesystem.read', 'network.outbound'],
  description: 'Synthetic plugin', main: 'index.js', hooks: ['TURN_SUBMITTED'], minRuntimeVersion: '3.1.0' };
function signed(value = manifest, privateKey = publisher.privateKey) {
  return { ...value, signature: sign(null, pluginManifestSignaturePayload(value), privateKey).toString('base64') };
}

describe('validatePluginSignature', () => {
  test('verifies an Ed25519 signature using only the publisher public key', () => {
    const input = signed();
    expect(validatePluginSignature(input, publicKey)).toEqual({ valid: true, fingerprint: input.signature.slice(0, 16) });
  });

  test('missing or wrong verification keys cannot authenticate a manifest', () => {
    expect(validatePluginSignature(signed())).toMatchObject({ valid: false, reason: expect.stringContaining('No verification key') });
    expect(validatePluginSignature(signed(manifest, otherPublisher.privateKey), publicKey)).toMatchObject({ valid: false });
    expect(validatePluginSignature(signed(), 'synthetic shared secret')).toMatchObject({ valid: false });
  });

  test('knowing the public key cannot forge a signature with the previous HMAC scheme', () => {
    const forged = createHmac('sha256', publicKey).update(pluginManifestSignaturePayload(manifest)).digest('base64');
    expect(validatePluginSignature({ ...manifest, signature: forged }, publicKey).valid).toBe(false);
  });

  test.each<Partial<typeof manifest>>([
    { name: 'another-plugin' }, { version: '1.3.0' }, { capabilities: ['shell.exec'] },
    { main: 'another-entry.js' }, { hooks: ['TOOL_EXECUTING'] }, { minRuntimeVersion: '3.0.0' }, { description: 'Changed disclosure' },
  ])('rejects a changed manifest field: %j', change => {
    expect(validatePluginSignature({ ...signed(), ...change }, publicKey).valid).toBe(false);
  });

  test('object property order and capability order do not change the signed payload', () => {
    const input = signed();
    const reordered = Object.fromEntries(Object.entries(input).reverse());
    reordered.capabilities = [...manifest.capabilities].reverse();
    expect(validatePluginSignature(reordered as typeof input, publicKey).valid).toBe(true);
  });

  test('malformed signatures and input accessors are rejected without executing them', () => {
    for (const signature of [undefined, '', 'not base64!', 'a'.repeat(88), signed().signature + '\n']) {
      expect(validatePluginSignature({ ...manifest, signature }, publicKey).valid).toBe(false);
    }
    let called = false;
    const input = Object.defineProperty(signed(), 'main', { get() { called = true; return 'another-entry.js'; } });
    expect(validatePluginSignature(input, publicKey).valid).toBe(false);
    expect(called).toBe(false);
  });
});

describe('PluginTrustStore.trustSigned', () => {
  test('elevates only the exact authenticated plugin', () => {
    const store = new PluginTrustStore(), input = signed();
    expect(store.trustSigned('repo-tools', input)).toMatchObject({ ok: false });
    expect(store.trustSigned('different-plugin', input, publicKey)).toMatchObject({ ok: false });
    expect(store.getTier('different-plugin')).toBe('untrusted');
    const trusted = store.trustSigned('repo-tools', input, publicKey);
    expect(trusted.ok).toBe(true);
    if (trusted.ok) expect(trusted.record.tier).toBe('trusted');
  });

  test('persisted HMAC grants require re-verification while Ed25519 grants retain their format', () => {
    const store = new PluginTrustStore();
    store.importRecords({ 'repo-tools': { pluginName: 'repo-tools', tier: 'trusted', updatedAt: 1,
      grantedBy: 'signed-manifest', signatureFingerprint: 'previous-mac' } });
    expect(store.getTier('repo-tools')).toBe('untrusted');
    expect(store.trustSigned('repo-tools', signed(), publicKey).ok).toBe(true);
    const restored = new PluginTrustStore();
    restored.importRecords(store.exportRecords());
    expect(restored.getTier('repo-tools')).toBe('trusted');
  });
});
