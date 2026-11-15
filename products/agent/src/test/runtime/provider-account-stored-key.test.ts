/**
 * A provider key saved through the credential store, with nothing in the
 * process environment, is a configured API-key route. The snapshot used to read
 * only the environment and reported such a provider as unconfigured.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ServiceRegistry } from '@goodvibes-jev/engine/platform/platform/config';
import { buildProviderAccountSnapshot } from '@/runtime/index.ts';
import { SecretsManager } from '../../config/secrets.ts';
import { createTestManagers } from '../helpers/test-managers.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

describe('provider account snapshot: stored keys', () => {
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
    root = makeProjectTempDir('gv-provider-stored-key');
    process.env.HOME = root;
    delete process.env.OPENAI_API_KEY;
    process.chdir(root);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalOpenAiKey !== undefined) process.env.OPENAI_API_KEY = originalOpenAiKey;
  });

  function deps(secrets: { get(key: string): Promise<string | null> }) {
    return {
      providerRegistry: managers.providerRegistry,
      serviceRegistry: new ServiceRegistry(join(root, '.goodvibes', 'tui', 'services.json'), {
        secretsManager: new SecretsManager({ projectRoot: root, globalHome: root }),
        subscriptionManager: managers.subscriptionManager,
      }),
      subscriptionManager: managers.subscriptionManager,
      secretsManager: secrets,
    };
  }

  test('a key only the credential store holds makes the api-key route usable', async () => {
    const snapshot = await buildProviderAccountSnapshot(deps({
      get: async (key) => (key === 'OPENAI_API_KEY' ? 'sk-stored' : null),
    }));

    const openai = snapshot.providers.find((entry) => entry.providerId === 'openai');
    expect(openai?.availableRoutes).toContain('api-key');
    expect(openai?.activeRoute).toBe('api-key');
  });

  test('with no key in either place the provider is still unconfigured', async () => {
    const snapshot = await buildProviderAccountSnapshot(deps({ get: async () => null }));

    expect(snapshot.providers.find((entry) => entry.providerId === 'openai')?.activeRoute).toBe('unconfigured');
  });

  test('a credential store that cannot be read does not break the snapshot', async () => {
    const snapshot = await buildProviderAccountSnapshot(deps({
      get: async () => { throw new Error('store locked'); },
    }));

    expect(snapshot.providers.find((entry) => entry.providerId === 'openai')?.activeRoute).toBe('unconfigured');
  });
});
