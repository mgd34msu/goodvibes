// ============================================================================
// INITIALIZATION MODULE - App Startup Logic
// ============================================================================
//
// Orchestrates the initialization sequence for all app services and components.
// ============================================================================

import { app } from 'electron';
import { Logger } from '../services/logger.js';
import { initDatabase, clearActivityLog, getSetting } from '../database/index.js';
import { initSessionManager, getSessionManager } from '../services/sessionManager.js';
import { initTerminalManager } from '../services/terminalManager.js';
import { registerAllIpcHandlers } from '../ipc/index.js';
import { loadRecentProjects } from '../services/recentProjects.js';
import { loadPinnedFolders } from '../services/pinnedFolders.js';
import { initializeGitHub } from '../services/github.js';
import { initAgentRegistry } from '../services/agentRegistry.js';
import { startHookServer } from '../services/hookServer.js';
import { installAllHookScripts, areHookScriptsInstalled } from '../services/hookScripts.js';
import { createHookEventsTables } from '../database/hookEvents.js';
import { backupSessions } from '../services/sessionBackup.js';
import { createWindow, getMainWindow } from '../window.js';
import { createMenu } from '../menu.js';
import { wireAgentBridge, wireHookServerEvents } from './agentBridge.js';
import { SESSION_SCAN_INIT_DELAY_MS } from '../../shared/constants.js';

const logger = new Logger('Initialization');

/**
 * Initializes all application services and components.
 * Called when the app is ready.
 */
export async function initializeApp(): Promise<void> {
  logger.info('Initializing GoodVibes...');

  try {
    // Initialize database
    await initDatabase(app.getPath('userData'));
    logger.info('Database initialized');

    // Backup Claude sessions (if enabled in settings)
    const sessionBackupEnabled = getSetting<boolean>('sessionBackupEnabled') ?? true;
    if (sessionBackupEnabled) {
      const backupResult = await backupSessions();
      if (backupResult.backed > 0) {
        logger.info(`Session backup complete: ${backupResult.backed} new sessions backed up (${backupResult.total} total)`);
      } else {
        logger.info(`Session backup complete: all ${backupResult.total} sessions already backed up`);
      }
    } else {
      logger.info('Session backup disabled in settings');
    }

    // Create hook events tables
    createHookEventsTables();
    logger.info('Hook events tables created');

    // Clear old activity log entries (one-time cleanup for entries with incorrect session ID format)
    clearActivityLog();
    logger.info('Activity log cleared');

    // Initialize terminal manager
    initTerminalManager();
    logger.info('Terminal manager initialized');

    // Initialize agent registry
    initAgentRegistry();
    logger.info('Agent registry initialized');

    // Wire up PTY stream analyzer to agent registry
    wireAgentBridge();

    // Wire up hook server events for debug logging
    wireHookServerEvents();

    // Initialize session manager with status callback
    initSessionManager((status, message, progress) => {
      const mainWindow = getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('scan-status', { status, message, progress });
      }
    });
    logger.info('Session manager initialized');

    // Load recent projects
    loadRecentProjects();
    logger.info('Recent projects loaded');

    // Load pinned folders
    loadPinnedFolders();
    logger.info('Pinned folders loaded');

    // Initialize GitHub service (restore auth state from storage)
    await initializeGitHub();
    logger.info('GitHub service initialized');

    // Start hook server and install hook scripts
    await initializeHookSystem();

    // Register IPC handlers
    registerAllIpcHandlers();
    logger.info('IPC handlers registered');

    // Create main window
    createWindow();
    createMenu();
    logger.info('Window created');

    // Start session scanning after window is ready
    setupSessionScanning();

    logger.info('GoodVibes initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize app', error);
    throw error;
  }
}

/**
 * Initialize the hook server and install hook scripts
 */
async function initializeHookSystem(): Promise<void> {
  try {
    await startHookServer();
    logger.info('Hook server started');

    // Install hook scripts if not already installed
    const scriptsInstalled = await areHookScriptsInstalled();
    if (!scriptsInstalled) {
      await installAllHookScripts();
      logger.info('Hook scripts installed');
    } else {
      logger.info('Hook scripts already installed');
    }

    // DISABLED: Plugin system now handles hooks via plugin.json -> hooks.json
    // The old approach of writing directly to settings.json conflicts with plugin-based hooks
    logger.info('Hooks now managed by plugin system (plugin.json -> hooks.json)');
  } catch (error) {
    // Log but don't fail - hook server is optional for core functionality
    logger.warn('Failed to start hook server', error);
  }
}

/**
 * Set up session scanning to start after window is ready
 */
function setupSessionScanning(): void {
  const mainWindow = getMainWindow();
  if (mainWindow) {
    mainWindow.webContents.on('did-finish-load', async () => {
      // Small delay to ensure renderer JS is initialized
      setTimeout(async () => {
        const sessionManager = getSessionManager();
        if (sessionManager) {
          await sessionManager.init();
        }
      }, SESSION_SCAN_INIT_DELAY_MS);
    });
  }
}
