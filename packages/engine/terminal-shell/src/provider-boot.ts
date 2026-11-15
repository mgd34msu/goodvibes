/** Platform-owned boot readiness and recovery for saved custom-provider selections. */
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { ensureConfiguredModelIsRoutable, type ProviderRegistry } from '@goodvibes-jev/engine/platform/platform/providers';
import { logger } from '@goodvibes-jev/engine/platform/platform/utils';

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
 * of dying before the UI exists. The substitution lasts for this session only:
 * the saved `provider.model` stays on disk so the chosen model returns once its
 * provider registers again, and the caller gets the substitution to tell the
 * user which model is actually running.
 */
export interface BootModelSubstitution {
  readonly configured: string;
  readonly replacement: string;
}
export async function ensureBootModelResolvable(providerRegistry: ProviderRegistry, configManager: ConfigManager): Promise<BootModelSubstitution | undefined> {
  await providerRegistry.ready();
  ensureConfiguredModelIsRoutable(providerRegistry, configManager);
  try {
    providerRegistry.getCurrentModel();
  } catch (err) {
    const configured = String(configManager.get('provider.model') ?? '');
    const replacement = providerRegistry.getSelectableModels()[0]?.registryKey;
    if (!replacement) throw err;
    providerRegistry.setCurrentModel(replacement);
    logger.warn(
      `[bootstrap] Configured model '${configured}' is not resolvable (its provider is not registered); using '${replacement}' for this session.`,
    );
    return { configured, replacement };
  }
  return undefined;
}
