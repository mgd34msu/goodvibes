/**
 * Which credential the Agent reports as in use must be the one requests use:
 * a stored subscription is used ahead of an API key only when it overrides
 * ambient keys (the rule `SubscriptionManager.getAccessToken` applies).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildProviderAccountSnapshot } from '@/runtime/index.ts';
import { ServiceRegistry } from '@goodvibes-jev/engine/platform/platform/config';
import { createTestManagers } from '../helpers/test-managers.ts';
import { SecretsManager } from '../../config/secrets.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

describe('provider account snapshot: active route', () => {
  const originalHome = process.env.HOME;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalCwd = process.cwd();
  let root = '';
  let managers = createTestManagers();

  beforeEach(() => {
    managers = createTestManagers();
    managers.providerRegistry.register({
      name: 'openai',
      models: ['gpt-5'],
      modelSource: { kind: 'dated-static', asOf: '2026-07-13' },
      credentialAuthority: 'resolver',
      async chat() {
        return { content: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'completed' };
      },
    });
    root = makeProjectTempDir('gv-provider-accounts');
    process.env.HOME = root;
    process.chdir(root);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
  });

  async function activeRoute(overrideAmbientApiKeys: boolean): Promise<string | undefined> {
    process.env.OPENAI_API_KEY = 'sk-test';
    managers.subscriptionManager.saveSubscription({
      provider: 'openai', accessToken: 'header.payload.signature', tokenType: 'Bearer',
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000, authMode: 'oauth', overrideAmbientApiKeys,
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    const secretsManager = new SecretsManager({ projectRoot: root, globalHome: root });
    const snapshot = await buildProviderAccountSnapshot({
      providerRegistry: managers.providerRegistry,
      serviceRegistry: new ServiceRegistry(join(root, '.goodvibes', 'agent', 'services.json'), {
        secretsManager, subscriptionManager: managers.subscriptionManager,
      }),
      subscriptionManager: managers.subscriptionManager,
      secretsManager,
    });
    return snapshot.providers.find((entry) => entry.providerId === 'openai')?.activeRoute;
  }

  test('an API key stays active beside a subscription that does not override it', async () => {
    expect(await activeRoute(false)).toBe('api-key');
    expect(managers.subscriptionManager.getAccessToken('openai')).toBeNull();
  });

  test('a subscription that overrides ambient keys is the active route', async () => {
    expect(await activeRoute(true)).toBe('subscription');
  });
});
