import { afterEach, describe, expect, test } from 'bun:test';
import { BUILTIN_COMPAT_PROVIDERS } from '../platform/src/platform/providers/builtin-catalog.ts';
import { registerBuiltinProviders } from '../platform/src/platform/providers/builtin-registry.ts';
import { parseModelCatalogRepository } from '../platform/src/platform/providers/model-catalog-repository.ts';
import { transformModelsDevResponse } from '../platform/src/platform/providers/model-catalog-cache.ts';
import { installCatalogModelFacts } from '../platform/src/platform/providers/model-catalog-facts.ts';
import { resolveProviderDefaultModel, rankProviderModels } from '../platform/src/platform/providers/provider-default-model.ts';
import { OpenAICompatProvider } from '../platform/src/platform/providers/openai-compat.ts';
import { AnthropicCompatProvider } from '../platform/src/platform/providers/anthropic-compat.ts';
import { AmazonBedrockProvider } from '../platform/src/platform/providers/amazon-bedrock.ts';
import { AnthropicVertexProvider } from '../platform/src/platform/providers/anthropic-vertex.ts';
import { OpenAIProvider } from '../platform/src/platform/providers/openai.ts';
import { AnthropicProvider } from '../platform/src/platform/providers/anthropic.ts';
import { GeminiProvider } from '../platform/src/platform/providers/gemini.ts';
import { GitHubCopilotProvider } from '../platform/src/platform/providers/github-copilot.ts';
import type { CatalogModel } from '../platform/src/platform/providers/model-catalog.ts';
import type { LLMProvider, ProviderRuntimeMetadataDeps } from '../platform/src/platform/providers/interface.ts';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const EMPTY_RUNTIME_DEPS: ProviderRuntimeMetadataDeps = {
  secretsManager: {
    get: async () => null,
    listDetailed: async () => [],
  } as unknown as ProviderRuntimeMetadataDeps['secretsManager'],
  serviceRegistry: {
    getAll: () => ({}),
    inspect: async () => null,
  } as unknown as ProviderRuntimeMetadataDeps['serviceRegistry'],
  subscriptionManager: {
    get: async () => null,
    getPending: () => null,
  } as unknown as ProviderRuntimeMetadataDeps['subscriptionManager'],
};

afterEach(() => {
  installCatalogModelFacts([]);
});

