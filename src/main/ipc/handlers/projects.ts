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

const logger = new Logger('IPC:Projects');

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

  ipcMain.handle('open-in-explorer', withContext('open-in-explorer', async (_, folderPath: string) => {
    shell.showItemInFolder(folderPath);
    return true;
  }));

  // ============================================================================
  // RECENT PROJECTS HANDLERS
  // ============================================================================

  ipcMain.handle('get-recent-projects', withContext('get-recent-projects', async () => {
    return getRecentProjects();
  }));

  ipcMain.handle('add-recent-project', withContext('add-recent-project', async (_, { path: projectPath, name }: { path: string; name?: string }) => {
    addRecentProject(projectPath, name);
    return true;
  }));

  ipcMain.handle('remove-recent-project', withContext('remove-recent-project', async (_, projectPath: string) => {
    removeRecentProject(projectPath);
    return true;
  }));

  ipcMain.handle('pin-project', withContext('pin-project', async (_, projectPath: string) => {
    return pinProject(projectPath);
  }));

  ipcMain.handle('clear-recent-projects', withContext('clear-recent-projects', async () => {
    clearRecentProjects();
    return true;
  }));

  logger.info('Projects handlers registered');
}
