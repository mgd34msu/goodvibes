import { describe, expect, test } from 'bun:test';
import type { LLMProvider } from '@goodvibes-jev/engine/platform/platform/providers';
import { runProviderKeyIntake, type ProviderKeyIntakeDeps } from '../../input/provider-key-intake.ts';
import type { ConcealedInputRequest } from '../../input/concealed-input.ts';

function unconfiguredProvider(): LLMProvider {
  return {
    name: 'p',
    models: [],
    chat: async () => { throw new Error('not used'); },
    describeAuthState: () => ({ configured: false, allowAnonymous: false, anonymousReady: false, authEnvVars: ['ACME_API_KEY'] }),
  } as unknown as LLMProvider;
}

async function submitKey(deps: Partial<ProviderKeyIntakeDeps>): Promise<{ prints: string[]; completed: number }> {
  const begun: ConcealedInputRequest[] = [];
  const prints: string[] = [];
  let completed = 0;
  runProviderKeyIntake('acme', {
    provider: unconfiguredProvider(),
    secretsManager: { set: async () => {} },
    beginConcealedInput: (request) => { begun.push(request); },
    print: (text) => { prints.push(text); },
    ...deps,
  }, () => { completed += 1; });
  begun[0]!.onSubmit('sk-secret-value');
  // The submit handler awaits the store, then the refresh, then completes.
  for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
  return { prints, completed };
}

describe('provider key intake outcome wording', () => {
  test('a key that was stored but could not be registered live says it was stored', async () => {
    const { prints, completed } = await submitKey({
      refreshProviderCredentials: async () => { throw new Error('registry offline'); },
    });
    const text = prints.join('\n');
    expect(text).toContain('Stored the API key');
    expect(text).toContain('registering it live failed');
    expect(text).not.toContain('Could not store');
    expect(text).not.toContain('sk-secret-value');
    expect(completed).toBe(1);
  });

  test('a key that could not be stored says so and does not claim registration', async () => {
    let refreshed = 0;
    const { prints, completed } = await submitKey({
      secretsManager: { set: async () => { throw new Error('disk full'); } },
      refreshProviderCredentials: async () => { refreshed += 1; },
    });
    expect(prints.join('\n')).toContain('Could not store the key');
    expect(refreshed).toBe(0);
    expect(completed).toBe(1);
  });
});
