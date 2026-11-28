import type { OpenAICompatOptions } from './openai-compat.js';
import type { AnthropicCompatOptions } from './anthropic-compat.js';
import { WELL_KNOWN_LOCAL_ENDPOINTS } from './well-known-endpoints.js';

export interface BuiltinProviderDefinition {
  readonly id: string;
  readonly label: string;
  /** Declared setup evidence for runtime presentation, not classification or routing. */
  readonly setupDescription?: string | undefined;
  readonly envVars: readonly string[];
  readonly serviceNames?: readonly string[] | undefined;
  readonly aliases?: readonly string[] | undefined;
  readonly subscriptionProviderId?: string | undefined;
}

export interface BuiltinOpenAICompatDefinition extends BuiltinProviderDefinition {
  readonly kind: 'openai-compat';
  readonly baseURL: string;
  /**
   * 'openai-endpoint' (default) = live discovery from GET {baseURL}/models;
   * 'none' = the backend has no listing API (each 'none' is verified against
   * the backend's documentation, never assumed).
   */
  readonly modelListing?: 'openai-endpoint' | 'none' | undefined;
  /** Override the model-listing URL when it is not {baseURL}/models. */
  readonly modelListingUrl?: string | undefined;
  readonly embeddingModel?: string | undefined;
  readonly reasoningFormat?: OpenAICompatOptions['reasoningFormat'] | undefined;
  readonly suppressedModelRegistryKeys?: readonly string[] | undefined;
  readonly streamProtocol?: string | undefined;
  readonly defaultHeaders?: Record<string, string> | undefined;
  readonly allowAnonymous?: boolean | undefined;
  readonly anonymousConfigured?: boolean | undefined;
  readonly anonymousDetail?: string | undefined;
}

export interface BuiltinAnthropicCompatDefinition extends BuiltinProviderDefinition {
  readonly kind: 'anthropic-compat';
  readonly baseURL: string;
  /**
   * 'anthropic-endpoint' (default) = live discovery from GET {baseURL}/models;
   * 'none' = the backend has no listing API (each 'none' is verified against
   * the backend's documentation, never assumed).
   */
  readonly modelListing?: 'anthropic-endpoint' | 'none' | undefined;
  /** Override the model-listing URL when it is not {baseURL}/models. */
  readonly modelListingUrl?: string | undefined;
  readonly defaultHeaders?: Record<string, string> | undefined;
  readonly authHeaderMode?: AnthropicCompatOptions['authHeaderMode'] | undefined;
  readonly streamProtocol?: string | undefined;
  readonly allowAnonymous?: boolean | undefined;
  readonly anonymousConfigured?: boolean | undefined;
  readonly anonymousDetail?: string | undefined;
}

export type BuiltinCompatDefinition =
  | BuiltinOpenAICompatDefinition
  | BuiltinAnthropicCompatDefinition;

export { BUILTIN_PROVIDER_ENV_KEYS, getBuiltinProviderEnvVars } from '../config/provider-credential-catalog.js';
import { getBuiltinProviderEnvVars } from '../config/provider-credential-catalog.js';

/**
 * Built-in compat providers declare only stable transport and auth metadata;
 * model lists and default models are never hardcoded here and resolve
 * programmatically from live discovery and the `models.dev` benchmark catalog.
 *
 * Reasoning-format audit, 2026-07-25: every entry below without an explicit
 * `reasoningFormat` sends no reasoning parameter at all. That is deliberate,
 * not an oversight, a format is only declared for a backend whose own current
 * documentation was read and cited at the entry. The rest stay silent because
 * guessing a field name earns a provider-side 400 on every turn, which is worse
 * than the setting having no effect. Re-audit an entry by reading its docs and
 * adding a cited `reasoningFormat`.
 */
