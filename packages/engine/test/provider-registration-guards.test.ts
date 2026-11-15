/**
 * provider-registration-guards.test.ts
 *
 * Registration-time facts that keep a credential from going somewhere it should
 * not, and keep two registration tables from claiming one provider.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTO_REGISTER_CATALOG, autoRegisterProviders } from '../platform/src/platform/providers/auto-register.js';
import { BUILTIN_COMPAT_PROVIDERS } from '../platform/src/platform/providers/builtin-catalog.js';
import { createBuiltinCompatProvider, registerBuiltinProviders } from '../platform/src/platform/providers/builtin-registry.js';
import { AnthropicVertexProvider } from '../platform/src/platform/providers/anthropic-vertex.js';
import { AmazonBedrockProvider } from '../platform/src/platform/providers/amazon-bedrock.js';
import { AmazonBedrockMantleProvider } from '../platform/src/platform/providers/amazon-bedrock-mantle.js';
import type { LLMProvider } from '../platform/src/platform/providers/interface.js';

const originalFetch = globalThis.fetch;
const touched = ['AZURE_OPENAI_ENDPOINT', 'AZURE_FOUNDRY_ENDPOINT', 'ANTHROPIC_VERTEX_PROJECT_ID', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT_ID',
  'GOOGLE_APPLICATION_CREDENTIALS', 'ANTHROPIC_VERTEX_USE_GCP_METADATA', 'CLOUDSDK_CONFIG', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY', 'AWS_PROFILE'] as const;
const saved = new Map<string, string | undefined>(touched.map((name) => [name, process.env[name]]));
const dirs: string[] = [];

function clearEnv(): void {
  for (const name of touched) delete process.env[name];
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Microsoft Foundry without an endpoint', () => {
  const definition = BUILTIN_COMPAT_PROVIDERS.find((entry) => entry.id === 'microsoft-foundry')!;

  test('refuses before any request, so the key goes nowhere', async () => {
    clearEnv();
    let fetched = 0;
    globalThis.fetch = Object.assign(async () => { fetched += 1; return new Response('{}'); }, { preconnect() {} });
    const provider = createBuiltinCompatProvider(definition, 'azure-key', {});
    await expect(provider.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'gpt-5.6' })).rejects.toThrow('AZURE_OPENAI_ENDPOINT');
    expect(fetched).toBe(0);
  });

  test('the stand-in host can never resolve, so no registrable name ever receives the key', () => {
    expect(new URL(definition.baseURL).hostname.endsWith('.invalid')).toBe(true);
  });

  test('with an endpoint set it is the ordinary provider and sends to that endpoint', async () => {
    clearEnv();
    process.env['AZURE_OPENAI_ENDPOINT'] = 'https://mine.openai.azure.com';
    const urls: string[] = [];
    // Aborting once the first request is served ends the retry wait at once.
    const controller = new AbortController();
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      controller.abort();
      return new Response('{}', { status: 500 });
    }) as typeof globalThis.fetch;
    const provider = createBuiltinCompatProvider(definition, 'azure-key', {});
    await provider.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'gpt-5.6', signal: controller.signal }).catch(() => undefined);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((url) => url.startsWith('https://mine.openai.azure.com/openai/v1'))).toBe(true);
  });
});

describe('auto-register table', () => {
  test('lists no provider the builtin registry already registers', () => {
    const registered = new Set<string>();
    registerBuiltinProviders(
      { register: (provider: LLMProvider) => { registered.add(provider.name); } },
      () => false,
      () => '',
      {
        resolveProvider: () => { throw new Error('not used'); },
        getCatalogModels: () => [],
        getBenchmarks: () => undefined,
        githubCopilotTokenCachePath: join(tmpdir(), 'unused-copilot-token'),
        subscriptionManager: {} as never,
        persistenceRoot: join(tmpdir(), 'unused-persistence-root'),
      },
    );
    const shadowed = AUTO_REGISTER_CATALOG.map((entry) => entry.id).filter((id) => registered.has(id));
    expect(shadowed).toEqual([]);
  });

  test('never treats a host URL as an API key', () => {
    for (const entry of AUTO_REGISTER_CATALOG) {
      expect(entry.envVars.some((name) => /HOST|URL|ENDPOINT/.test(name))).toBe(false);
    }
  });
});

describe('model list cache wiring', () => {
  test('each cloud-hosted Anthropic provider reads the model list cache under its own id', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-model-cache-'));
    dirs.push(root);
    mkdirSync(join(root, 'provider-models'), { recursive: true });
    const seeded: Record<string, string> = {
      'amazon-bedrock': 'seeded-bedrock-model',
      'amazon-bedrock-mantle': 'seeded-mantle-model',
      'anthropic-vertex': 'seeded-vertex-model',
    };
    for (const [id, model] of Object.entries(seeded)) {
      writeFileSync(join(root, 'provider-models', `${id}.json`), JSON.stringify({ version: 1, fetchedAt: Date.now(), ttlMs: 86_400_000, models: [model] }));
    }
    const providers = new Map<string, LLMProvider>();
    registerBuiltinProviders(
      { register: (provider: LLMProvider) => { providers.set(provider.name, provider); } },
      () => false,
      () => '',
      {
        resolveProvider: () => { throw new Error('not used'); },
        getCatalogModels: () => [],
        getBenchmarks: () => undefined,
        githubCopilotTokenCachePath: join(root, 'copilot-token'),
        subscriptionManager: {} as never,
        persistenceRoot: root,
      },
    );
    for (const [id, model] of Object.entries(seeded)) {
      const provider = providers.get(id) as (LLMProvider & { refreshModels(): Promise<{ models: readonly string[] }> }) | undefined;
      expect(provider).toBeDefined();
      expect((await provider!.refreshModels()).models).toEqual([model]);
    }
  });
});

describe('autoRegisterProviders', () => {
  test('registers a provider whose environment key is set, once, and skips one already registered', () => {
    clearEnv();
    const names = AUTO_REGISTER_CATALOG.flatMap((entry) => entry.envVars);
    const before = new Map(names.map((name) => [name, process.env[name]]));
    for (const name of names) delete process.env[name];
    process.env['COHERE_API_KEY'] = 'cohere-key';
    try {
      const registered: string[] = [];
      const registry = {
        has: (id: string) => registered.includes(id),
        register: (provider: LLMProvider) => { registered.push(provider.name); },
      };
      expect(autoRegisterProviders(registry)).toEqual(['Cohere']);
      expect(registered).toEqual(['cohere']);
      expect(autoRegisterProviders(registry)).toEqual([]);
    } finally {
      for (const [name, value] of before) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

describe('Vertex credentials', () => {
  test('gcloud application-default credentials plus a project count as configured', () => {
    clearEnv();
    const dir = mkdtempSync(join(tmpdir(), 'adc-'));
    dirs.push(dir);
    process.env['CLOUDSDK_CONFIG'] = dir;
    process.env['ANTHROPIC_VERTEX_PROJECT_ID'] = 'my-project';
    expect(new AnthropicVertexProvider().isConfigured()).toBe(false);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'application_default_credentials.json'), '{}');
    expect(new AnthropicVertexProvider().isConfigured()).toBe(true);
  });

  test('without a project id the credentials file alone is not enough', () => {
    clearEnv();
    const dir = mkdtempSync(join(tmpdir(), 'adc-'));
    dirs.push(dir);
    process.env['CLOUDSDK_CONFIG'] = dir;
    writeFileSync(join(dir, 'application_default_credentials.json'), '{}');
    expect(new AnthropicVertexProvider().isConfigured()).toBe(false);
  });
});

describe('Bedrock bearer token', () => {
  test('a token handed in at registration configures both providers with no environment set', () => {
    clearEnv();
    expect(new AmazonBedrockProvider().isConfigured()).toBe(false);
    expect(new AmazonBedrockProvider(undefined, { bearerToken: 'stored-token' }).isConfigured()).toBe(true);
    expect(new AmazonBedrockMantleProvider(undefined, { bearerToken: 'stored-token' }).isConfigured()).toBe(true);
  });

  test('a blank token is not a token', () => {
    clearEnv();
    expect(new AmazonBedrockProvider(undefined, { bearerToken: '   ' }).isConfigured()).toBe(false);
  });

  test('credentials set after construction are seen', () => {
    clearEnv();
    const provider = new AmazonBedrockProvider();
    expect(provider.isConfigured()).toBe(false);
    process.env['AWS_BEARER_TOKEN_BEDROCK'] = 'late-token';
    expect(provider.isConfigured()).toBe(true);
  });
});
