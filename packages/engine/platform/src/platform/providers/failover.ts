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
 *
 * Every turn runs it the same way: the shared turn loop (core/turn-loop.ts)
 * offers a request that failed for good to the failover its caller built with
 * {@link createTurnFailover}, in the terminal app, `run`, the Agent, hosted
 * sessions, worker agents and the companion chat alike. The move lasts for the
 * rest of that turn; the next turn starts on the selected model again.
 */
import { ProviderError } from '../types/errors.js';
import { summarizeError } from '../utils/error-display.js';
import type { LLMProvider } from './interface.js';
import type { ModelDefinition } from './registry-types.js';

/** What the registry must answer for a failover choice. */
export interface FailoverRegistry {
  listModels(): readonly ModelDefinition[];
  tryGet(name: string): LLMProvider | undefined;
  /** The registered provider an entry's provider half names (id or display name, any case). */
  resolveProviderReference?(reference: string): string | undefined;
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
    // An entry may name its provider by id or display name: tried-ness is compared on the
    // registry key it resolves to (below), the same key the turn records as tried.
    if (visited.has(entry)) continue;
    const separator = entry.indexOf(':');
    const providerId = separator > 0 ? entry.slice(0, separator) : '';
    const modelId = separator > 0 ? entry.slice(separator + 1) : entry;
    const provider = providerId ? request.registry.tryGet(request.registry.resolveProviderReference?.(providerId) ?? providerId) : undefined;
    if (!signedIn(provider)) {
      skipped.push(`${entry} (${provider ? 'not signed in' : 'unknown provider'})`);
      continue;
    }
    // The person's own words: a model no list names yet is still attempted.
    const listed = models.find((model) => model.registryKey === entry)
      ?? models.find((model) => model.id === modelId && model.provider === provider!.name);
    const registryKey = listed?.registryKey ?? `${provider!.name}:${modelId}`;
    if (visited.has(registryKey)) continue;
    return {
      kind: 'switch',
      registryKey,
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

/** The model a turn is using, as a failover reads it. */
export type TurnFailoverModel = Pick<ModelDefinition, 'registryKey' | 'provider' | 'displayName'>;

export interface TurnFailoverOptions {
  readonly registry: FailoverRegistry;
  /** The fallback order, read at the failure: `provider.fallbackModels`, or a worker agent's own order. */
  readonly fallbackOrder: () => readonly string[];
  /** The model the turn's requests go to now. */
  readonly current: () => TurnFailoverModel;
  /** Sends the turn's later requests to the chosen model; throws when it cannot be used. */
  readonly switchTo: (choice: Extract<FailoverChoice, { kind: 'switch' }>) => void;
  /** Tells the person what happened: which model answers now, or why the turn stops. */
  readonly notify: (line: string, level: 'warning' | 'error') => void;
  /** What the move costs, as a suffix of the move's line (` [cost/1M: …]`); absent: nothing. */
  readonly describeCost?: ((from: TurnFailoverModel, to: Extract<FailoverChoice, { kind: 'switch' }>) => string) | undefined;
}

/**
 * The per-1M-token price change of a move, ` [cost/1M: input $a→$b, output
 * $c→$d]`, from what the registry knows; ` [cost data unavailable]` when
 * either side has no per-token price (unknown, or a subscription plan).
 */
export function describeFailoverCost(
  pricing: (modelId: string, providerId: string) => { readonly status: string; readonly rates?: { readonly inputPerMTok: number; readonly outputPerMTok: number } },
  from: TurnFailoverModel,
  to: Extract<FailoverChoice, { kind: 'switch' }>,
): string {
  const idOf = (registryKey: string): string => registryKey.slice(registryKey.indexOf(':') + 1);
  const fromPrice = pricing(idOf(from.registryKey), from.provider);
  const toPrice = pricing(idOf(to.registryKey), to.provider);
  if (fromPrice.status !== 'priced' || toPrice.status !== 'priced' || !fromPrice.rates || !toPrice.rates) return ' [cost data unavailable]';
  const usd = (value: number): string => `$${value.toFixed(2)}`;
  return ` [cost/1M: input ${usd(fromPrice.rates.inputPerMTok)}→${usd(toPrice.rates.inputPerMTok)}, output ${usd(fromPrice.rates.outputPerMTok)}→${usd(toPrice.rates.outputPerMTok)}]`;
}

/**
 * One turn's failover, for the turn loop's `failOver`. A provider failure
 * that reached it (the selected model already failed on every sign-in of its
 * provider, and its retries are spent) moves the turn to the next model of
 * the fallback order not yet tried this turn, says which model answers and
 * why, and returns true; with no order, or every entry tried, it says why
 * nothing else was tried and returns false, so the error ends the turn. Any
 * other failure (a refused hook, a cancelled request, a failed check) is not
 * the provider's and returns false at once.
 */
export function createTurnFailover(options: TurnFailoverOptions): (error: unknown) => boolean {
  const visited = new Set<string>();
  return (error) => {
    if (!(error instanceof ProviderError)) return false;
    const failed = options.current();
    visited.add(failed.registryKey);
    const reason = summarizeError(error);
    const why = reason.length > 200 ? `${reason.slice(0, 199)}…` : reason;
    for (;;) {
      const choice = chooseFailover({ registry: options.registry, current: failed, visited, fallbackOrder: options.fallbackOrder() });
      if (choice.kind === 'stop') {
        options.notify(`[Failover] Stopped: ${choice.reason} ${choice.next}`, 'error');
        return false;
      }
      visited.add(choice.registryKey);
      try {
        options.switchTo(choice);
      } catch (switchError) {
        options.notify(`[Failover] ${choice.registryKey} could not be used (${summarizeError(switchError)}); trying the next entry.`, 'warning');
        continue;
      }
      const cost = options.describeCost?.(failed, choice) ?? '';
      options.notify(
        `[Failover] ${failed.registryKey} -> ${choice.registryKey}, ${choice.because} (${why})${cost}. ${choice.displayName} answers the rest of this turn; the next turn starts on ${failed.registryKey} again.`,
        'warning',
      );
      return true;
    }
  };
}