export const BUILTIN_COMPAT_PROVIDERS: readonly BuiltinCompatDefinition[] = [
  {
    kind: 'openai-compat',
    id: 'deepseek',
    label: 'DeepSeek',
    // api-docs.deepseek.com/guides/thinking_mode documents `reasoning_effort`
    // with only `high` (default) and `max`; deepseek-reasoner takes no level at
    // all. Both facts live in the curated family table, so the format here only
    // ever carries a value that model accepts.
    reasoningFormat: 'reasoning-effort',
    envVars: getBuiltinProviderEnvVars('deepseek'),
    serviceNames: ['deepseek'],
    baseURL: 'https://api.deepseek.com',
    aliases: ['deepseek-ai'],
  },
  {
    kind: 'openai-compat',
    id: 'fireworks',
    label: 'Fireworks',
    envVars: getBuiltinProviderEnvVars('fireworks'),
    serviceNames: ['fireworks'],
    baseURL: 'https://api.fireworks.ai/inference/v1',
  },
  {
    kind: 'openai-compat',
    id: 'microsoft-foundry',
    label: 'Microsoft Foundry',
    setupDescription: 'Uses an Azure cloud account resource endpoint and account-scoped API key; usage is billed to that cloud account.',
    envVars: getBuiltinProviderEnvVars('microsoft-foundry'),
    serviceNames: ['microsoft-foundry'],
    // Placeholder until an endpoint is configured; see builtin-registry.ts.
    baseURL: 'https://endpoint-not-configured.invalid/openai/v1',
    aliases: ['azure-openai', 'azure-openai-responses'],
    streamProtocol: 'openai-sse',
  },
  {
    kind: 'anthropic-compat',
    id: 'minimax',
    // MiniMax's Anthropic-compatible surface has no models listing, but the
    // platform documents GET /v1/models on its OpenAI-style surface with the
    // same API key (platform.minimax.io, verified 2026-07-12).
    modelListingUrl: 'https://api.minimax.io/v1/models',
    label: 'MiniMax',
    envVars: getBuiltinProviderEnvVars('minimax'),
    serviceNames: ['minimax'],
    baseURL: 'https://api.minimax.io/anthropic',
    streamProtocol: 'anthropic-sse',
  },
  {
    kind: 'openai-compat',
    id: 'moonshot',
    label: 'Moonshot',
    envVars: getBuiltinProviderEnvVars('moonshot'),
    serviceNames: ['moonshot'],
    baseURL: 'https://api.moonshot.ai/v1',
  },
  {
    kind: 'openai-compat',
    id: 'qianfan',
    // Baidu Qianfan's v2 OpenAI-compatible docs describe only
    // chat/completions-style endpoints; the model catalog is a static
    // reference page, not a queryable API (verified 2026-07-12).
    modelListing: 'none',
    label: 'Qianfan',
    envVars: getBuiltinProviderEnvVars('qianfan'),
    serviceNames: ['qianfan'],
    baseURL: 'https://qianfan.baidubce.com/v2',
  },
  {
    kind: 'openai-compat',
    id: 'qwen',
    // Alibaba Model Studio's OpenAI-compatibility doc documents only
    // chat/completions on the compatible-mode surface; the model catalog is a
    // static reference page, not a queryable API (verified 2026-07-12).
    modelListing: 'none',
    label: 'Qwen',
    envVars: getBuiltinProviderEnvVars('qwen'),
    serviceNames: ['qwen'],
    baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    aliases: ['dashscope'],
  },
  {
    kind: 'openai-compat',
    id: 'sglang',
    label: 'SGLang',
    setupDescription: 'Operator-managed self-hosted model serving endpoint; setup and upstream charges belong to its operator.',
    envVars: getBuiltinProviderEnvVars('sglang'),
    serviceNames: ['sglang'],
    baseURL: 'http://127.0.0.1:30000/v1',
    allowAnonymous: true,
    anonymousConfigured: true,
    anonymousDetail: 'SGLang usually runs as a local OpenAI-compatible server.',
  },
  {
    kind: 'openai-compat',
    id: 'stepfun',
    // StepFun's API reference (platform.stepfun.ai/docs) documents only
    // chat/completions, files, and audio, no model-listing endpoint
    // (verified 2026-07-12).
    modelListing: 'none',
    label: 'StepFun',
    envVars: getBuiltinProviderEnvVars('stepfun'),
    serviceNames: ['stepfun'],
    baseURL: 'https://api.stepfun.ai/v1',
  },
  {
    kind: 'openai-compat',
    id: 'together',
    label: 'Together AI',
    envVars: getBuiltinProviderEnvVars('together'),
    serviceNames: ['together'],
    baseURL: 'https://api.together.xyz/v1',
  },
  {
    kind: 'openai-compat',
    id: 'venice',
    label: 'Venice',
    envVars: getBuiltinProviderEnvVars('venice'),
    serviceNames: ['venice'],
    baseURL: 'https://api.venice.ai/api/v1',
  },
  {
    kind: 'openai-compat',
    id: 'volcengine',
    // Volcengine Ark's v3 surface has no models listing: client.models.list()
    // 404s (volcengine/volc-sdk-python#46, unresolved) and no Ark doc
    // describes such an endpoint (verified 2026-07-12).
    modelListing: 'none',
    label: 'Volcengine',
    envVars: getBuiltinProviderEnvVars('volcengine'),
    serviceNames: ['volcengine'],
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    aliases: ['volcano-engine'],
  },
  {
    kind: 'openai-compat',
    id: 'xai',
    label: 'xAI',
    // docs.x.ai/docs/guides/reasoning documents `reasoning_effort` on chat
    // completions, with per-model value sets. The base grok-4 rejects the
    // parameter outright, which the curated family table already encodes, so
    // declaring the format here does not put it on a grok-4 request.
    reasoningFormat: 'reasoning-effort',
    envVars: getBuiltinProviderEnvVars('xai'),
    serviceNames: ['xai'],
    baseURL: 'https://api.x.ai/v1',
    aliases: ['x-ai'],
  },
  {
    kind: 'openai-compat',
    id: 'xiaomi',
    // Xiaomi MiMo's docs (mimo.mi.com) document only POST chat/completions
    // and the Anthropic-style messages endpoint, no model listing
    // (verified 2026-07-12).
    modelListing: 'none',
    label: 'Xiaomi MiMo',
    envVars: getBuiltinProviderEnvVars('xiaomi'),
    serviceNames: ['xiaomi'],
    baseURL: 'https://api.xiaomimimo.com/v1',
  },
  {
    kind: 'openai-compat',
    id: 'zai',
    // Z.ai's complete doc index (docs.z.ai/llms.txt) enumerates chat, agents,
    // audio, image, video, tokenizer, and search endpoints, no model-listing
    // endpoint exists on the paas/v4 surface (verified 2026-07-12).
    modelListing: 'none',
    label: 'Z.ai',
    envVars: getBuiltinProviderEnvVars('zai'),
    serviceNames: ['zai'],
    baseURL: 'https://api.z.ai/api/paas/v4',
    aliases: ['z-ai'],
  },
  {
    kind: 'openai-compat',
    id: 'cloudflare-ai-gateway',
    // Cloudflare AI Gateway's provider-endpoint docs show only POST
    // chat/completions and /responses passing through; a GET /models
    // passthrough is nowhere documented (verified 2026-07-12). The base URL is
    // built per account and gateway (see builtin-registry.ts); this one is the
    // template. The OpenAI endpoint passes the stored key through to OpenAI,
    // so only OpenAI models are listed.
    modelListing: 'none',
    label: 'Cloudflare AI Gateway',
    setupDescription: 'Routes OpenAI requests through your Cloudflare AI Gateway (account id from cloudflare.accountId or CLOUDFLARE_ACCOUNT_ID, gateway id from cloudflare.aiGatewayId or CLOUDFLARE_AI_GATEWAY_ID); the stored key is the OpenAI key the gateway passes on.',
    envVars: getBuiltinProviderEnvVars('cloudflare-ai-gateway'),
    serviceNames: ['cloudflare-ai-gateway'],
    baseURL: 'https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/openai',
    aliases: ['cloudflare-gateway'],
  },
  {
    kind: 'openai-compat',
    id: 'vercel-ai-gateway',
    label: 'Vercel AI Gateway',
    envVars: getBuiltinProviderEnvVars('vercel-ai-gateway'),
    serviceNames: ['vercel-ai-gateway'],
    baseURL: 'https://ai-gateway.vercel.sh/v1',
    aliases: ['ai-gateway'],
  },
  {
    kind: 'openai-compat',
    id: 'litellm',
    label: 'LiteLLM',
    envVars: getBuiltinProviderEnvVars('litellm'),
    serviceNames: ['litellm'],
    baseURL: `${WELL_KNOWN_LOCAL_ENDPOINTS.liteLLM}/v1`,
    allowAnonymous: true,
    anonymousConfigured: true,
    anonymousDetail: 'LiteLLM commonly runs as a local or self-hosted gateway.',
  },
  {
    kind: 'openai-compat',
    id: 'copilot-proxy',
    label: 'Copilot Proxy',
    envVars: getBuiltinProviderEnvVars('copilot-proxy'),
    serviceNames: ['copilot-proxy'],
    baseURL: `${WELL_KNOWN_LOCAL_ENDPOINTS.copilotProxy}/v1`,
    allowAnonymous: true,
    anonymousConfigured: true,
    anonymousDetail: 'Copilot Proxy is an operator-managed local gateway.',
  },
  {
    kind: 'openai-compat',
    id: 'cohere',
    label: 'Cohere',
    // Cohere's OpenAI-compatible surface is the Compatibility API, not its native v2 API.
    envVars: getBuiltinProviderEnvVars('cohere'),
    serviceNames: ['cohere'],
    baseURL: 'https://api.cohere.ai/compatibility/v1',
  },
  {
    kind: 'openai-compat',
    id: 'deepinfra',
    label: 'DeepInfra',
    envVars: getBuiltinProviderEnvVars('deepinfra'),
    serviceNames: ['deepinfra'],
    baseURL: 'https://api.deepinfra.com/v1/openai',
  },
  {
    kind: 'openai-compat',
    id: 'perplexity',
    label: 'Perplexity',
    envVars: getBuiltinProviderEnvVars('perplexity'),
    serviceNames: ['perplexity'],
    baseURL: 'https://api.perplexity.ai',
  },
  {
    kind: 'openai-compat',
    id: 'sambanova',
    label: 'SambaNova',
    envVars: getBuiltinProviderEnvVars('sambanova'),
    serviceNames: ['sambanova'],
    baseURL: 'https://api.sambanova.ai/v1',
  },
  {
    kind: 'openai-compat',
    id: 'opencode-zen',
    label: 'OpenCode Zen',
    // OpenCode Zen is served by OpenCode itself (opencode.ai/zen), not by ZenMux.
    envVars: getBuiltinProviderEnvVars('opencode-zen'),
    serviceNames: ['opencode-zen'],
    baseURL: 'https://opencode.ai/zen/v1',
  },
  {
    kind: 'openai-compat',
    id: 'zenmux',
    label: 'ZenMux',
    envVars: getBuiltinProviderEnvVars('zenmux'),
    serviceNames: ['zenmux'],
    baseURL: 'https://zenmux.ai/api/v1',
  },
  {
    kind: 'anthropic-compat',
    id: 'zenmux-anthropic',
    label: 'ZenMux (Anthropic)',
    envVars: getBuiltinProviderEnvVars('zenmux-anthropic'),
    serviceNames: ['zenmux'],
    baseURL: 'https://zenmux.ai/api/anthropic/v1',
  },
];
