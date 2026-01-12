// ============================================================================
// SETTINGS IPC HANDLERS
// ============================================================================

import { ipcMain, app } from 'electron';
import { Logger } from '../../services/logger.js';
import { withContext } from '../utils.js';
import * as db from '../../database/index.js';

const logger = new Logger('IPC:Settings');

export function registerSettingsHandlers(): void {
  ipcMain.handle('get-setting', withContext('get-setting', async (_, key: string) => {
    return db.getSetting(key);
  }));

  ipcMain.handle('set-setting', withContext('set-setting', async (_, { key, value }: { key: string; value: unknown }) => {
    db.setSetting(key, value);
    return true;
  }));

  ipcMain.handle('get-all-settings', withContext('get-all-settings', async () => {
    return db.getAllSettings();
  }));

  // ============================================================================
  // APP INFO HANDLERS
  // ============================================================================

  ipcMain.handle('get-app-version', withContext('get-app-version', async () => {
    return app.getVersion();
  }));

  ipcMain.handle('get-app-path', withContext('get-app-path', async (_, name: string) => {
    // Validate the path name against known valid values
    const validPaths = [
      'home', 'appData', 'userData', 'sessionData', 'temp', 'exe',
      'module', 'desktop', 'documents', 'downloads', 'music',
      'pictures', 'videos', 'recent', 'logs', 'crashDumps'
    ] as const;

    type AppPathName = typeof validPaths[number];

    if (!validPaths.includes(name as AppPathName)) {
      throw new Error(`Invalid app path name: ${name}`);
    }

    return app.getPath(name as AppPathName);
  }));

  logger.info('Settings handlers registered');
}
