/**
 * What the composer's model menu (views/chat/ModelPicker.tsx) is built from:
 * one provider's row from the daemon's providers and models lists, and the
 * sentence `models.refresh`'s answer is said in.
 */
import { MODEL_PRICE_TIER_WORDS, type ModelPriceTier } from '@goodvibes/engine/platform/platform/providers/model-catalog-facts';
import { asRecord } from './object';
import { deriveProviderStatus } from './provider-status';
import type { ModelOption, ProviderOption } from './provider-models';
import type { PickerModel, PickerProvider } from '../views/chat/ModelPicker';

/**
 * A model's price tier in the platform's words (models.list `priceTier`: "free",
 * "paid", "subscription", "price not known"); undefined from a daemon that sends none.
 */
export function priceTierWords(tier: unknown): string | undefined {
  return typeof tier === 'string' && Object.hasOwn(MODEL_PRICE_TIER_WORDS, tier) ? MODEL_PRICE_TIER_WORDS[tier as ModelPriceTier] : undefined;
}

/** The effort levels a model offers to choose from (two or more), from its models.list entry. */
function effortLevelsOf(value: unknown): string[] {
  const levels = asRecord(asRecord(value).reasoningOptions).levels;
  const list = Array.isArray(levels) ? levels.filter((level): level is string => typeof level === 'string' && level.length > 0) : [];
  return list.length > 1 ? list : [];
}

/**
 * One provider as the menu shows it. Only models that can hold a conversation
 * are listed (`textWork` from the model catalog; `other` is left out, a model
 * the catalog does not describe is kept and marked), as the terminal's Main
 * chat tab does. A provider not connected opens Settings, Models and providers;
 * one signed in only by a subscription says "Sign in in Settings".
 */
export function pickerProviderOf(provider: ProviderOption, options: readonly ModelOption[]): PickerProvider {
  const status = deriveProviderStatus(provider.value);
  const modelList = asRecord(asRecord(provider.value).modelList);
  const models: PickerModel[] = [];
  for (const option of options) {
    const value = asRecord(option.value);
    const textWork = typeof value.textWork === 'string' ? value.textWork : 'unknown';
    if (textWork === 'other') continue;
    models.push({
      registryKey: option.registryKey,
      label: option.label,
      providerId: option.providerId,
      efforts: provider.id === 'decision-router' ? [] : effortLevelsOf(value),
      kindUnknown: textWork !== 'text',
      ...(priceTierWords(value.priceTier) ? { price: priceTierWords(value.priceTier) } : {}),
      ...(typeof value.recommended === 'string' && value.recommended ? { recommended: value.recommended } : {}),
    });
  }
  const subscriptionOnly = status.routes.length > 0 && status.routes.every((route) => route.route === 'subscription-oauth');
  const signInId = status.routes.find((route) => route.providerId)?.providerId ?? provider.id;
  return {
    id: provider.id,
    label: provider.label,
    connected: status.configured,
    models,
    ...(typeof modelList.listedAt === 'number' ? { listedAt: modelList.listedAt } : {}),
    ...(typeof modelList.error === 'string' ? { listError: modelList.error } : {}),
    // Connected in Settings, Models and providers: a subscription is signed in to there, from this page.
    connect: { kind: 'settings', subscription: subscriptionOnly && signInId.length > 0 },
  };
}

/** One provider's line in models.refresh's answer. */
interface RefreshReport {
  readonly label: string;
  readonly models: number;
  readonly source: string;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly error?: string | undefined;
  readonly notAsked?: boolean | undefined;
}

/** What a refresh did, in the words the terminal's /model refresh uses. */
export function modelRefreshSentence(reports: readonly RefreshReport[]): string {
  const lines = reports.filter((report) => report.notAsked !== true).map((report) => {
    // Why it was not read is said once, on the provider's row in the menu.
    if (report.error) return `${report.label}: not read now; its row says why`;
    const changes = [report.added.length > 0 ? `${report.added.length} new` : '', report.removed.length > 0 ? `${report.removed.length} retired` : ''].filter(Boolean);
    return `${report.label}: ${report.models} models found${changes.length > 0 ? ` (${changes.join(', ')})` : ''}`;
  });
  return lines.length > 0 ? `${lines.join('. ')}.` : 'No connected provider lists its own models; the model catalog was checked.';
}
