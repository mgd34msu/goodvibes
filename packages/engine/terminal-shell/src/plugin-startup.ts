import type { PluginManager } from '@goodvibes-jev/engine/sdk/platform/plugins';
import { logger, summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
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
