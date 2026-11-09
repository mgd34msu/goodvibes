import type { PluginManager } from '@goodvibes-jev/engine/platform/platform/plugins';
import { logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
export function createPluginStartupTask(
  manager: Pick<PluginManager, 'init' | 'getPluginConfig' | 'isEnabled'>,
  context: () => Omit<Parameters<PluginManager['init']>[0], 'getPluginConfig' | 'isEnabled'>,
  render: () => void,
  report: (message: string) => void,
) {
  return {
    label: 'plugins',
    async run() {
      await manager.init({
        ...context(),
        getPluginConfig: (name) => manager.getPluginConfig(name),
        isEnabled: (name) => manager.isEnabled(name),
      });
      render();
    },
    onError(error: unknown) {
      const message = summarizeError(error);
      logger.error('Deferred plugin startup failed', { error: message });
      report(`[Startup] Plugin initialization failed: ${message}`);
      render();
    },
  };
}
type PluginStartupContext = Omit<Parameters<PluginManager['init']>[0], 'getPluginConfig' | 'isEnabled'>;
export function buildPluginStartupContext(
  base: Pick<PluginStartupContext, 'runtimeBus' | 'commandRegistry' | 'providerRegistry' | 'toolRegistry'>,
  services: {
    readonly gatewayMethods: PluginStartupContext['gatewayMethods'];
    readonly channelPlugins: PluginStartupContext['channelRegistry'];
    readonly deliveryManager: {
      getDeliveryRouter(): PluginStartupContext['channelDeliveryRouter'];
    };
    readonly memoryEmbeddingRegistry: PluginStartupContext['memoryEmbeddingRegistry'];
    readonly voiceProviders: PluginStartupContext['voiceProviderRegistry'];
    readonly mediaProviders: PluginStartupContext['mediaProviderRegistry'];
    readonly webSearchProviders: PluginStartupContext['webSearchProviderRegistry'];
  },
): PluginStartupContext {
  return {
    ...base,
    gatewayMethods: services.gatewayMethods,
    channelRegistry: services.channelPlugins,
    channelDeliveryRouter: services.deliveryManager.getDeliveryRouter(),
    memoryEmbeddingRegistry: services.memoryEmbeddingRegistry,
    voiceProviderRegistry: services.voiceProviders,
    mediaProviderRegistry: services.mediaProviders,
    webSearchProviderRegistry: services.webSearchProviders,
  };
}
