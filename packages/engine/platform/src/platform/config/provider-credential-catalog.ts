/** Canonical declared credential names. No stored values, secrets or provider implementation. */
export const BUILTIN_PROVIDER_ENV_KEYS: Record<string, readonly string[]> = {
  openai: ['OPENAI_API_KEY', 'OPENAI_KEY'],
  anthropic: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GEMINI_API_KEY'],
  inceptionlabs: ['INCEPTION_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  aihubmix: ['AIHUBMIX_API_KEY'],
  groq: ['GROQ_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  'ollama-cloud': ['OLLAMA_CLOUD_API_KEY', 'OLLAMA_API_KEY'],
  huggingface: ['HF_API_KEY', 'HUGGINGFACE_API_KEY', 'HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN'],
  nvidia: ['NVIDIA_API_KEY', 'NIM_API_KEY'],
  llm7: ['LLM7_API_KEY'],
  // The names a Bedrock-family provider reads. Whether they configure it is the provider's own rule
  // (hasAwsCredentials: a bearer token, a full access-key pair, or a profile). AWS_REGION and
  // AWS_SESSION_TOKEN are not credentials and are not listed.
  'amazon-bedrock': ['AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_PROFILE'],
  'amazon-bedrock-mantle': ['AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_PROFILE'],
  'anthropic-vertex': ['GOOGLE_APPLICATION_CREDENTIALS', 'ANTHROPIC_VERTEX_PROJECT_ID', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT_ID'],
  deepseek: ['DEEPSEEK_API_KEY'],
  fireworks: ['FIREWORKS_API_KEY'],
  // GH_TOKEN and GITHUB_TOKEN are repository credentials, not a Copilot grant.
  'github-copilot': ['COPILOT_GITHUB_TOKEN'],
  'microsoft-foundry': ['AZURE_OPENAI_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  moonshot: ['MOONSHOT_API_KEY'],
  qianfan: ['QIANFAN_API_KEY'],
  qwen: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY', 'MODELSTUDIO_API_KEY'],
  sglang: ['SGLANG_API_KEY'],
  stepfun: ['STEPFUN_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  venice: ['VENICE_API_KEY'],
  volcengine: ['VOLCANO_ENGINE_API_KEY'],
  xai: ['XAI_API_KEY'],
  xiaomi: ['XIAOMI_API_KEY'],
  zai: ['ZAI_API_KEY', 'Z_AI_API_KEY'],
  'cloudflare-ai-gateway': ['CLOUDFLARE_AI_GATEWAY_API_KEY'],
  'vercel-ai-gateway': ['AI_GATEWAY_API_KEY'],
  litellm: ['LITELLM_API_KEY'],
  'copilot-proxy': ['COPILOT_PROXY_API_KEY'],
  perplexity: ['PERPLEXITY_API_KEY'],
  cohere: ['COHERE_API_KEY', 'CO_API_KEY'],
  deepinfra: ['DEEPINFRA_API_KEY'],
  sambanova: ['SAMBANOVA_API_KEY'],
  'opencode-zen': ['OPENCODE_ZEN_API_KEY', 'OPENCODE_API_KEY'],
  zenmux: ['ZENMUX_API_KEY'],
  'zenmux-anthropic': ['ZENMUX_API_KEY'],
  deepgram: ['DEEPGRAM_API_KEY'],
  elevenlabs: ['ELEVENLABS_API_KEY', 'XI_API_KEY'],
  microsoft: [],
  vydra: ['VYDRA_API_KEY'],
  byteplus: ['BYTEPLUS_API_KEY'],
  fal: ['FAL_KEY', 'FAL_API_KEY'],
  comfy: ['COMFY_API_KEY'],
  runway: ['RUNWAYML_API_SECRET', 'RUNWAY_API_KEY'],
  alibaba: ['MODELSTUDIO_API_KEY', 'DASHSCOPE_API_KEY', 'QWEN_API_KEY'],
};

/**
 * Chat providers whose credential is one plain API key, resolved from the
 * environment and then the secrets store under the names above. Cloud IAM
 * providers (Bedrock, Vertex) and media or voice services are left out.
 */
export const API_KEY_PROVIDER_IDS: readonly string[] = [
  'openai', 'anthropic', 'gemini', 'inceptionlabs', 'openrouter', 'aihubmix', 'groq', 'cerebras', 'mistral',
  'ollama-cloud', 'huggingface', 'nvidia', 'llm7', 'deepseek', 'fireworks', 'github-copilot', 'microsoft-foundry',
  'minimax', 'moonshot', 'qianfan', 'qwen', 'sglang', 'stepfun', 'together', 'venice', 'volcengine', 'xai',
  'xiaomi', 'zai', 'cloudflare-ai-gateway', 'vercel-ai-gateway', 'litellm', 'copilot-proxy',
  'perplexity', 'cohere', 'deepinfra', 'sambanova', 'opencode-zen', 'zenmux', 'zenmux-anthropic',
];

export function getBuiltinProviderEnvVars(providerId: string): readonly string[] {
  return Object.hasOwn(BUILTIN_PROVIDER_ENV_KEYS, providerId) ? BUILTIN_PROVIDER_ENV_KEYS[providerId]! : [];
}


/** Unknown names stay unclassified. Exact producer declarations need no semantic inference. */
export function readDeclaredProviderCredential(providerId: string, key: string): boolean | undefined {
  const declared = Object.hasOwn(BUILTIN_PROVIDER_ENV_KEYS, providerId) ? BUILTIN_PROVIDER_ENV_KEYS[providerId] : undefined;
  if (!declared || !Object.values(BUILTIN_PROVIDER_ENV_KEYS).some(keys => keys.includes(key))) return undefined;
  return declared.includes(key);
}
