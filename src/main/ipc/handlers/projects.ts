// ============================================================================
// PROJECTS IPC HANDLERS
// ============================================================================

import { ipcMain, dialog, shell } from 'electron';
import fs from 'fs/promises';
import { Logger } from '../../services/logger.js';
import { withContext } from '../utils.js';
import {
  getRecentProjects,
  addRecentProject,
  removeRecentProject,
  clearRecentProjects,
  pinProject,
} from '../../services/recentProjects.js';
import {
  getPinnedFolders,
  addPinnedFolder,
  removePinnedFolder,
} from '../../services/pinnedFolders.js';
import {
  openInExplorerInputSchema,
  addRecentProjectInputSchema,
  removeRecentProjectInputSchema,
  pinProjectInputSchema,
  validateInput,
} from '../schemas/index.js';

const logger = new Logger('IPC:Projects');

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

export function registerProjectsHandlers(): void {
  // ============================================================================
  // FILE/FOLDER HANDLERS
  // ============================================================================

  ipcMain.handle('select-folder', withContext('select-folder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  }));

  ipcMain.handle('select-file', withContext('select-file', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
    });
    return result.canceled ? null : result.filePaths[0];
  }));

  ipcMain.handle('create-folder', withContext('create-folder', async () => {
    const result = await dialog.showSaveDialog({
      title: 'Create New Project Folder',
      buttonLabel: 'Create',
      properties: ['showOverwriteConfirmation'],
    });

    if (!result.canceled && result.filePath) {
      await fs.mkdir(result.filePath, { recursive: true });
      return result.filePath;
    }
    return null;
  }));

  ipcMain.handle('open-in-explorer', withContext('open-in-explorer', async (_, folderPath: unknown) => {
    // Validate input using Zod schema
    const validation = validateInput(openInExplorerInputSchema, folderPath);
    if (!validation.success) {
      logger.warn('open-in-explorer validation failed', { error: validation.error, input: folderPath });
      throw new IPCValidationError(`Invalid folder path: ${validation.error}`);
    }

    shell.showItemInFolder(validation.data);
    return true;
  }));

  // ============================================================================
  // RECENT PROJECTS HANDLERS
  // ============================================================================

  ipcMain.handle('get-recent-projects', withContext('get-recent-projects', async () => {
    return getRecentProjects();
  }));

  ipcMain.handle('add-recent-project', withContext('add-recent-project', async (_, data: unknown) => {
    // Validate input using Zod schema
    const validation = validateInput(addRecentProjectInputSchema, data);
    if (!validation.success) {
      logger.warn('add-recent-project validation failed', { error: validation.error });
      throw new IPCValidationError(`Invalid project data: ${validation.error}`);
    }

    addRecentProject(validation.data.path, validation.data.name);
    return true;
  }));

  ipcMain.handle('remove-recent-project', withContext('remove-recent-project', async (_, projectPath: unknown) => {
    // Validate input using Zod schema
    const validation = validateInput(removeRecentProjectInputSchema, projectPath);
    if (!validation.success) {
      logger.warn('remove-recent-project validation failed', { error: validation.error, input: projectPath });
      throw new IPCValidationError(`Invalid project path: ${validation.error}`);
    }

    removeRecentProject(validation.data);
    return true;
  }));

  ipcMain.handle('pin-project', withContext('pin-project', async (_, projectPath: unknown) => {
    // Validate input using Zod schema
    const validation = validateInput(pinProjectInputSchema, projectPath);
    if (!validation.success) {
      logger.warn('pin-project validation failed', { error: validation.error, input: projectPath });
      throw new IPCValidationError(`Invalid project path: ${validation.error}`);
    }

    return pinProject(validation.data);
  }));

  ipcMain.handle('clear-recent-projects', withContext('clear-recent-projects', async () => {
    clearRecentProjects();
    return true;
  }));

  // ============================================================================
  // PINNED FOLDERS HANDLERS
  // ============================================================================

  ipcMain.handle('get-pinned-folders', withContext('get-pinned-folders', async () => {
    return getPinnedFolders();
  }));

  ipcMain.handle('add-pinned-folder', withContext('add-pinned-folder', async (_, data: unknown) => {
    // Validate input - expect {path: string, name: string}
    if (!data || typeof data !== 'object' || !('path' in data) || !('name' in data)) {
      throw new IPCValidationError('Invalid pinned folder data: expected {path: string, name: string}');
    }
    const { path, name } = data as { path: string; name: string };
    if (typeof path !== 'string' || typeof name !== 'string') {
      throw new IPCValidationError('Invalid pinned folder data: path and name must be strings');
    }
    return addPinnedFolder(path, name);
  }));

  ipcMain.handle('remove-pinned-folder', withContext('remove-pinned-folder', async (_, folderPath: unknown) => {
    if (typeof folderPath !== 'string') {
      throw new IPCValidationError('Invalid folder path: expected string');
    }
    return removePinnedFolder(folderPath);
  }));

  logger.info('Projects handlers registered');
}
