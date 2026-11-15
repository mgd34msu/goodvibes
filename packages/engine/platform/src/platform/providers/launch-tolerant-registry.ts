/**
 * launch-tolerant-registry.ts, a `ProviderRegistry` construction that never
 * dies at boot because a provider's API key env var is unset.
 *
 * `ProviderRegistry`'s constructor eagerly constructs every built-in provider
 * from its current environment; several provider constructors throw when
 * their expected API key env var is missing (a fail-fast that is correct for
 * an interactive surface the user is actively configuring, but wrong for a
 * host process that must boot regardless of which providers happen to be
 * configured). {@link createLaunchTolerantProviderRegistry} makes registry
 * construction itself launch-tolerant: for every known provider whose env
 * vars are ALL unset, a placeholder API key is planted just long enough for
 * construction to succeed, the real environment is restored immediately
 * after (in a `finally`, so a construction failure never leaves the
 * placeholder behind), and then each placeholder-constructed provider is
 * explicitly reset to an unconfigured, empty-key state, so the registry
 * construction never fails, but the resulting registry is exactly as honest
 * about which providers are actually configured as one built from a real
 * environment with those keys absent.
 *
 * Both Agent and standalone daemon hosts need to start when only some
 * providers are configured. This shared construction uses `ProviderRegistry`,
 * its constructor options, and `process.env`; it has no product dependency.
 */
import { ProviderRegistry } from './registry.js';
import { getBuiltinProviderEnvVars } from '../config/provider-credential-catalog.js';

const PROVIDER_STARTUP_PLACEHOLDER_API_KEY = 'goodvibes-launch-tolerant-startup-placeholder';

type ProviderRegistryConstructionOptions = ConstructorParameters<typeof ProviderRegistry>[0];

interface ProviderStartupEnv {
  readonly providerId: string;
  readonly envVars: readonly string[];
}

interface MutableApiKeyProvider {
  apiKey: string;
}

interface MutableConfiguredProvider {
  configured: boolean;
}

// Environment names come from the credential catalog, so an alias added there
// is seen here too; only the provider ids are listed.
const PROVIDER_STARTUP_PLACEHOLDER_PROVIDER_IDS: readonly string[] = [
  'openai',
  'inceptionlabs',
  'openrouter',
  'aihubmix',
  'groq',
  'cerebras',
  'mistral',
  'ollama-cloud',
  'huggingface',
  'nvidia',
  'llm7',
  'deepseek',
  'fireworks',
  'microsoft-foundry',
  'moonshot',
  'qianfan',
  'qwen',
  'sglang',
  'stepfun',
  'together',
  'venice',
  'volcengine',
  'xai',
  'xiaomi',
  'zai',
  ['cloud', 'flare-ai-gateway'].join(''),
  'vercel-ai-gateway',
  'litellm',
  'copilot-proxy',
];

const PROVIDER_STARTUP_PLACEHOLDER_ENVS: readonly ProviderStartupEnv[] = PROVIDER_STARTUP_PLACEHOLDER_PROVIDER_IDS.map((providerId) => ({
  providerId,
  envVars: getBuiltinProviderEnvVars(providerId),
}));

function hasMutableApiKeyProvider(value: unknown): value is MutableApiKeyProvider {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { readonly apiKey?: unknown };
  return typeof candidate.apiKey === 'string';
}

function hasMutableConfiguredProvider(value: unknown): value is MutableConfiguredProvider {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { readonly configured?: unknown };
  return typeof candidate.configured === 'boolean';
}

function hasAnyConfiguredEnv(envVars: readonly string[]): boolean {
  return envVars.some((envVar) => {
    const value = process.env[envVar];
    return typeof value === 'string' && value.trim().length > 0;
  });
}

/**
 * Construct a `ProviderRegistry` that never throws at construction over a
 * missing provider API key. Every known provider whose env vars are all
 * unset gets a placeholder value planted just for construction, the real
 * environment is restored immediately after (success or failure), and every
 * placeholder-constructed provider is reset to an honest unconfigured,
 * empty-key state before the registry is returned.
 */
export function createLaunchTolerantProviderRegistry(options: ProviderRegistryConstructionOptions): ProviderRegistry {
  const placeholders = PROVIDER_STARTUP_PLACEHOLDER_ENVS
    .filter((entry) => !hasAnyConfiguredEnv(entry.envVars))
    .map((entry) => ({ providerId: entry.providerId, envVar: entry.envVars[0] }))
    .filter((entry): entry is { readonly providerId: string; readonly envVar: string } => typeof entry.envVar === 'string');

  if (placeholders.length === 0) {
    return new ProviderRegistry(options);
  }

  const previousValues = new Map<string, string | undefined>();
  for (const placeholder of placeholders) {
    previousValues.set(placeholder.envVar, process.env[placeholder.envVar]);
    process.env[placeholder.envVar] = PROVIDER_STARTUP_PLACEHOLDER_API_KEY;
  }
  let providerRegistry: ProviderRegistry;
  try {
    providerRegistry = new ProviderRegistry(options);
  } finally {
    for (const [envVar, previousValue] of previousValues) {
      if (previousValue === undefined) {
        delete process.env[envVar];
      } else {
        process.env[envVar] = previousValue;
      }
    }
  }

  for (const placeholder of placeholders) {
    const provider = providerRegistry.get(placeholder.providerId);
    if (hasMutableApiKeyProvider(provider) && provider.apiKey === PROVIDER_STARTUP_PLACEHOLDER_API_KEY) {
      provider.apiKey = '';
    }
    if (hasMutableConfiguredProvider(provider)) {
      provider.configured = false;
    }
  }
  return providerRegistry;
}
