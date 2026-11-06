/** Platform-owned boot readiness and recovery for saved custom-provider selections. */
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { ensureConfiguredModelIsRoutable, type ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';

/**
 * Boot-time custom-provider readiness. Custom providers register
 * asynchronously (services.ts fires initCustomProviders() without awaiting),
 * while the boot path resolves the current model synchronously, without
 * waiting here, a saved provider.model that points at a custom provider
 * throws "not in registry" before the first frame renders. The routability
 * guard must re-run after ready(): its services-composition pass bails when
 * the provider itself isn't registered yet, which is exactly the
 * custom-provider case. As a last resort (the configured provider's file was
 * deleted entirely), boot on a real selectable model with a warning instead
 * of dying before the UI exists.
 */
export async function ensureBootModelResolvable(providerRegistry: ProviderRegistry, configManager: ConfigManager): Promise<void> {
  await providerRegistry.ready();
  ensureConfiguredModelIsRoutable(providerRegistry, configManager);
  try {
    providerRegistry.getCurrentModel();
  } catch (err) {
    const configured = String(configManager.get('provider.model') ?? '');
    const replacement = providerRegistry.getSelectableModels()[0]?.registryKey;
    if (!replacement) throw err;
    providerRegistry.setCurrentModel(replacement);
    configManager.set('provider.model', replacement);
    logger.warn(
      `[bootstrap] Configured model '${configured}' is not resolvable (its provider is not registered); switched to '${replacement}'.`,
    );
  }
}
