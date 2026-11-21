// ---------------------------------------------------------------------------
// session-cost.ts, the one session-cost resolver every cost surface reads.
//
// model-pricing.ts next door answers "what does this model cost" for a single
// resolved model. This module is the layer above it: the resolution ORDER a
// surface applies when it has only a model id, the honest unpriced state, the
// session total, and the budget-alert policy that total is compared against.
//
// Every function here takes the `SessionPricing` it prices with: the
// ProviderRegistry the caller's runtime holds. There is no process-wide
// pricing state, so the terminal app, the Agent and the daemon price the same
// usage the same way.
//
// Pricing resolution order (resolvePricing):
//   1. The registry's resolveModelPricing: manual `pricing.modelPrices`
//      -> registration -> provider-served -> catalog -> honest unknown.
//   2. The registry's live model catalog: an exact ID or published canonical
//      identity.
//   3. STATIC_FALLBACK_PRICING, a small hand-maintained safety net for common
//      frontier models: exact keys only. Unmatched IDs remain unpriced.
//   4. Unpriced: the model is genuinely unknown to every source above. This is
//      reported explicitly via `priced: false` so consumers can render an
//      honest "unpriced" state instead of a silent $0.
//
// Money is computed in exactly one place: every price goes through
// computeUsageCostUsd, which applies the source's explicit cache rates (or the
// provider's published cache ratios from the registry) rather than billing
// cache traffic at the full input rate. The provider is the one the model id
// names (`provider:model`), so the session total agrees with the per-request
// costs the turn loop sums.
// ---------------------------------------------------------------------------

import { computeUsageCostUsd, type ResolvedModelPricing } from './model-pricing.js';
import type { CatalogModel } from './model-catalog.js';
import type { ProviderRegistry } from './registry.js';
import { ModelIdentityResolver, type IdentityCandidate } from '../routing/model-identity.js';

/** What a session cost is priced with: the caller's ProviderRegistry. */
export type SessionPricing = Pick<ProviderRegistry, 'resolveModelPricing' | 'getRawCatalogModels' | 'cacheRatios'>;

export interface ModelPricing {
  input: number;
  output: number;
}

/**
 * Where a resolved price came from, for the render-side source distinction:
 * 'user' = the manual pricing.modelPrices entry ("your price"), 'provider' =
 * served by the provider API, 'catalog' = the live model catalog (dated),
 * 'fallback' = this module's small built-in safety net.
 */
export type PricingSourceKind = 'user' | 'provider' | 'catalog' | 'fallback';

/** Result of a pricing lookup: the resolved (possibly zero) price, and whether it's real. */
export interface PricingResult {
  pricing: ModelPricing;
  /** False when no source recognized the model, the zero pricing is a placeholder, not a real price. */
  priced: boolean;
  /** Which source priced the model (present only when priced). */
  source?: PricingSourceKind;
  /** ISO date (YYYY-MM-DD) of the catalog/provider snapshot the price came from, when known. */
  asOf?: string;
}

// Hand-maintained safety net, used only when neither the registry's resolver
// nor its live catalog recognizes the model. NOT the primary pricing source,
// see resolvePricing() below.
const STATIC_FALLBACK_PRICING: Record<string, ModelPricing> = {
  // Free tier
  'openrouter/free': { input: 0, output: 0 },

  // InceptionLabs
  'mercury-2':    { input: 0.50, output: 1.50 },
  'mercury-edit': { input: 0.50, output: 1.50 },

  // OpenAI
  'gpt-5.4':              { input: 5,    output: 15 },
  'gpt-5.3-chat-latest':  { input: 3,    output: 10 },
  'gpt-5-mini':           { input: 0.15, output: 0.60 },
  'gpt-5-nano':           { input: 0.05, output: 0.20 },
  'gpt-oss-120b':         { input: 0,    output: 0 },

  // Anthropic
  'claude-opus-4-6':   { input: 15,   output: 75 },
  'claude-sonnet-4-6': { input: 3,    output: 15 },
  'claude-haiku-4-5':  { input: 0.80, output: 4 },

  // Google
  'gemini-3.1-pro':        { input: 1.25,  output: 5 },
  'gemini-3-flash':        { input: 0.075, output: 0.30 },
  'gemini-3.1-flash-lite': { input: 0.02,  output: 0.10 },
  'gemini-2.5-pro':        { input: 1.25,  output: 5 },
};

const STATIC_CANDIDATES: readonly IdentityCandidate[] = Object.keys(STATIC_FALLBACK_PRICING).map((key) => ({ key, id: key }));

const staticIdentity = new ModelIdentityResolver({ candidates: () => STATIC_CANDIDATES });

function catalogPricing(model: CatalogModel): ModelPricing | null {
  return model.tier === 'free' ? { input: 0, output: 0 } : model.pricing;
}

