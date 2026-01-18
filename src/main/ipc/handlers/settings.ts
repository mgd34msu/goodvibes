// ============================================================================
// SETTINGS IPC HANDLERS
// ============================================================================

import { ipcMain, app } from 'electron';
import { Logger } from '../../services/logger.js';
import { withContext } from '../utils.js';
import * as db from '../../database/index.js';
import {
  getSettingInputSchema,
  setSettingInputSchema,
  getAppPathInputSchema,
  validateInput,
  isThemeSettingKey,
  validateThemeSettingValue,
  type AppPathName,
} from '../schemas/index.js';

const logger = new Logger('IPC:Settings');

/**
 * Custom error class for IPC validation failures
 */
class IPCValidationError extends Error {
  constructor(
    message: string,
    public readonly code: string = 'VALIDATION_ERROR'
  ) {
    super(message);
    this.name = 'IPCValidationError';
  }
}

export function registerSettingsHandlers(): void {
  ipcMain.handle('get-setting', withContext('get-setting', async (_, key: unknown) => {
    // Validate input using Zod schema
    const validation = validateInput(getSettingInputSchema, key);
    if (!validation.success) {
      logger.warn('get-setting validation failed', { error: validation.error, input: key });
      throw new IPCValidationError(`Invalid setting key: ${validation.error}`);
    }

    return db.getSetting(validation.data);
  }));

  ipcMain.handle('set-setting', withContext('set-setting', async (_, data: unknown) => {
    // Validate input using Zod schema
    const validation = validateInput(setSettingInputSchema, data);
    if (!validation.success) {
      logger.warn('set-setting validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid setting data: ${validation.error}`);
    }

    const { key, value } = validation.data;

    // Apply additional validation for theme-related settings
    if (isThemeSettingKey(key)) {
      const themeValidation = validateThemeSettingValue(key, value);
      if (!themeValidation.success) {
        logger.warn('set-setting theme validation failed', { key, error: themeValidation.error });
        throw new IPCValidationError(`Invalid theme value for "${key}": ${themeValidation.error}`);
      }
    }

    db.setSetting(key, value);
    return true;
  }));

  ipcMain.handle('get-all-settings', withContext('get-all-settings', async () => {
    // No input to validate for this handler
    return db.getAllSettings();
  }));

  // ============================================================================
  // APP INFO HANDLERS
  // ============================================================================

  ipcMain.handle('get-app-version', withContext('get-app-version', async () => {
    return app.getVersion();
  }));

  ipcMain.handle('get-app-path', withContext('get-app-path', async (_, name: unknown) => {
    // Validate input using Zod schema
    const validation = validateInput(getAppPathInputSchema, name);
    if (!validation.success) {
      logger.warn('get-app-path validation failed', { error: validation.error, input: name });
      throw new IPCValidationError(`Invalid app path name: ${validation.error}`);
    }

    return app.getPath(validation.data as AppPathName);
  }));

  logger.info('Settings handlers registered');
}
