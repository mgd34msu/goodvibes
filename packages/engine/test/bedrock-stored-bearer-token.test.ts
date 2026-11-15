/**
 * A Bedrock bearer token kept in the GoodVibes secret store is found, reaches the
 * provider, and is the only stored value the status claims can be used.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getConfiguredApiKeys, resolveApiKeys } from '../platform/src/platform/config/api-keys.ts';
import { AmazonBedrockProvider } from '../platform/src/platform/providers/amazon-bedrock.ts';
import { buildStandardProviderAuthRoutes } from '../platform/src/platform/providers/runtime-metadata.ts';
import type { ProviderRuntimeMetadataDeps } from '../platform/src/platform/providers/interface.ts';

const AWS_NAMES = ['AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_PROFILE'];
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of AWS_NAMES) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
});
afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function secretsHolding(values: Record<string, string>) {
  return { get: async (key: string) => values[key] ?? null };
}

describe('Bedrock bearer token resolution', () => {
  test('a stored token resolves for both Bedrock providers, and the environment wins over it', async () => {
    const stored = secretsHolding({ AWS_BEARER_TOKEN_BEDROCK: 'stored-token' });
    expect(await resolveApiKeys(stored)).toMatchObject({ 'amazon-bedrock': 'stored-token', 'amazon-bedrock-mantle': 'stored-token' });

    process.env['AWS_BEARER_TOKEN_BEDROCK'] = 'env-token';
    expect(await resolveApiKeys(stored)).toMatchObject({ 'amazon-bedrock': 'env-token', 'amazon-bedrock-mantle': 'env-token' });
    expect(getConfiguredApiKeys()).toMatchObject({ 'amazon-bedrock': 'env-token' });
  });

  test('a stored access key id is not returned as an API key', async () => {
    const keys = await resolveApiKeys(secretsHolding({ AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE', AWS_SECRET_ACCESS_KEY: 'secret' }));
    expect(keys['amazon-bedrock']).toBeUndefined();
    expect(keys['amazon-bedrock-mantle']).toBeUndefined();
  });

  test('the provider built from the resolved token is configured with the environment empty', async () => {
    const keys = await resolveApiKeys(secretsHolding({ AWS_BEARER_TOKEN_BEDROCK: 'stored-token' }));
    expect(new AmazonBedrockProvider(undefined, { bearerToken: keys['amazon-bedrock'] }).isConfigured()).toBe(true);
    expect(new AmazonBedrockProvider(undefined, {}).isConfigured()).toBe(false);
  });
});

describe('Bedrock stored credential status', () => {
  function deps(stored: readonly string[]): ProviderRuntimeMetadataDeps {
    return {
      subscriptionManager: { get: () => null, getPending: () => null },
      serviceRegistry: { getAll: () => ({}), inspect: async () => null },
      secretsManager: {
        get: async () => null,
        listDetailed: async () => stored.map((key) => ({ key, source: 'secure' })),
      },
    } as never;
  }
  const options = {
    providerId: 'amazon-bedrock',
    apiKeyEnvVars: ['AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_REGION'],
    secretKeys: ['AWS_BEARER_TOKEN_BEDROCK'],
  };

  test('a stored access key id does not make the provider look configured, a stored bearer token does', async () => {
    const withKeyId = (await buildStandardProviderAuthRoutes(options, deps(['AWS_ACCESS_KEY_ID']))).find((r) => r.route === 'api-key');
    expect(withKeyId?.configured).toBe(false);

    const withToken = (await buildStandardProviderAuthRoutes(options, deps(['AWS_BEARER_TOKEN_BEDROCK']))).find((r) => r.route === 'api-key');
    expect(withToken?.configured).toBe(true);
  });

  test('the repair hint says only the bearer token can be stored', async () => {
    const route = (await buildStandardProviderAuthRoutes(options, deps([]))).find((r) => r.route === 'api-key');
    expect(route?.repairHints?.join(' ')).toContain('only AWS_BEARER_TOKEN_BEDROCK can be stored in /secrets');
  });
});
