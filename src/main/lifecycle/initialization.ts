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
import tagSuggestionService from '../services/tagSuggestionService.js';

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

    // Import sessions BEFORE creating the window
    // This ensures sessions are available when any view tries to load them
    const sessionManager = getSessionManager();
    if (sessionManager) {
      logger.info('Importing sessions from ~/.claude/projects...');
      await sessionManager.init();
      logger.info('Session import complete');
    }

    // Create main window
    createWindow();
    createMenu();
    logger.info('Window created');

    // Start tag suggestion service after window is ready
    setupTagSuggestionService();

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
 * Set up tag suggestion service to start after window is ready
 * Sessions are already imported at this point, so we can safely queue them
 */
function setupTagSuggestionService(): void {
  const mainWindow = getMainWindow();
  if (mainWindow) {
    // Set up auto-apply listener for completed scans
    tagSuggestionService.on('complete', async (sessionId, suggestions) => {
      try {
        const autoAccept = getSetting<boolean>('aiSuggestionsAutoAccept') ?? false;
        const autoAcceptThreshold = getSetting<number>('aiSuggestionsAutoAcceptThreshold') ?? 0.9;
        
        if (autoAccept && suggestions.length > 0) {
          const tagSuggestions = await import('../database/tagSuggestions.js');
          let acceptedCount = 0;
          
          // Auto-accept suggestions that meet the confidence threshold
          for (const suggestion of suggestions) {
            if (suggestion.confidence >= autoAcceptThreshold) {
              try {
                tagSuggestions.acceptSuggestion(suggestion.id);
                acceptedCount++;
                logger.debug(`Auto-accepted suggestion ${suggestion.id}: ${suggestion.tagName} (confidence: ${suggestion.confidence})`);
              } catch (error) {
                logger.warn(`Failed to auto-accept suggestion ${suggestion.id}`, { error });
              }
            }
          }
          
          if (acceptedCount > 0) {
            logger.info(`Auto-applied ${acceptedCount}/${suggestions.length} tags for session ${sessionId}`);
            
            // Notify renderer to refresh tags display
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('tags-updated', { sessionId });
            }
          }
        }
      } catch (error) {
        logger.error('Failed to auto-apply tags', error, { sessionId });
      }
    });
    
    mainWindow.webContents.on('did-finish-load', async () => {
      // Small delay to ensure renderer JS is initialized
      setTimeout(async () => {
        // Auto-start tag suggestion service if enabled
        const enableAiSuggestions = getSetting<boolean>('enableAiSuggestions') ?? true;
        if (enableAiSuggestions) {
          logger.info('Starting tag suggestion service (auto-scan enabled)');
          tagSuggestionService.start();
          
          // Queue 10 most recent unscanned sessions
          // Sessions are already imported at this point, so FK constraints will be satisfied
          const pendingSessions = await import('../database/tagSuggestions.js').then(m => m.getPendingSessions(10));
          for (const sessionId of pendingSessions) {
            tagSuggestionService.queueSession(sessionId, 'medium');
          }
          
          if (pendingSessions.length > 0) {
            logger.info(`Queued ${pendingSessions.length} recent sessions for tag scanning`);
          }
        }
      }, SESSION_SCAN_INIT_DELAY_MS);
    });
  }
}
