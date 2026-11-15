import { describe, expect, test } from 'bun:test';
import { BUILTIN_PROVIDER_ENV_KEYS } from '@goodvibes-jev/engine/platform/platform/providers';
import { getSecretBackedProviderIds, type OnboardingSignalSnapshot } from '../terminal-shell/src/onboarding-signals.js';

function withSecrets(keys: readonly string[]): OnboardingSignalSnapshot {
  return { secrets: { records: keys.map((key) => ({ key })) } } as unknown as OnboardingSignalSnapshot;
}

describe('secret-backed provider ids', () => {
  test('every catalog env name marks each provider that declares it', () => {
    for (const [providerId, names] of Object.entries(BUILTIN_PROVIDER_ENV_KEYS)) {
      for (const name of names) {
        expect(getSecretBackedProviderIds(withSecrets([name]))).toContain(providerId);
      }
    }
  });

  test('a variable shared by several providers marks all of them', () => {
    const shared = 'DASHSCOPE_API_KEY';
    const expected = Object.entries(BUILTIN_PROVIDER_ENV_KEYS).filter(([, n]) => n.includes(shared)).map(([id]) => id).sort();
    expect(expected.length).toBeGreaterThan(1);
    expect(getSecretBackedProviderIds(withSecrets([shared]))).toEqual(expected);
  });
});
