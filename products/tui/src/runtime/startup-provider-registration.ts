import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';
import { startBackgroundProviderDiscovery, type BackgroundProviderDiscoveryOptions } from '@goodvibes/engine/platform/platform/runtime/bootstrap';

/** The options start-up registered with, so first run can look for model servers on this computer. */
let startupOptions: BackgroundProviderDiscoveryOptions | null = null;

/**
 * Report the servers an earlier scan saved, without probing this machine or
 * its network. Discovery is the person's own act (Find model servers on this
 * computer in Models and providers, the network scan in Devices and network,
 * both run by the daemon); the shared
 * background discovery helper also scans every local subnet and belongs behind
 * the calling surface's consent. The provider stack registers the saved servers
 * once the custom providers have loaded (every composition does, so one-shot
 * commands and `goodvibes run` know them too); this waits for that, puts the
 * saved model back in force and says what was restored.
 */
export function registerStartupProviders(options: BackgroundProviderDiscoveryOptions): void {
  startupOptions = options;
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

/**
 * Look for model servers on this computer now (never the network): first
 * run's offer of "a model on this computer", started when first run opens
 * and when the person asks it to look again. The servers found are
 * registered and remembered as a scan's would; first run shows them, so
 * nothing is printed. False before start-up registered its options.
 */
export function scanThisComputerNow(): boolean {
  if (!startupOptions) return false;
  startBackgroundProviderDiscovery({ ...startupOptions, registerNetworkServers: false, report: {} });
  return true;
}
