// ============================================================================
// TERMINAL IPC HANDLERS
// ============================================================================

import { ipcMain } from 'electron';
import { Logger } from '../../services/logger.js';
import { withContext } from '../utils.js';
import {
  startTerminal,
  startPlainTerminal,
  writeToTerminal,
  resizeTerminal,
  killTerminal,
  getAllTerminals,
} from '../../services/terminalManager.js';

const logger = new Logger('IPC:Terminal');

export function registerTerminalHandlers(): void {
  ipcMain.handle('start-claude', withContext('start-claude', async (_, options: { cwd?: string; name?: string; resumeSessionId?: string; sessionType?: 'user' | 'subagent' }) => {
    logger.info('IPC: start-claude received', {
      cwd: options.cwd,
      name: options.name,
      resumeSessionId: options.resumeSessionId,
      sessionType: options.sessionType
    });
    return startTerminal(options);
  }));

  ipcMain.handle('start-plain-terminal', withContext('start-plain-terminal', async (_, options: { cwd?: string; name?: string }) => {
    logger.info('IPC: start-plain-terminal received', {
      cwd: options.cwd,
      name: options.name
    });
    return startPlainTerminal(options);
  }));

  ipcMain.handle('terminal-input', withContext('terminal-input', async (_, { id, data }) => {
    writeToTerminal(id, data);
    return true;
  }));

  ipcMain.handle('terminal-resize', withContext('terminal-resize', async (_, { id, cols, rows }) => {
    resizeTerminal(id, cols, rows);
    return true;
  }));

  ipcMain.handle('kill-terminal', withContext('kill-terminal', async (_, id) => {
    return killTerminal(id);
  }));

  ipcMain.handle('get-terminals', withContext('get-terminals', async () => {
    return getAllTerminals();
  }));

  logger.info('Terminal handlers registered');
}
