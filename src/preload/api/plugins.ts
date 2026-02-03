// ============================================================================
// PLUGINS PRELOAD API
// ============================================================================
//
// API for managing Claude Code plugins (installation, uninstallation, enable/disable)
// ============================================================================

import { ipcRenderer } from 'electron';

export const pluginsApi = {
  /**
   * Get all installed plugins
   */
  getInstalledPlugins: () => ipcRenderer.invoke('plugins:getInstalledPlugins'),

  /**
   * Install a plugin from a repository
   */
  installPlugin: (data: {
    repository: string;
    scope: 'user' | 'project';
    projectPath?: string;
  }) => ipcRenderer.invoke('plugins:installPlugin', data),

  /**
   * Uninstall a plugin
   */
  uninstallPlugin: (data: {
    pluginId: string;
    scope: 'user' | 'project';
    projectPath?: string;
  }) => ipcRenderer.invoke('plugins:uninstallPlugin', data),

  /**
   * Enable or disable a plugin
   */
  enablePlugin: (data: {
    pluginId: string;
    enabled: boolean;
  }) => ipcRenderer.invoke('plugins:enablePlugin', data),
};
