import type { ChatRequest, ChatResponse, LLMProvider } from './interface.js';
import { getBuiltinProviderEnvVars } from '../config/provider-credential-catalog.js';
import { ProviderError } from '../types/errors.js';
import { OpenAIProvider } from './openai.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { AnthropicProvider } from './anthropic.js';
import { AnthropicCompatProvider } from './anthropic-compat.js';
import { GeminiProvider } from './gemini.js';
import { AmazonBedrockProvider } from './amazon-bedrock.js';
import { AmazonBedrockMantleProvider } from './amazon-bedrock-mantle.js';
import { AnthropicVertexProvider } from './anthropic-vertex.js';
import { GitHubCopilotProvider } from './github-copilot.js';
import { BUILTIN_COMPAT_PROVIDERS, type BuiltinCompatDefinition } from './builtin-catalog.js';
import { fetchFireworksModelIds, getProviderModelsCachePath } from './live-model-discovery.js';
import { normalizeFoundryEndpoint } from './microsoft-foundry-shared.js';
import { SyntheticProvider } from './synthetic.js';
import type { BenchmarkEntry } from './model-benchmarks.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { CanonicalModel } from './synthetic.js';
import type { SubscriptionManager } from '../config/subscriptions.js';

export interface ProviderRegistrar {
  register(provider: LLMProvider): void;
}

export { CATALOG_PROVIDER_NAME_ALIASES } from './provider-aliases.js';