/**
 * The catalog's price for a model id: an exact id, else the entry with the
 * same published identity. Reached only when the registry's resolver priced
 * nothing, so the identity table is built here, for this catalog.
 */
function findInCatalog(modelId: string, models: readonly CatalogModel[]): ModelPricing | null {
  const exact = models.find((m) => m.id === modelId);
  if (exact) return catalogPricing(exact);
  if (models.length === 0) return null;
  const candidates: readonly IdentityCandidate[] = models.map((m) => ({ key: m.id, id: m.id, name: m.name, provider: m.providerId, canonicalModelId: m.canonicalModelId }));
  const catalogIdentity = new ModelIdentityResolver({ candidates: () => candidates });
  const same = catalogIdentity.lookup({ id: modelId }, 'providers.session-cost.catalog-identity');
  const match = same === null ? undefined : models.find((m) => m.id === same);
  return match ? catalogPricing(match) : null;
}

function findInStaticFallback(modelId: string): ModelPricing | null {
  const exact = STATIC_FALLBACK_PRICING[modelId];
  if (exact) return exact;
  const same = staticIdentity.lookup({ id: modelId }, 'providers.session-cost.static-identity');
  return same === null ? null : STATIC_FALLBACK_PRICING[same] ?? null;
}

interface PricingQuote {
  readonly metadata: PricingResult;
  readonly resolved?: Extract<ResolvedModelPricing, { status: 'priced' }>;
}

/** The provider a provider-qualified model id (`provider:model`) names, when it names one. */
function providerOfModelId(modelId: string): string | undefined {
  const separator = modelId.indexOf(':');
  return separator > 0 ? modelId.slice(0, separator) : undefined;
}

/** Resolve once so an amount and its provenance always describe the same quote. */
function resolvePricingQuote(pricing: SessionPricing, modelId: string, providerId?: string): PricingQuote {
  const resolved = pricing.resolveModelPricing(modelId, providerId);
  if (resolved.status === 'priced') {
    return {
      metadata: {
        pricing: { input: resolved.rates.inputPerMTok, output: resolved.rates.outputPerMTok },
        priced: true,
        source: resolved.source,
        ...(resolved.asOf ? { asOf: resolved.asOf } : {}),
      },
      resolved,
    };
  }
  const catalogHit = findInCatalog(modelId, pricing.getRawCatalogModels());
  if (catalogHit) return { metadata: { pricing: catalogHit, priced: true, source: 'catalog' } };
  const fallbackHit = findInStaticFallback(modelId);
  if (fallbackHit) return { metadata: { pricing: fallbackHit, priced: true, source: 'fallback' } };
  return { metadata: { pricing: { input: 0, output: 0 }, priced: false } };
}

/**
 * resolvePricing, resolve USD-per-1M-token pricing for a model ID, and
 * whether that pricing is real (vs. an unpriced placeholder). See the module
 * header for the full resolution order.
 */
export function resolvePricing(pricing: SessionPricing, modelId: string): PricingResult {
  return resolvePricingQuote(pricing, modelId).metadata;
}

/** The amount and provenance of one session-usage pricing lookup. */
export interface SessionCostResult {
  readonly cost: number;
  readonly priced: boolean;
  readonly source?: PricingSourceKind;
  readonly asOf?: string;
}

/**
 * Price usage and record its source from one quote, including cache rates.
 * `providerId` is the provider the usage was billed by; absent, the one a
 * provider-qualified model id names is used.
 */
export function resolveSessionCost(
  pricing: SessionPricing,
  inputTokens: number,
  outputTokens: number,
  cacheRead: number,
  cacheWrite: number,
  modelId: string,
  providerId?: string,
): SessionCostResult {
  const { metadata, resolved } = resolvePricingQuote(pricing, modelId, providerId);
  const billedBy = providerId ?? providerOfModelId(modelId);
  // A price from the catalog or the built-in table carries no cache rates of
  // its own; it is priced by the same function with the provider's ratios.
  const priced: Extract<ResolvedModelPricing, { status: 'priced' }> = resolved ?? {
    status: 'priced',
    source: 'catalog',
    rates: { inputPerMTok: metadata.pricing.input, outputPerMTok: metadata.pricing.output },
  };
  const cost = computeUsageCostUsd(priced, { inputTokens, outputTokens, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite }, billedBy,
    billedBy ? pricing.cacheRatios(billedBy) : undefined) ?? 0;
  return {
    cost,
    priced: metadata.priced,
    ...(metadata.source ? { source: metadata.source } : {}),
    ...(metadata.asOf ? { asOf: metadata.asOf } : {}),
  };
}

