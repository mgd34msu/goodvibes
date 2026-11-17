/**
 * Whether a provider is set up, and by what means: the one answer the model
 * picker, the current-model read and the model switch give. It is read from
 * the provider's own auth routes (what the turn sends with), then the
 * environment, a stored key under one of the provider's names, anonymous
 * access, and finally the provider's own `isConfigured` (the key it was
 * registered with). One listing reads the secret stores once.
 */
import type { ProviderAuthRouteDescriptor, ProviderRuntimeMetadata } from './interface.js';
import { isProviderAuthRouteUsable } from './runtime-snapshot.js';
import { BUILTIN_COMPAT_PROVIDERS } from './builtin-catalog.js';
import { BUILTIN_PROVIDER_ENV_KEYS } from '../config/provider-credential-catalog.js';
import { BEDROCK_PROVIDER_LABELS, hasAwsCredentials } from './amazon-bedrock.js';

export type ConfiguredVia = 'env' | 'secrets' | 'subscription' | 'anonymous';

export interface ProviderConfiguredStatus {
  readonly configured: boolean;
  readonly configuredVia?: ConfiguredVia | undefined;
  readonly envVars: readonly string[];
  readonly routes?: readonly ProviderAuthRouteDescriptor[] | undefined;
}

/** What one provider contributes; gathered by the registry from one snapshot of the stores. */
export interface ProviderConfiguredInput {
  readonly providerId: string;
  /** The provider's runtime metadata; null when it describes none, undefined when describing it failed. */
  readonly runtime: ProviderRuntimeMetadata | null | undefined;
  /** Keys present in the secret stores (not the environment), from one listing. */
  readonly storedKeys: ReadonlySet<string>;
  /** The provider's own answer for the key it was registered with. */
  readonly selfConfigured: boolean | undefined;
}

function envSet(name: string): boolean {
  const value = process.env[name];
  return typeof value === 'string' && value.length > 0;
}

function viaFromRoutes(routes: readonly ProviderAuthRouteDescriptor[]): ConfiguredVia | undefined {
  const usable = routes.filter(isProviderAuthRouteUsable);
  if (usable.some((route) => route.route === 'subscription-oauth')) return 'subscription';
  if (usable.some((route) => route.route === 'secret-ref')) return 'secrets';
  const apiKey = usable.find((route) => route.route === 'api-key');
  if (apiKey) return (apiKey.envVars ?? []).some(envSet) ? 'env' : 'secrets';
  if (usable.some((route) => route.route === 'anonymous')) return 'anonymous';
  return undefined;
}

export function providerEnvVars(providerId: string): readonly string[] {
  return (BUILTIN_PROVIDER_ENV_KEYS[providerId] ?? []) as readonly string[];
}

export function resolveProviderConfiguredStatus(input: ProviderConfiguredInput): ProviderConfiguredStatus {
  const { providerId, runtime } = input;
  const envVars = providerEnvVars(providerId);
  const routes = runtime?.auth?.routes ?? [];
  const routesAuthoritative = runtime !== null && runtime !== undefined;
  // A Bedrock-family provider answers by its own rule: an access key id alone signs nothing.
  const hasEnv = Object.hasOwn(BEDROCK_PROVIDER_LABELS, providerId) ? hasAwsCredentials() : envVars.some(envSet);
  const catalog = BUILTIN_COMPAT_PROVIDERS.find((entry) => entry.id === providerId);
  // A provider that described its routes knows which stored names it accepts; the
  // stored-name and self-report tiers stand only for one that described none.
  const via = viaFromRoutes(routes)
    ?? (hasEnv ? 'env' : undefined)
    ?? (!routesAuthoritative && envVars.some((name) => input.storedKeys.has(name)) ? 'secrets' : undefined)
    ?? (catalog?.allowAnonymous && catalog.anonymousConfigured ? 'anonymous' : undefined)
    ?? (runtime === null && input.selfConfigured === true ? 'subscription' : undefined);
  const usableRoute = routes.some((route) => route.route !== 'none' && isProviderAuthRouteUsable(route));
  return {
    configured: via !== undefined || usableRoute,
    configuredVia: via,
    envVars,
    ...(routes.length > 0 ? { routes } : {}),
  };
}
