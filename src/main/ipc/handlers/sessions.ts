// ============================================================================
// SESSION IPC HANDLERS
// ============================================================================

import { ipcMain } from 'electron';
import { Logger } from '../../services/logger.js';
import { withContext } from '../utils.js';
import { getSessionManager } from '../../services/sessionManager.js';
import * as db from '../../database/index.js';

const logger = new Logger('IPC:Sessions');

export function registerSessionHandlers(): void {
  ipcMain.handle('get-sessions', withContext('get-sessions', async () => {
    const sessionManager = getSessionManager();
    return sessionManager?.getAllSessions() ?? [];
  }));

  ipcMain.handle('get-session', withContext('get-session', async (_, id: string) => {
    const sessionManager = getSessionManager();
    return sessionManager?.getSession(id) ?? null;
  }));

  ipcMain.handle('get-session-messages', withContext('get-session-messages', async (_, id: string) => {
    const sessionManager = getSessionManager();
    return await sessionManager?.getSessionMessages(id) ?? [];
  }));

  ipcMain.handle('get-active-sessions', withContext('get-active-sessions', async () => {
    return db.getActiveSessions();
  }));

  ipcMain.handle('get-favorite-sessions', withContext('get-favorite-sessions', async () => {
    return db.getFavoriteSessions();
  }));

  ipcMain.handle('get-archived-sessions', withContext('get-archived-sessions', async () => {
    return db.getArchivedSessions();
  }));

  ipcMain.handle('toggle-favorite', withContext('toggle-favorite', async (_, id: string) => {
    db.toggleFavorite(id);
    return true;
  }));

  ipcMain.handle('toggle-archive', withContext('toggle-archive', async (_, id: string) => {
    db.toggleArchive(id);
    return true;
  }));

  ipcMain.handle('delete-session', withContext('delete-session', async (_, id: string) => {
    db.deleteSession(id);
    return true;
  }));

  ipcMain.handle('get-live-sessions', withContext('get-live-sessions', async () => {
    const sessionManager = getSessionManager();
    return sessionManager?.getLiveSessions() ?? [];
  }));

  ipcMain.handle('get-session-raw-entries', withContext('get-session-raw-entries', async (_, id: string) => {
    const sessionManager = getSessionManager();
    return await sessionManager?.getSessionRawEntries(id) ?? [];
  }));

  ipcMain.handle('refresh-session', withContext('refresh-session', async (_, id: string) => {
    const sessionManager = getSessionManager();
    return await sessionManager?.refreshSessionTokens(id) ?? null;
  }));

  ipcMain.handle('is-session-live', withContext('is-session-live', async (_, id: string) => {
    const sessionManager = getSessionManager();
    return sessionManager?.isSessionLive(id) ?? false;
  }));

  ipcMain.handle('recalculate-session-costs', withContext('recalculate-session-costs', async () => {
    const sessionManager = getSessionManager();
    if (!sessionManager) {
      return { success: false, error: 'Session manager not initialized', count: 0 };
    }
    try {
      const count = await sessionManager.recalculateAllCosts();
      return { success: true, count };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error', count: 0 };
    }
  }));

  logger.info('Session handlers registered');
}