function firstEnvValue(envVars: readonly string[]): string | undefined {
  for (const envVar of envVars) {
    const value = process.env[envVar]!;
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

/**
 * Stands in for the Foundry base URL until an endpoint is configured. `.invalid`
 * is reserved and can never resolve, unlike a real-looking Azure resource name
 * that anybody could register: nothing sent to it, the API key included, can
 * reach another party.
 */
const FOUNDRY_UNCONFIGURED_BASE_URL = 'https://endpoint-not-configured.invalid/openai/v1';

function resolveFoundryBaseUrl(): string | null {
  const endpoint = firstEnvValue(['AZURE_OPENAI_ENDPOINT', 'AZURE_FOUNDRY_ENDPOINT']);
  if (!endpoint) return null;
  const normalized = normalizeFoundryEndpoint(endpoint);
  return normalized.endsWith('/openai/v1') ? normalized : `${normalized}/openai/v1`;
}

/** Where the Cloudflare ids come from: the `cloudflare.accountId` and `cloudflare.aiGatewayId` settings, then the environment. */
export interface CloudflareGatewaySettings {
  get(key: 'cloudflare.accountId' | 'cloudflare.aiGatewayId'): unknown;
}

/** The settings the Cloudflare AI Gateway provider is built from; the registry rebuilds it when one changes. */
export const CLOUDFLARE_GATEWAY_SETTING_KEYS = ['cloudflare.accountId', 'cloudflare.aiGatewayId'] as const;

function settingOrEnv(settings: CloudflareGatewaySettings | undefined, key: 'cloudflare.accountId' | 'cloudflare.aiGatewayId', envVar: string): string | undefined {
  const setting = settings?.get(key);
  return (typeof setting === 'string' && setting.trim()) || firstEnvValue([envVar]);
}

const CLOUDFLARE_GATEWAY_UNCONFIGURED_BASE_URL = 'https://gateway-not-configured.invalid/openai';

/** `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/openai`, or null while either id is missing. */
export function resolveCloudflareGatewayBaseUrl(settings?: CloudflareGatewaySettings): string | null {
  const accountId = settingOrEnv(settings, 'cloudflare.accountId', 'CLOUDFLARE_ACCOUNT_ID');
  const gatewayId = settingOrEnv(settings, 'cloudflare.aiGatewayId', 'CLOUDFLARE_AI_GATEWAY_ID');
  if (!accountId || !gatewayId) return null;
  return `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(accountId)}/${encodeURIComponent(gatewayId)}/openai`;
}

/** Cloudflare AI Gateway with no account or gateway: it refuses to send, naming what is missing. */
class CloudflareGatewayNotConfiguredProvider extends OpenAICompatProvider {
  override async chat(params: ChatRequest): Promise<ChatResponse> {
    throw new ProviderError(
      `Provider "cloudflare-ai-gateway" has no account or gateway configured, the request for model "${params.model ?? 'default'}" was not sent and the API key was not used. Set cloudflare.accountId and cloudflare.aiGatewayId (or CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_GATEWAY_ID) to your gateway's ids; a setting takes effect at once.`,
      { category: 'config', guidance: 'Set cloudflare.accountId and cloudflare.aiGatewayId (or CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_GATEWAY_ID).' },
    );
  }
}

/** Microsoft Foundry with no endpoint set: it refuses to send, naming the missing setting. */
class FoundryEndpointNotConfiguredProvider extends OpenAICompatProvider {
  override async chat(params: ChatRequest): Promise<ChatResponse> {
    throw new ProviderError(
      `Provider "microsoft-foundry" has no endpoint configured, the request for model "${params.model ?? 'default'}" was not sent and the API key was not used. Set AZURE_OPENAI_ENDPOINT or AZURE_FOUNDRY_ENDPOINT to your resource endpoint (https://<resource>.openai.azure.com).`,
    );
  }
}

export function createBuiltinCompatProvider(
  definition: BuiltinCompatDefinition,
  apiKey: string,
  options: {
    readonly cacheHitTracker?: import('./cache-strategy.js').CacheHitTracker | undefined;
    /** On-disk cache path for this provider's live-discovered model list. */
    readonly modelsCachePath?: string | undefined;
    /** Settings the Cloudflare AI Gateway reads its account and gateway ids from. */
    readonly settings?: CloudflareGatewaySettings | undefined;
  },
): LLMProvider {
  // The resolver hands over a key from the environment or the secrets store; the
  // environment is read here as well so a provider is never inactive for want of a resolver row.
  apiKey ||= firstEnvValue(definition.envVars) ?? '';
  if (definition.kind === 'anthropic-compat') {
    return new AnthropicCompatProvider({
      name: definition.id,
      baseURL: definition.baseURL,
      apiKey,
      defaultModel: definition.defaultModel,
      ...(definition.modelListing ? { modelListing: definition.modelListing } : {}),
      ...(definition.modelListingUrl ? { modelListingUrl: definition.modelListingUrl } : {}),
      ...(options.modelsCachePath ? { modelsCachePath: options.modelsCachePath } : {}),
      ...(definition.defaultHeaders ? { defaultHeaders: definition.defaultHeaders } : {}),
      setupDescription: definition.setupDescription,
      authEnvVars: definition.envVars,
      serviceNames: definition.serviceNames,
      aliases: definition.aliases,
      ...(definition.subscriptionProviderId ? { subscriptionProviderId: definition.subscriptionProviderId } : {}),
      ...(definition.streamProtocol ? { streamProtocol: definition.streamProtocol } : {}),
      ...(definition.authHeaderMode ? { authHeaderMode: definition.authHeaderMode } : {}),
      ...(definition.allowAnonymous ? { allowAnonymous: true } : {}),
      ...(definition.anonymousConfigured ? { anonymousConfigured: true } : {}),
      ...(definition.anonymousDetail ? { anonymousDetail: definition.anonymousDetail } : {}),
    });
  }

  const foundryBaseUrl = definition.id === 'microsoft-foundry' ? resolveFoundryBaseUrl() : undefined;
  const cloudflareBaseUrl = definition.id === 'cloudflare-ai-gateway' ? resolveCloudflareGatewayBaseUrl(options.settings) : undefined;
  const baseURL = definition.id === 'microsoft-foundry'
    ? (foundryBaseUrl ?? FOUNDRY_UNCONFIGURED_BASE_URL)
    : definition.id === 'cloudflare-ai-gateway'
      ? (cloudflareBaseUrl ?? CLOUDFLARE_GATEWAY_UNCONFIGURED_BASE_URL)
      : definition.baseURL;
  const effectiveApiKey = apiKey || (definition.allowAnonymous ? 'gv-local' : '');
  const compatOptions: ConstructorParameters<typeof OpenAICompatProvider>[0] = {
    name: definition.id,
    baseURL,
    apiKey: effectiveApiKey,
    authConfigured: Boolean(apiKey),
    defaultModel: definition.defaultModel,
    ...(definition.modelListing ? { modelListing: definition.modelListing } : {}),
    ...(definition.modelListingUrl ? { modelListingUrl: definition.modelListingUrl } : {}),
    // Fireworks' inference surface has no /models listing; its documented
    // listing lives on the account-management API and needs its own fetcher.
    ...(definition.id === 'fireworks' && effectiveApiKey
      ? { fetchLiveModels: () => fetchFireworksModelIds(effectiveApiKey) }
      : {}),
    ...(options.modelsCachePath ? { modelsCachePath: options.modelsCachePath } : {}),
    ...(definition.embeddingModel ? { embeddingModel: definition.embeddingModel } : {}),
    ...(definition.defaultHeaders ? { defaultHeaders: definition.defaultHeaders } : {}),
    reasoningFormat: definition.reasoningFormat ?? 'none',
    setupDescription: definition.setupDescription,
    authEnvVars: definition.envVars,
    serviceNames: definition.serviceNames,
    ...(definition.subscriptionProviderId ? { subscriptionProviderId: definition.subscriptionProviderId } : {}),
    ...(definition.suppressedModelRegistryKeys
      ? { suppressedModelRegistryKeys: definition.suppressedModelRegistryKeys }
      : {}),
    ...(definition.aliases ? { aliases: definition.aliases } : {}),
    ...(definition.streamProtocol ? { streamProtocol: definition.streamProtocol } : {}),
    ...(definition.allowAnonymous ? { allowAnonymous: true } : {}),
    ...(definition.anonymousConfigured ? { anonymousConfigured: true } : {}),
    ...(definition.anonymousDetail ? { anonymousDetail: definition.anonymousDetail } : {}),
    ...(options.cacheHitTracker ? { cacheHitTracker: options.cacheHitTracker } : {}),
  };
  if (foundryBaseUrl === null) return new FoundryEndpointNotConfiguredProvider(compatOptions);
  if (cloudflareBaseUrl === null) return new CloudflareGatewayNotConfiguredProvider(compatOptions);
  return new OpenAICompatProvider(compatOptions);
}

/**
 * Register the complete set of builtin provider implementations.
 * Kept in a separate module so the registry composition root stays focused.
 */
export function registerBuiltinProviders(
  registry: ProviderRegistrar,
  hasProvider: (name: string) => boolean,
  apiKey: (name: string) => string,
  options: {
    readonly resolveProvider: (providerName: string) => LLMProvider;
    readonly cacheHitTracker?: import('./cache-strategy.js').CacheHitTracker | undefined;
    readonly getCatalogModels: () => readonly CanonicalModel[];
    readonly getBenchmarks: (modelId: string) => BenchmarkEntry | undefined;
    readonly githubCopilotTokenCachePath: string;
    readonly subscriptionManager: Pick<SubscriptionManager, 'get' | 'getPending' | 'saveSubscription' | 'resolveAccessToken'>;
    readonly runtimeBus?: RuntimeEventBus | null | undefined;
    /** Control-plane persistence root; per-provider live-model-discovery cache paths derive from it. */
    readonly persistenceRoot: string;
    /**
     * Where the prompt-cache keys (`cache.enabled`, `cache.stableTtl`) are read.
     *
     * Only the explicit-caching builtins need it, `cache.enabled` describes
     * itself as being for "eligible providers (Anthropic)".
     */
    readonly cachePolicy?: import('./cache-strategy.js').CachePolicyReader | undefined;
    /** Settings a builtin reads at construction (the Cloudflare AI Gateway account and gateway ids). */
    readonly settings?: CloudflareGatewaySettings | undefined;
    /** Read a provider's model list again off the request path (an endpoint refused a model as unknown). */
    readonly refreshModels?: ((providerId: string) => void) | undefined;
  },
): void {
  const modelsCachePath = (providerId: string) => getProviderModelsCachePath(options.persistenceRoot, providerId);
  registry.register(
    new OpenAICompatProvider({
      name: 'inceptionlabs',
      modelsCachePath: modelsCachePath('inceptionlabs'),
      baseURL: 'https://api.inceptionlabs.ai/v1',
      apiKey: apiKey('inceptionlabs'),
      defaultModel: 'mercury-2',
      reasoningFormat: 'mercury',
      authEnvVars: ['INCEPTION_API_KEY'],
      serviceNames: ['inceptionlabs'],
      aliases: ['inception'],
    }),
  );

  registry.register(
    new OpenAICompatProvider({
      name: 'openrouter',
      modelsCachePath: modelsCachePath('openrouter'),
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: apiKey('openrouter'),
      defaultModel: 'openrouter/free',
      reasoningFormat: 'openrouter',
      authEnvVars: ['OPENROUTER_API_KEY'],
      serviceNames: ['openrouter'],
    }),
  );

  registry.register(
    new OpenAICompatProvider({
      name: 'aihubmix',
      modelsCachePath: modelsCachePath('aihubmix'),
      // AiHubMix's documented listing lives at /api/v1/models (not
      // {baseURL}/models) and keys entries by model_id (docs.aihubmix.com).
      modelListingUrl: 'https://aihubmix.com/api/v1/models',
      baseURL: 'https://aihubmix.com/v1',
      apiKey: apiKey('aihubmix'),
      defaultModel: 'gpt-4.1-free',
      reasoningFormat: 'none',
      authEnvVars: ['AIHUBMIX_API_KEY'],
      serviceNames: ['aihubmix'],
    }),
  );

  registry.register(
    new OpenAICompatProvider({
      name: 'groq',
      modelsCachePath: modelsCachePath('groq'),
      baseURL: 'https://api.groq.com/openai/v1',
      apiKey: apiKey('groq'),
      defaultModel: 'qwen/qwen3-32b',
      reasoningFormat: 'none',
      authEnvVars: ['GROQ_API_KEY'],
      serviceNames: ['groq'],
    }),
  );

  registry.register(
    new OpenAICompatProvider({
      name: 'cerebras',
      modelsCachePath: modelsCachePath('cerebras'),
      baseURL: 'https://api.cerebras.ai/v1',
      apiKey: apiKey('cerebras'),
      defaultModel: 'qwen-3-235b-a22b-instruct-2507',
      reasoningFormat: 'none',
      authEnvVars: ['CEREBRAS_API_KEY'],
      serviceNames: ['cerebras'],
    }),
  );

  registry.register(
    new OpenAICompatProvider({
      name: 'mistral',
      modelsCachePath: modelsCachePath('mistral'),
      baseURL: 'https://api.mistral.ai/v1',
      apiKey: apiKey('mistral'),
      defaultModel: 'mistral-large-latest',
      embeddingModel: 'mistral-embed',
      reasoningFormat: 'none',
      authEnvVars: ['MISTRAL_API_KEY'],
      serviceNames: ['mistral'],
    }),
  );

  registry.register(
    new OpenAICompatProvider({
      name: 'ollama-cloud',
      modelsCachePath: modelsCachePath('ollama-cloud'),
      baseURL: 'https://ollama.com/v1',
      apiKey: apiKey('ollama-cloud'),
      defaultModel: 'deepseek-v3.2',
      reasoningFormat: 'none',
      authEnvVars: ['OLLAMA_CLOUD_API_KEY', 'OLLAMA_API_KEY'],
      serviceNames: ['ollama-cloud'],
    }),
  );

  // One OpenAI provider: the ChatGPT subscription and the API key are its two sign-ins.
  registry.register(new OpenAIProvider(apiKey('openai'), options.cacheHitTracker, modelsCachePath('openai'), {
    subscriptionManager: options.subscriptionManager,
    ...(options.refreshModels ? { onUnknownModel: () => options.refreshModels!('openai') } : {}),
  }));
  registry.register(new AnthropicProvider(apiKey('anthropic'), options.cacheHitTracker, modelsCachePath('anthropic'), options.cachePolicy));
  registry.register(new GeminiProvider(apiKey('gemini'), options.cacheHitTracker, modelsCachePath('gemini')));

  registry.register(
    new OpenAICompatProvider({
      name: 'huggingface',
      modelsCachePath: modelsCachePath('huggingface'),
      baseURL: 'https://router.huggingface.co/v1',
      apiKey: apiKey('huggingface'),
      defaultModel: 'deepseek-ai/DeepSeek-V3.2',
      reasoningFormat: 'none',
      authEnvVars: [...getBuiltinProviderEnvVars('huggingface')],
      serviceNames: ['huggingface'],
    }),
  );

  registry.register(
    new OpenAICompatProvider({
      name: 'nvidia',
      modelsCachePath: modelsCachePath('nvidia'),
      baseURL: 'https://integrate.api.nvidia.com/v1',
      apiKey: apiKey('nvidia'),
      defaultModel: 'deepseek-ai/deepseek-v3.2',
      reasoningFormat: 'none',
      authEnvVars: [...getBuiltinProviderEnvVars('nvidia')],
      serviceNames: ['nvidia'],
    }),
  );

  registry.register(
    new OpenAICompatProvider({
      name: 'llm7',
      modelsCachePath: modelsCachePath('llm7'),
      baseURL: 'https://api.llm7.io/v1',
      apiKey: apiKey('llm7'),
      defaultModel: 'codestral-latest',
      reasoningFormat: 'none',
      authEnvVars: ['LLM7_API_KEY'],
      serviceNames: ['llm7'],
    }),
  );

  for (const definition of BUILTIN_COMPAT_PROVIDERS) {
    if (hasProvider(definition.id)) continue;
    const resolvedKey = apiKey(definition.id);
    registry.register(createBuiltinCompatProvider(definition, resolvedKey, {
      cacheHitTracker: options.cacheHitTracker,
      modelsCachePath: modelsCachePath(definition.id),
      settings: options.settings,
    }));
  }

  // The bearer token resolves the way every other provider key does (environment,
  // then the secrets store) once the credential resolver maps it for these ids;
  // until then it is empty and the providers read the environment themselves.
  registry.register(new AmazonBedrockProvider(modelsCachePath('amazon-bedrock'), { bearerToken: apiKey('amazon-bedrock') }));
  registry.register(new AmazonBedrockMantleProvider(modelsCachePath('amazon-bedrock-mantle'), { bearerToken: apiKey('amazon-bedrock-mantle') }));
  registry.register(new AnthropicVertexProvider(modelsCachePath('anthropic-vertex')));
  registry.register(new GitHubCopilotProvider({
    tokenCachePath: options.githubCopilotTokenCachePath,
    token: apiKey('github-copilot') || undefined,
  }));

  // Synthetic failover provider, must be after all backends.
  // catalog-driven SyntheticProvider manages its own backend lists.
  registry.register(new SyntheticProvider({
    resolveProvider: options.resolveProvider,
    getCatalogModels: options.getCatalogModels,
    getBenchmarks: options.getBenchmarks,
    runtimeBus: options.runtimeBus,
  }));
}
