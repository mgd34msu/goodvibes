/**
 * provider-optimizer-wiring.ts, the one owner of the mapping from the two
 * provider optimizer settings to the live optimizer. `provider.optimizerMode`
 * decides whether it is on and how it routes; `provider.optimizerPinnedModel`
 * names the target in pinned mode. The provider stack applies them at start
 * and again whenever either key changes, from any settings path.
 */
import type { ConfigManager } from '../config/manager.js';
import type { OptimizerMode, ProviderOptimizer } from '../providers/optimizer.js';

/** What the two settings ask of the optimizer. */
export interface ProviderOptimizerSettings {
  readonly enabled: boolean;
  readonly mode: OptimizerMode;
  readonly pin: { readonly providerId: string; readonly modelId: string } | null;
}

/**
 * `off` is an inactive optimizer in manual mode; `manual`, `auto` and
 * `pinned` are active. Pinned with no valid `provider:model` target stays
 * manual, since there is nothing to pin.
 */
export function readProviderOptimizerSettings(configManager: Pick<ConfigManager, 'get'>): ProviderOptimizerSettings {
  const mode = configManager.get('provider.optimizerMode');
  if (mode === 'off') return { enabled: false, mode: 'manual', pin: null };
  if (mode !== 'pinned') return { enabled: true, mode, pin: null };
  const pinned = configManager.get('provider.optimizerPinnedModel').trim();
  const sep = pinned.indexOf(':');
  if (sep <= 0 || sep >= pinned.length - 1) return { enabled: true, mode: 'manual', pin: null };
  return { enabled: true, mode: 'pinned', pin: { providerId: pinned.slice(0, sep), modelId: pinned.slice(sep + 1) } };
}

export function applyProviderOptimizerSettings(
  providerOptimizer: Pick<ProviderOptimizer, 'setEnabled' | 'setMode' | 'pin'>,
  settings: ProviderOptimizerSettings,
): void {
  providerOptimizer.setEnabled(settings.enabled);
  if (settings.pin) providerOptimizer.pin(settings.pin.providerId, settings.pin.modelId);
  else providerOptimizer.setMode(settings.mode === 'pinned' ? 'manual' : settings.mode);
}

/** Applies the settings now and on every change to either key; returns the unsubscribe. */
export function bindProviderOptimizerConfig(
  configManager: Pick<ConfigManager, 'get' | 'subscribe'>,
  providerOptimizer: Pick<ProviderOptimizer, 'setEnabled' | 'setMode' | 'pin'>,
): () => void {
  const apply = (): void => applyProviderOptimizerSettings(providerOptimizer, readProviderOptimizerSettings(configManager));
  apply();
  const stopMode = configManager.subscribe('provider.optimizerMode', apply);
  const stopPin = configManager.subscribe('provider.optimizerPinnedModel', apply);
  return () => {
    stopMode();
    stopPin();
  };
}
