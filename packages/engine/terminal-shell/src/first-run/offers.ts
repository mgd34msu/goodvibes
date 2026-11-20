/**
 * First run's step 1: which providers it lists, in what order, and what it
 * already found (a model server on this computer, a key in the environment).
 *
 * Pure: it reads views of facts the program already holds (the provider
 * registry's configured state, the local scan's result, the environment) and
 * starts nothing. `gatherFirstRunFacts` in first-run-flow.ts builds the views.
 */
import { describeAuthRouteForPerson } from '@goodvibes-jev/engine/platform/platform/providers/auth-route-presentation';
import type { ProviderDeclaredAuthRoute } from '@goodvibes-jev/engine/platform/platform/providers';

export type OfferRoute = 'browser-sign-in' | 'api-key' | 'local' | 'none-needed';

export interface ProviderOffer {
  /** Registry id; never shown. Empty for the local row before a server is found. */
  readonly providerId: string;
  /** "ChatGPT subscription", "Anthropic", "OpenRouter", "A model on this computer". */
  readonly name: string;
  /** "sign in with your browser" | "paste an API key" | "" (the local row says what it found instead). */
  readonly how: string;
  /** "has a free model" | "found Ollama with 3 models" | "looking for models on this computer…" | "none found". */
  readonly extra?: { readonly text: string; readonly tone: 'plain' | 'good' | 'faint' } | undefined;
  readonly route: OfferRoute;
  /** Usable now with nothing more to do. */
  readonly ready: boolean;
}

export interface FirstRunOffers {
  /** The first-screen rows, in order ("Another provider…" is drawn after them from `more`). */
  readonly rows: readonly ProviderOffer[];
  /** Registered providers not in `rows`. */
  readonly more: number;
  /** The first key set in the environment that makes a provider usable. */
  readonly foundKey?: { readonly variable: string; readonly providerId: string; readonly name: string } | undefined;
  readonly localScan: 'running' | 'done' | 'off';
}

/** One registered provider, as step 1 reads it. */
export interface ProviderFact {
  readonly id: string;
  /** The sign-in routes the provider declares. */
  readonly routes: readonly ProviderDeclaredAuthRoute[];
  /** Usable now (the configured-status answer). */
  readonly ready: boolean;
  /** Where its credential comes from when it is usable ('env' for a key in the environment). */
  readonly configuredVia?: 'env' | 'secrets' | 'subscription' | 'anonymous' | undefined;
  /** The environment variables it reads its key from, in its own order. */
  readonly envVars: readonly string[];
  /** Its catalog lists a model whose tier is free. */
  readonly hasFreeModel: boolean;
  /** Registered by the local scan (a model server on this computer). */
  readonly discovered: boolean;
  /** Its name for people ("Anthropic"), when the registry has one. */
  readonly label?: string | undefined;
}

export interface ProviderRegistryView {
  readonly providers: readonly ProviderFact[];
}

export interface DiscoveryView {
  readonly state: 'running' | 'done' | 'off';
  /** Model servers found on this computer: their names and model counts. */
  readonly servers: readonly { readonly name: string; readonly models: number }[];
}

export interface EnvView {
  isSet(name: string): boolean;
}

/** The fixed first screen (code, not taste): provider id, its name for people, and the route its row offers. */
export const FIRST_SCREEN_PROVIDERS: readonly { readonly providerId: string; readonly name: string; readonly route: ProviderDeclaredAuthRoute }[] = [
  { providerId: 'openai', name: 'ChatGPT subscription', route: 'subscription-oauth' },
  { providerId: 'anthropic', name: 'Anthropic', route: 'api-key' },
  { providerId: 'openrouter', name: 'OpenRouter', route: 'api-key' },
];

export const LOCAL_OFFER_NAME = 'A model on this computer';

function offerRoute(route: ProviderDeclaredAuthRoute): OfferRoute {
  if (route === 'subscription-oauth') return 'browser-sign-in';
  if (route === 'anonymous' || route === 'none') return 'none-needed';
  return 'api-key';
}

/** "Ollama", "Ollama and LM Studio", "Ollama, LM Studio and llama.cpp". */
function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function localRow(discovery: DiscoveryView, discoveredIds: readonly string[]): ProviderOffer {
  const servers = discovery.servers.filter((server) => server.models > 0);
  if (servers.length > 0) {
    const models = servers.reduce((sum, server) => sum + server.models, 0);
    return {
      providerId: discoveredIds[0] ?? servers[0]!.name,
      name: LOCAL_OFFER_NAME,
      how: '',
      extra: { text: `found ${listNames(servers.map((server) => server.name))} with ${models} model${models === 1 ? '' : 's'}`, tone: 'good' },
      route: 'local',
      ready: true,
    };
  }
  return {
    providerId: '',
    name: LOCAL_OFFER_NAME,
    how: '',
    extra: discovery.state === 'done'
      ? { text: 'none found', tone: 'faint' }
      : { text: 'looking for models on this computer…', tone: 'faint' },
    route: 'local',
    ready: false,
  };
}

/**
 * Step 1's rows: the fixed first screen (a provider the registry does not
 * have, or whose row's route it does not declare, is left out), then the row
 * for every model server found on this computer. `more` counts the other
 * registered providers. `foundKey` is the first provider, first-screen ones
 * first, whose key in the environment makes it usable.
 */
export function readFirstRunOffers(registry: ProviderRegistryView, discovered: DiscoveryView, env: EnvView): FirstRunOffers {
  const byId = new Map(registry.providers.map((provider) => [provider.id, provider]));
  const rows: ProviderOffer[] = [];
  for (const entry of FIRST_SCREEN_PROVIDERS) {
    const fact = byId.get(entry.providerId);
    if (!fact || !fact.routes.includes(entry.route)) continue;
    const how = describeAuthRouteForPerson(entry.route);
    if (!how) continue;
    rows.push({
      providerId: entry.providerId,
      name: entry.name,
      how,
      ...(fact.hasFreeModel ? { extra: { text: 'has a free model', tone: 'plain' as const } } : {}),
      route: offerRoute(entry.route),
      ready: fact.ready,
    });
  }
  const discoveredIds = registry.providers.filter((provider) => provider.discovered).map((provider) => provider.id);
  rows.push(localRow(discovered, discoveredIds));

  const shown = new Set([...FIRST_SCREEN_PROVIDERS.map((entry) => entry.providerId), ...discoveredIds]);
  const more = registry.providers.filter((provider) => !shown.has(provider.id)).length;

  const firstScreen = FIRST_SCREEN_PROVIDERS.map((entry) => byId.get(entry.providerId)).filter((fact): fact is ProviderFact => fact !== undefined);
  const others = registry.providers.filter((provider) => !FIRST_SCREEN_PROVIDERS.some((entry) => entry.providerId === provider.id) && !provider.discovered)
    .sort((a, b) => a.id.localeCompare(b.id));
  let foundKey: FirstRunOffers['foundKey'];
  for (const fact of [...firstScreen, ...others]) {
    if (!fact.ready || fact.configuredVia !== 'env') continue;
    const variable = fact.envVars.find((name) => env.isSet(name));
    if (!variable) continue;
    foundKey = { variable, providerId: fact.id, name: fact.label ?? fact.id };
    break;
  }
  return { rows, more, ...(foundKey ? { foundKey } : {}), localScan: discovered.state };
}
