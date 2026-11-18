/**
 * failover.ts, the one owner of what happens when the selected model fails.
 *
 * A failover never downgrades on its own judgement:
 *   1. The same model on another sign-in of the same maker comes first. A
 *      provider with more than one sign-in (OpenAI: ChatGPT subscription,
 *      then API key) does this inside its own request, before the failure
 *      reaches here, and its response says which sign-in answered and why.
 *   2. Only when no sign-in of the maker serves the model does the turn move
 *      to another model, and then only by the person's own fallback order
 *      (`provider.fallbackModels`), first entry not yet tried this turn whose
 *      provider is signed in.
 *   3. With no order set, or every entry tried, it stops and says so: what
 *      failed, why nothing else was tried, and what to do next. No model is
 *      picked for the person by list position, tier or age.
 *
 * Code decides all of it from facts the program holds (the setting, the
 * registry, whether a provider is signed in); no model is asked and no
 * request is made, so a failure costs nothing extra to judge.
 */
import type { LLMProvider } from './interface.js';
import type { ModelDefinition } from './registry-types.js';

/** What the registry must answer for a failover choice. */
export interface FailoverRegistry {
  listModels(): readonly ModelDefinition[];
  tryGet(name: string): LLMProvider | undefined;
}

export type FailoverChoice =
  | {
    readonly kind: 'switch';
    /** The model to answer instead, `provider:model`. */
    readonly registryKey: string;
    readonly provider: string;
    readonly displayName: string;
    /** Why this model, in words: its place in the person's fallback order. */
    readonly because: string;
  }
  | {
    readonly kind: 'stop';
    /** Why nothing else was tried. */
    readonly reason: string;
    /** What the person can do next. */
    readonly next: string;
  };

export interface FailoverRequest {
  readonly registry: FailoverRegistry;
  /** The model that failed. */
  readonly current: Pick<ModelDefinition, 'registryKey' | 'provider' | 'displayName'>;
  /** Registry keys already tried this turn, the failed one included. */
  readonly visited: Iterable<string>;
  /** The person's fallback order (`provider.fallbackModels`), provider-qualified model ids. */
  readonly fallbackOrder: readonly string[];
}

const NEXT_STEP = 'Retry, choose another model with /model, or set provider.fallbackModels to the models to move to, in order.';

/** A provider counts as signed in unless it says it is not. */
function signedIn(provider: LLMProvider | undefined): boolean {
  return provider !== undefined && (provider.isConfigured?.() ?? true);
}

export function chooseFailover(request: FailoverRequest): FailoverChoice {
  const visited = new Set(request.visited);
  visited.add(request.current.registryKey);
  const order = request.fallbackOrder.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (order.length === 0) {
    return {
      kind: 'stop',
      reason: `${request.current.displayName} failed on every sign-in of ${request.current.provider}, and no fallback order is set, so no other model was tried.`,
      next: NEXT_STEP,
    };
  }
  const models = request.registry.listModels();
  const skipped: string[] = [];
  for (const [position, entry] of order.entries()) {
    if (visited.has(entry)) continue;
    const separator = entry.indexOf(':');
    const providerId = separator > 0 ? entry.slice(0, separator) : '';
    const modelId = separator > 0 ? entry.slice(separator + 1) : entry;
    const provider = providerId ? request.registry.tryGet(providerId) : undefined;
    if (!signedIn(provider)) {
      skipped.push(`${entry} (${provider ? 'not signed in' : 'unknown provider'})`);
      continue;
    }
    // The person's own words: a model no list names yet is still attempted.
    const listed = models.find((model) => model.registryKey === entry)
      ?? models.find((model) => model.id === modelId && model.provider === provider!.name);
    return {
      kind: 'switch',
      registryKey: listed?.registryKey ?? `${provider!.name}:${modelId}`,
      provider: provider!.name,
      displayName: listed?.displayName ?? modelId,
      because: `entry ${position + 1} of your fallback order (provider.fallbackModels)`,
    };
  }
  return {
    kind: 'stop',
    reason: `${request.current.displayName} failed on every sign-in of ${request.current.provider}, and every model in your fallback order was already tried this turn or cannot be used${skipped.length ? ` (${skipped.join(', ')})` : ''}.`,
    next: NEXT_STEP,
  };
}

/** The person's fallback order as the setting holds it. */
export function readFallbackOrder(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}
