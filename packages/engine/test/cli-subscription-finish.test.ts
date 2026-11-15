import { describe, expect, test } from 'bun:test';
import { createCliSubscriptionView } from '../terminal-shell/src/cli-subscription-view.js';

function setup(commandArgs: string[]) {
  const completed: string[] = [];
  const service = {
    name: 'custom', authType: 'oauth', tokenKey: 'custom-token',
    oauth: { authorizationUrl: 'https://example.test/auth', tokenUrl: 'https://example.test/token', clientId: 'c', scopes: [], redirectUri: 'http://localhost/cb' },
  };
  const services = {
    subscriptionManager: {
      list: () => [],
      listPending: () => [],
      get: () => undefined,
      getPending: () => ({ state: 'expected-state', verifier: 'v' }),
      completeOAuthLogin: async (_provider: string, _config: unknown, code: string) => {
        completed.push(code);
        return { tokenType: 'Bearer', createdAt: 1, updatedAt: 1 };
      },
    },
    serviceRegistry: { get: () => service, getAll: () => ({}) },
    secretsManager: {},
  };
  const view = createCliSubscriptionView<{ cli: { commandArgs: string[]; flags: Record<string, never> } }, never>(
    async (_runtime, fn) => fn(services as never),
    { inline: true, manualOnly: false, binary: () => 'goodvibes', source: (source) => source, time: String },
  );
  return { completed, render: () => view.renderSubscriptions({ cli: { commandArgs, flags: {} } }) };
}

describe('subscription login finish from the command line', () => {
  test('a pasted provider error address is refused and its text is never exchanged as a code', async () => {
    const { completed, render } = setup(['login', 'custom', 'finish', 'http://localhost/cb?error=access_denied']);
    expect(await render()).toContain('access_denied');
    expect(completed).toEqual([]);
  });

  test('an address from a different login attempt is refused', async () => {
    const { completed, render } = setup(['login', 'custom', 'finish', 'http://localhost/cb?code=abc&state=other']);
    expect(await render()).toContain('state mismatch');
    expect(completed).toEqual([]);
  });

  test('a matching address exchanges its code', async () => {
    const { completed, render } = setup(['login', 'custom', 'finish', 'http://localhost/cb?code=abc&state=expected-state']);
    await render();
    expect(completed).toEqual(['abc']);
  });
});
