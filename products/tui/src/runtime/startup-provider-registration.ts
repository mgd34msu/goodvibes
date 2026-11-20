import { logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import type { BackgroundProviderDiscoveryOptions } from '@goodvibes-jev/engine/platform/platform/runtime/bootstrap';

/**
 * Report the servers an earlier /scan saved, without probing this machine or
 * its network. Discovery is an explicit /scan action in the TUI; the shared
 * background discovery helper also scans every local subnet and belongs behind
 * the calling surface's consent. The provider stack registers the saved servers
 * once the custom providers have loaded (every composition does, so one-shot
 * commands and `goodvibes run` know them too); this waits for that, puts the
 * saved model back in force and says what was restored.
 */
export function registerStartupProviders(options: BackgroundProviderDiscoveryOptions): void {
  const { configManager, providerRegistry, runtime, requestRender, restoreRuntimeModel, systemMessageRouter } = options;
  void providerRegistry.ready().then(() => {
    const restored = providerRegistry.listDiscoveredServers();
    if (restored.length === 0) return;
    restoreRuntimeModel(providerRegistry, configManager.get('provider.model') as string, runtime);
    for (const server of restored) {
      systemMessageRouter.low(
        `[Local] ${server.name} at ${server.host}:${server.port} (${server.models.length} model${server.models.length !== 1 ? 's' : ''}), from last session`,
      );
    }
    requestRender();
  }).catch((error: unknown) => {
    logger.warn('[bootstrap] Saved provider restore failed', { error: summarizeError(error) });
  });
}
