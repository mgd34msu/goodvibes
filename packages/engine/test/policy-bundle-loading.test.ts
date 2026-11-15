/**
 * Policy bundles named by configuration: a malformed file is refused without throwing, and with
 * signature enforcement on, nothing loads unless it carries a valid signature from the configured key.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPolicyRuntimeState } from '../platform/src/platform/runtime/permissions/permission-composition.ts';
import { loadConfiguredPolicyBundle } from '../platform/src/platform/runtime/permissions/policy-config-loader.ts';
import { PolicyRuntimeState } from '../platform/src/platform/runtime/permissions/policy-runtime.ts';
import { canonicalise, resolveSigningKey, signBundle, verifyBundle } from '../platform/src/platform/runtime/permissions/policy-signer.ts';
import type { ConfigManager } from '../platform/src/platform/config/manager.ts';
import type { FeatureFlagManager } from '../platform/src/platform/runtime/feature-flags/index.ts';

const KEY = 'a'.repeat(64);
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function configFor(file: string): ConfigManager {
  return {
    get: (key: string) => (key === 'policy.bundleSource' ? 'file' : key === 'policy.bundlePath' ? file : ''),
    getWorkingDirectory: () => undefined,
  } as unknown as ConfigManager;
}

function flags(enabled: readonly string[]): FeatureFlagManager {
  return { isEnabled: (id: string) => enabled.includes(id) } as unknown as FeatureFlagManager;
}

function bundleFile(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-policy-bundle-'));
  dirs.push(dir);
  const file = join(dir, 'bundle.json');
  writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf-8');
  return file;
}

const payload = { version: 1, rules: [{ id: 'r1', type: 'prefix', origin: 'user', effect: 'deny', toolPattern: 'exec', commandPrefixes: ['rm'] }] };

describe('a configured bundle file that is not a bundle', () => {
  for (const [label, contents] of [['null', 'null'], ['an empty object', '{}'], ['a bundle id alone', '{"bundleId":"x"}'], ['rules that are not an array', '{"bundleId":"x","payload":{"rules":5}}']] as const) {
    test(`${label} is refused without throwing and the reason is recorded`, () => {
      const state = new PolicyRuntimeState();
      expect(() => loadConfiguredPolicyBundle(configFor(bundleFile(contents)), flags(['policy-as-code']), state)).not.toThrow();
      expect(state.getRegistry().getCandidate()).toBeNull();
      expect(state.getConfiguredBundleFailure()).toContain('rejected at load');
    });
  }
});

describe('signature enforcement from configuration', () => {
  test('with enforcement on and no key, an unsigned bundle is refused', () => {
    const file = bundleFile({ bundleId: 'b1', issuedAt: 'now', payload });
    const state = createPolicyRuntimeState(configFor(file), flags(['policy-as-code', 'policy-signing']), {});
    expect(state.getRegistry().getCandidate()).toBeNull();
    expect(state.getConfiguredBundleFailure()).toContain('no signing key is configured');
  });

  test('with enforcement on, a tampered signed bundle is refused', () => {
    const signed = signBundle('b2', payload, KEY);
    const tampered = { ...signed, payload: { ...payload, rules: [] } };
    const state = createPolicyRuntimeState(configFor(bundleFile(tampered)), flags(['policy-as-code', 'policy-signing']), { GOODVIBES_POLICY_SIGNING_KEY: KEY });
    expect(state.getRegistry().getCandidate()).toBeNull();
    expect(state.getConfiguredBundleFailure()).toContain('signature does not verify');
  });

  test('with enforcement on, a bundle signed with the configured key loads as a candidate', () => {
    const state = createPolicyRuntimeState(configFor(bundleFile(signBundle('b3', payload, KEY))), flags(['policy-as-code', 'policy-signing']), { GOODVIBES_POLICY_SIGNING_KEY: KEY });
    const candidate = state.getRegistry().getCandidate();
    expect(candidate?.provenance.signatureStatus).toBe('valid');
    expect(candidate?.provenance.provenanceSource).toBe('local-file');
    expect(state.getConfiguredBundleFailure()).toBeNull();
  });

  test('with enforcement off, an unsigned bundle still loads', () => {
    const file = bundleFile({ bundleId: 'b4', issuedAt: 'now', payload });
    const state = createPolicyRuntimeState(configFor(file), flags(['policy-as-code']), {});
    expect(state.getRegistry().getCandidate()).not.toBeNull();
  });
});

describe('policy signatures', () => {
  test('an optional field left undefined does not break the signature after a file round trip', () => {
    const signed = signBundle('b5', { version: 1, rules: [], description: undefined }, KEY);
    const reread = JSON.parse(JSON.stringify(signed)) as typeof signed;
    expect(verifyBundle(reread, KEY).ok).toBe(true);
    expect(canonicalise({ a: undefined, b: [undefined] })).toBe('{"b":[null]}');
  });

  test('a key that is not hex of at least 16 bytes is refused', () => {
    expect(() => resolveSigningKey('correct horse battery staple')).toThrow('hex');
    expect(() => resolveSigningKey('abcd')).toThrow('16 bytes');
    expect(resolveSigningKey(KEY)).toHaveLength(32);
    expect(() => signBundle('b6', payload, 'not-a-key')).toThrow();
  });
});
