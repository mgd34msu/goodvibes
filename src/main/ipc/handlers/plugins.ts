// ============================================================================
// PLUGINS IPC HANDLERS
// ============================================================================
//
// Handles plugin management operations (install, uninstall, enable/disable).
// Delegates to the plugin manager service for actual plugin operations.
//
// All handlers use Zod validation for input sanitization.
// ============================================================================

import { ipcMain } from 'electron';
import { ZodError } from 'zod';
import { Logger } from '../../services/logger.js';
import { withContext } from '../utils.js';
import {
  installPluginSchema,
  uninstallPluginSchema,
  enablePluginSchema,
  type InstallPluginInput,
  type UninstallPluginInput,
  type EnablePluginInput,
} from '../schemas/plugins.js';
import {
  getInstalledPlugins,
  installPlugin,
  uninstallPlugin,
  enablePlugin,
} from '../../services/pluginManager/index.js';

const logger = new Logger('IPC:Plugins');

// ============================================================================
// VALIDATION ERROR RESPONSE
// ============================================================================

interface ValidationErrorResponse {
  success: false;
  error: string;
  code: 'VALIDATION_ERROR';
  details?: Array<{ path: string; message: string }>;
}

/**
 * Formats a ZodError into a user-friendly error response
 */
function formatValidationError(error: ZodError): ValidationErrorResponse {
  const details = error.errors.map((e) => ({
    path: e.path.join('.'),
    message: e.message,
  }));

  return {
    success: false,
    error: `Validation failed: ${details.map((d) => d.message).join(', ')}`,
    code: 'VALIDATION_ERROR',
    details,
  };
}

// ============================================================================
// HANDLERS
// ============================================================================

export function registerPluginHandlers(): void {
  /**
   * Get all installed plugins
   */
  ipcMain.handle('plugins:getInstalledPlugins', withContext('plugins:getInstalledPlugins', async () => {
    try {
      logger.debug('Fetching installed plugins');
      const plugins = await getInstalledPlugins();
      logger.info('Fetched installed plugins', { count: plugins.length });
      return { success: true, plugins };
    } catch (error) {
      logger.error('Failed to get installed plugins', { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }));

  /**
   * Install a plugin from a repository URL
   */
  ipcMain.handle('plugins:installPlugin', withContext('plugins:installPlugin', async (_, data: unknown) => {
    const result = installPluginSchema.safeParse(data);
    if (!result.success) {
      logger.warn('plugins:installPlugin validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }

    try {
      const { repository, scope, projectPath } = result.data;
      logger.info('Installing plugin', { repository, scope, projectPath });

      const plugin = await installPlugin(repository, scope, projectPath);

      logger.info('Plugin installed successfully', {
        pluginId: plugin.id,
        name: plugin.name,
        scope,
      });

      return { success: true, plugin };
    } catch (error) {
      logger.error('Failed to install plugin', { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }));

  /**
   * Uninstall a plugin
   */
  ipcMain.handle('plugins:uninstallPlugin', withContext('plugins:uninstallPlugin', async (_, data: unknown) => {
    const result = uninstallPluginSchema.safeParse(data);
    if (!result.success) {
      logger.warn('plugins:uninstallPlugin validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }

    try {
      const { pluginId, scope, projectPath } = result.data;
      logger.info('Uninstalling plugin', { pluginId, scope, projectPath });

      await uninstallPlugin(pluginId, scope, projectPath);

      logger.info('Plugin uninstalled successfully', { pluginId, scope });
      return { success: true };
    } catch (error) {
      logger.error('Failed to uninstall plugin', { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }));

  /**
   * Enable or disable a plugin
   */
  ipcMain.handle('plugins:enablePlugin', withContext('plugins:enablePlugin', async (_, data: unknown) => {
    const result = enablePluginSchema.safeParse(data);
    if (!result.success) {
      logger.warn('plugins:enablePlugin validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }

    try {
      const { pluginId, enabled } = result.data;
      logger.info('Toggling plugin enabled state', { pluginId, enabled });

      await enablePlugin(pluginId, enabled);

      logger.info('Plugin enabled state updated', { pluginId, enabled });
      return { success: true };
    } catch (error) {
      logger.error('Failed to toggle plugin enabled state', { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }));

  logger.info('Plugin handlers registered');
}