/**
 * The render-side source distinction for a priced model: "your price" for a
 * manual pricing.modelPrices entry, "catalog price, as of <date>" (or
 * provider-served/built-in equivalents) otherwise. Null when the model is
 * unpriced, callers render the explicit "price unknown" marker instead.
 */
export function describePricingSource(pricing: SessionPricing, modelId: string): string | null {
  const result = resolvePricing(pricing, modelId);
  if (!result.priced) return null;
  switch (result.source) {
    case 'user':
      return 'your price';
    case 'provider':
      return result.asOf ? `provider price, as of ${result.asOf}` : 'provider price';
    case 'catalog':
      return result.asOf ? `catalog price, as of ${result.asOf}` : 'catalog price';
    case 'fallback':
      return 'built-in price';
    default:
      return 'catalog price';
  }
}

/** True when `modelId` resolves to a real price (free or paid), false when it's an unpriced placeholder. */
export function isModelPriced(pricing: SessionPricing, modelId: string): boolean {
  return resolvePricing(pricing, modelId).priced;
}

/**
 * calcSessionCost, compute total session cost in USD given raw token counters
 * and the active model ID. The one formula every cost surface totals with.
 *
 * inputTokens   , cumulative input tokens
 * outputTokens  , cumulative output tokens
 * cacheRead     , cumulative cache-read tokens
 * cacheWrite    , cumulative cache-write tokens
 * modelId       , registry model identifier
 *
 * Unpriced models contribute 0 to the total, only the display layer
 * distinguishes "genuinely free/priced" from "unpriced".
 */
export function calcSessionCost(
  pricing: SessionPricing,
  inputTokens: number,
  outputTokens: number,
  cacheRead: number,
  cacheWrite: number,
  modelId: string,
  providerId?: string,
): number {
  return resolveSessionCost(pricing, inputTokens, outputTokens, cacheRead, cacheWrite, modelId, providerId).cost;
}

/**
 * computeBudgetBreach, the pure predicate a render-time "OVER BUDGET" flag and
 * a background budget-breach notifier both read, so they agree on exactly one
 * definition of "over budget". `budgetThreshold <= 0` means no budget is
 * configured (disabled), which can never be breached.
 */
export function computeBudgetBreach(sessionCost: number, budgetThreshold: number): boolean {
  return budgetThreshold > 0 && sessionCost > budgetThreshold;
}

/** Read/write access to the `behavior.budgetAlertUsd` host-local config key.
 * Plain callbacks (rather than a ConfigManager reference) so a caller can pass a
 * generic-key-cast wrapper and this module keeps no dependency on the config
 * type layer. */
export interface BudgetAlertConfigAccess {
  readonly get: (key: string) => unknown;
  readonly set: (key: string, value: unknown) => void;
}

/** Default for the `behavior.budgetAlertUsd` synthetic setting: 0 = no budget configured. */
export const BUDGET_ALERT_USD_DEFAULT = 0;

/**
 * The dot-path config key backing the session cost-budget alert threshold.
 * Shared by every reader and writer of the threshold, a cost panel's get/set,
 * a settings surface's synthetic entry, and readBudgetAlertUsd below, so the
 * string literal lives in exactly one place.
 */
export const BUDGET_ALERT_USD_CONFIG_KEY = 'behavior.budgetAlertUsd';

/**
 * readBudgetAlertUsd, read the session cost-budget alert threshold (USD) from
 * config. The single source of truth a cost panel and a background
 * budget-breach notifier both read, so a threshold set in one is immediately
 * visible to the other. Falls back to BUDGET_ALERT_USD_DEFAULT (off) when the
 * key is absent or invalid.
 */
export function readBudgetAlertUsd(configGet: (key: string) => unknown): number {
  const raw = configGet(BUDGET_ALERT_USD_CONFIG_KEY);
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : BUDGET_ALERT_USD_DEFAULT;
}

/**
 * The settings key holding the user's manual per-model prices, the
 * highest-precedence source in the ONE pricing resolver. Object map of
 * `provider:model` -> { input, output, cacheRead?, cacheWrite? } in USD per
 * 1M tokens.
 */
export const MODEL_PRICES_CONFIG_KEY = 'pricing.modelPrices';

/**
 * Persist a manual price for one `provider:model` key into
 * pricing.modelPrices, preserving every other entry. The registry's resolver
 * reads the key live per call, so the new price is visible to every cost
 * surface on the next render, no restart.
 */
export function writeManualModelPrice(
  config: BudgetAlertConfigAccess,
  modelKey: string,
  price: { input: number; output: number },
): void {
  const current = config.get(MODEL_PRICES_CONFIG_KEY);
  const map: Record<string, unknown> =
    current && typeof current === 'object' && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};
  map[modelKey] = { input: price.input, output: price.output };
  config.set(MODEL_PRICES_CONFIG_KEY, map);
}