describe('programmatic models.dev benchmark-ranked provider defaults', () => {
  test('parseModelCatalogRepository preserves base_model benchmarks and transformModelsDevResponse derives normalized benchmarkScore', async () => {
    const files = new Map<string, string>([
      ['models/acme/alpha.toml', [
        'schema = 2',
        'name = "Acme Alpha"',
        'release_date = "2026-01-10"',
        '[modalities]',
        'input = ["text"]',
        'output = ["text"]',
        '[capabilities]',
        'tools = { supported = true }',
        '[[benchmarks]]',
        'name = "SWE-Bench Pro"',
        'score = 40.0',
        'metric = "resolve rate"',
        '[[benchmarks]]',
        'name = "Terminal-Bench"',
        'score = 50.0',
        'metric = "score"',
      ].join('\n')],
      ['models/acme/beta.toml', [
        'schema = 2',
        'name = "Acme Beta"',
        'release_date = "2026-02-10"',
        '[modalities]',
        'input = ["text"]',
        'output = ["text"]',
        '[capabilities]',
        'tools = { supported = true }',
        '[[benchmarks]]',
        'name = "SWE-Bench Pro"',
        'score = 80.0',
        'metric = "resolve rate"',
        '[[benchmarks]]',
        'name = "Terminal-Bench"',
        'score = 90.0',
        'metric = "score"',
      ].join('\n')],
      ['models/acme/niche.toml', [
        'schema = 2',
        'name = "Acme Niche"',
        'release_date = "2026-03-10"',
        '[modalities]',
        'input = ["text"]',
        'output = ["text"]',
        '[[benchmarks]]',
        'name = "One-Model-Only-Bench"',
        'score = 99.9',
        'metric = "score"',
      ].join('\n')],
      ['providers/deepseek/provider.toml', 'name = "DeepSeek"\nenv = ["DEEPSEEK_API_KEY"]\n'],
      ['providers/deepseek/models/alpha.toml', 'base_model = "acme/alpha"\n'],
      ['providers/deepseek/models/beta.toml', 'base_model = "acme/beta"\n'],
      ['providers/deepseek/models/niche.toml', 'base_model = "acme/niche"\n'],
    ]);

    const parsed = await parseModelCatalogRepository(files);
    const catalog = transformModelsDevResponse(parsed, new Map([['deepseek', 'metered']]));
    const alpha = catalog.find((m) => m.id === 'alpha');
    const beta = catalog.find((m) => m.id === 'beta');
    const niche = catalog.find((m) => m.id === 'niche');

    expect(alpha?.benchmarkScore).toBeDefined();
    expect(beta?.benchmarkScore).toBeDefined();
    expect(beta!.benchmarkScore!).toBeGreaterThan(alpha!.benchmarkScore!);
    // Single-model niche benchmarks have no cross-model peer comparison and must not distort rankings.
    expect(niche?.benchmarkScore).toBeUndefined();

    installCatalogModelFacts(catalog);
    expect(resolveProviderDefaultModel('deepseek')).toBe('beta');
  });

  test('provider defaults update immediately when models.dev catalog refreshes and exclude non-text models', async () => {
    const initial: CatalogModel[] = [
      {
        id: 'embed-ultra',
        modelType: 'embedding',
        name: 'Embed Ultra',
        provider: 'DeepSeek',
        providerId: 'deepseek',
        providerEnvVars: ['DEEPSEEK_API_KEY'],
        pricing: null,
        tier: 'paid',
        benchmarkScore: 0.99,
      },
      {
        id: 'deepseek-v3',
        modelType: 'chat',
        toolCalling: true,
        releaseDate: '2026-01-01',
        name: 'DeepSeek V3',
        provider: 'DeepSeek',
        providerId: 'deepseek',
        providerEnvVars: ['DEEPSEEK_API_KEY'],
        pricing: null,
        tier: 'paid',
        benchmarkScore: 0.72,
      },
      {
        id: 'deepseek-v4',
        modelType: 'chat',
        toolCalling: true,
        releaseDate: '2026-06-01',
        name: 'DeepSeek V4',
        provider: 'DeepSeek',
        providerId: 'deepseek',
        providerEnvVars: ['DEEPSEEK_API_KEY'],
        pricing: null,
        tier: 'paid',
        benchmarkScore: 0.85,
      },
    ];
    installCatalogModelFacts(initial);

    const compat = new OpenAICompatProvider({
      name: 'deepseek',
      baseURL: 'https://api.deepseek.com',
      apiKey: 'test-key',
    });
    expect(compat.defaultModel).toBe('deepseek-v4');
    expect((await compat.describeRuntime(EMPTY_RUNTIME_DEPS)).models?.defaultModel).toBe('deepseek-v4');

    // Refresh models.dev with a newly higher-ranked model -> default updates automatically with zero hardcoding.
    installCatalogModelFacts([
      ...initial,
      {
        id: 'deepseek-v5',
        modelType: 'chat',
        toolCalling: true,
        releaseDate: '2026-10-01',
        name: 'DeepSeek V5',
        provider: 'DeepSeek',
        providerId: 'deepseek',
        providerEnvVars: ['DEEPSEEK_API_KEY'],
        pricing: null,
        tier: 'paid',
        benchmarkScore: 0.94,
      },
    ]);
    expect(compat.defaultModel).toBe('deepseek-v5');
    expect((await compat.describeRuntime(EMPTY_RUNTIME_DEPS)).models?.defaultModel).toBe('deepseek-v5');
  });

  test('falls back to tool-capable models by newest releaseDate when unbenchmarked, and restricts to availableModels', () => {
    const catalog: CatalogModel[] = [
      {
        id: 'model-old',
        modelType: 'chat',
        toolCalling: true,
        releaseDate: '2025-05-01',
        name: 'Old',
        provider: 'MiniMax',
        providerId: 'minimax',
        providerEnvVars: ['MINIMAX_API_KEY'],
        pricing: null,
        tier: 'paid',
      },
      {
        id: 'model-no-tools-newest',
        modelType: 'chat',
        toolCalling: false,
        releaseDate: '2026-11-01',
        name: 'No Tools',
        provider: 'MiniMax',
        providerId: 'minimax',
        providerEnvVars: ['MINIMAX_API_KEY'],
        pricing: null,
        tier: 'paid',
      },
      {
        id: 'model-tools-newest',
        modelType: 'chat',
        toolCalling: true,
        releaseDate: '2026-10-01',
        name: 'Tools Newest',
        provider: 'MiniMax',
        providerId: 'minimax',
        providerEnvVars: ['MINIMAX_API_KEY'],
        pricing: null,
        tier: 'paid',
      },
    ];
    installCatalogModelFacts(catalog);

    expect(resolveProviderDefaultModel('minimax')).toBe('model-tools-newest');
    // When live discovery only offers a subset, default stays inside that subset.
    expect(resolveProviderDefaultModel('minimax', { availableModels: ['model-old', 'model-no-tools-newest'] })).toBe('model-old');
    expect(rankProviderModels('minimax')).toEqual(['model-tools-newest', 'model-old', 'model-no-tools-newest']);
  });

  test('no built-in provider hardcodes a defaultModel and all providers resolve defaults from models.dev', async () => {
    for (const def of BUILTIN_COMPAT_PROVIDERS) {
      expect('defaultModel' in def).toBe(false);
    }

    installCatalogModelFacts([]);
    const registered = new Map<string, LLMProvider>();
    const unused = {} as never;
    registerBuiltinProviders(
      { register: (p) => { registered.set(p.name, p); } },
      () => false,
      () => '',
      {
        resolveProvider: () => unused,
        getCatalogModels: () => [],
        getBenchmarks: () => undefined,
        githubCopilotTokenCachePath: join(tmpdir(), 'gv-test-copilot-token.json'),
        subscriptionManager: unused,
        persistenceRoot: join(tmpdir(), 'gv-test-providers-empty'),
      },
    );

    // With an empty catalog and no live discovery, no builtin compat/Bedrock/Vertex provider invents a hardcoded default.
    for (const name of ['deepseek', 'openrouter', 'groq', 'minimax', 'amazon-bedrock', 'anthropic-vertex']) {
      const provider = registered.get(name)!;
      const runtime = await provider.describeRuntime?.(EMPTY_RUNTIME_DEPS);
      expect(runtime?.models?.defaultModel).toBeUndefined();
    }

    // Calling chat with an empty model when no default can be resolved fails honestly with a config error.
    const unseededCompat = new OpenAICompatProvider({
      name: 'deepseek',
      baseURL: 'https://api.deepseek.com',
      apiKey: 'test-key',
    });
    await expect(unseededCompat.chat({ model: '', messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toThrow(/has no default model available yet/);

    const unseededAnthropic = new AnthropicCompatProvider({
      name: 'minimax',
      baseURL: 'https://api.minimax.io/anthropic',
      apiKey: 'test-key',
    });
    await expect(unseededAnthropic.chat({ model: '', messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toThrow(/has no default model available yet/);

    // Hydrate models.dev catalog -> Bedrock (Anthropic-only filter), Vertex (aliased google-vertex-anthropic),
    // OpenAI, Anthropic, Gemini (aliased google), and GitHub Copilot all resolve programmatically.
    installCatalogModelFacts([
      {
        id: 'global.openai.gpt-9-ignored-on-bedrock',
        modelType: 'chat',
        name: 'Non-Anthropic Bedrock',
        provider: 'Amazon Bedrock',
        providerId: 'amazon-bedrock',
        providerEnvVars: [],
        pricing: null,
        tier: 'paid',
        benchmarkScore: 0.99,
      },
      {
        id: 'global.anthropic.claude-opus-5-20260724-v1:0',
        modelType: 'chat',
        name: 'Claude Opus 5',
        provider: 'Amazon Bedrock',
        providerId: 'amazon-bedrock',
        providerEnvVars: [],
        pricing: null,
        tier: 'paid',
        benchmarkScore: 0.88,
      },
      {
        id: 'claude-opus-5-vertex',
        modelType: 'chat',
        name: 'Claude Opus 5 Vertex',
        provider: 'Vertex Anthropic',
        providerId: 'google-vertex-anthropic',
        providerEnvVars: [],
        pricing: null,
        tier: 'paid',
        benchmarkScore: 0.91,
      },
      {
        id: 'gpt-top-ranked',
        modelType: 'chat',
        name: 'GPT Top',
        provider: 'OpenAI',
        providerId: 'openai',
        providerEnvVars: ['OPENAI_API_KEY'],
        pricing: null,
        tier: 'paid',
        benchmarkScore: 0.95,
      },
      {
        id: 'claude-top-ranked',
        modelType: 'chat',
        name: 'Claude Top',
        provider: 'Anthropic',
        providerId: 'anthropic',
        providerEnvVars: ['ANTHROPIC_API_KEY'],
        pricing: null,
        tier: 'paid',
        benchmarkScore: 0.93,
      },
      {
        id: 'gemini-top-ranked',
        modelType: 'chat',
        name: 'Gemini Top',
        provider: 'Google',
        providerId: 'google',
        providerEnvVars: ['GEMINI_API_KEY'],
        pricing: null,
        tier: 'paid',
        benchmarkScore: 0.92,
      },
      {
        id: 'copilot-top-ranked',
        modelType: 'chat',
        name: 'Copilot Top',
        provider: 'GitHub Copilot',
        providerId: 'github-copilot',
        providerEnvVars: ['COPILOT_GITHUB_TOKEN'],
        pricing: null,
        tier: 'paid',
        benchmarkScore: 0.90,
      },
    ]);

    const bedrock = new AmazonBedrockProvider();
    expect(bedrock.defaultModel).toBe('claude-opus-5');

    const vertex = new AnthropicVertexProvider();
    expect(vertex.defaultModel).toBe('claude-opus-5-vertex');

    const openai = new OpenAIProvider('test-key');
    expect((await openai.describeRuntime(EMPTY_RUNTIME_DEPS)).models?.defaultModel).toBe('gpt-top-ranked');

    const anthropic = new AnthropicProvider('test-key');
    expect((await anthropic.describeRuntime(EMPTY_RUNTIME_DEPS)).models?.defaultModel).toBe('claude-top-ranked');

    const gemini = new GeminiProvider('test-key');
    expect((await gemini.describeRuntime(EMPTY_RUNTIME_DEPS)).models?.defaultModel).toBe('gemini-top-ranked');

    const copilot = new GitHubCopilotProvider({ tokenCachePath: join(tmpdir(), 'gv-test-copilot-2.json') });
    expect((await copilot.describeRuntime(EMPTY_RUNTIME_DEPS)).models?.defaultModel).toBe('copilot-top-ranked');
  });
});
