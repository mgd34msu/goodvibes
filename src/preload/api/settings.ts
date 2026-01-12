// ============================================================================
// SETTINGS PRELOAD API
// ============================================================================

import { ipcRenderer } from 'electron';

export const settingsApi = {
  getSetting: (key: string) =>
    ipcRenderer.invoke('get-setting', key),
  setSetting: (key: string, value: unknown) =>
    ipcRenderer.invoke('set-setting', { key, value }),
  getAllSettings: () =>
    ipcRenderer.invoke('get-all-settings'),
  getAppVersion: () =>
    ipcRenderer.invoke('get-app-version'),
  getAppPath: (name: string) =>
    ipcRenderer.invoke('get-app-path', name),
};
