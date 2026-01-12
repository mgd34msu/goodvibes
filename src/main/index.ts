// ============================================================================
// MAIN PROCESS ENTRY POINT
// ============================================================================

import { app, BrowserWindow } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';

import { createWindow, getMainWindow } from './window.js';
import { createMenu } from './menu.js';
import { initDatabase, closeDatabase, clearActivityLog, getSetting } from './database/index.js';
import { initSessionManager, getSessionManager } from './services/sessionManager.js';
import { initTerminalManager, closeAllTerminals, getTerminalCount } from './services/terminalManager.js';
import { registerAllIpcHandlers } from './ipc/index.js';
import { loadRecentProjects } from './services/recentProjects.js';
import { Logger } from './services/logger.js';
import { handleOAuthCallback, initializeGitHub } from './services/github.js';
import { initAgentRegistry, shutdownAgentRegistry, getAgentRegistry } from './services/agentRegistry.js';
import { getPTYStreamAnalyzer, shutdownPTYStreamAnalyzer } from './services/ptyStreamAnalyzer.js';
import { startHookServer, stopHookServer, getHookServer } from './services/hookServer.js';
import {
  installAllHookScripts,
  areHookScriptsInstalled,
  configureClaudeHooks,
  areClaudeHooksConfigured,
} from './services/hookScripts.js';
import { createHookEventsTables } from './database/hookEvents.js';
import { backupSessions } from './services/sessionBackup.js';
import {
  SESSION_SCAN_INIT_DELAY_MS,
  GRACEFUL_SHUTDOWN_TIMEOUT_MS,
} from '../shared/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = new Logger('Main');

// Track shutdown state
let isShuttingDown = false;

// ============================================================================
// CUSTOM PROTOCOL REGISTRATION
// ============================================================================

const PROTOCOL_NAME = 'goodvibes';

/**
 * Register the custom protocol for OAuth callbacks.
 * Must be called before the app 'ready' event.
 */
function registerProtocol(): void {
  if (process.defaultApp) {
    // In development, we need to pass the path to the script
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL_NAME, process.execPath, [path.resolve(process.argv[1])]);
    }
  } else {
    // In production, just register the protocol
    app.setAsDefaultProtocolClient(PROTOCOL_NAME);
  }
  logger.info(`Registered custom protocol: ${PROTOCOL_NAME}://`);
}

/**
 * Handle a protocol URL (goodvibes://...)
 * Routes to appropriate handler based on the path
 */
function handleProtocolUrl(url: string): void {
  logger.info('Handling protocol URL', { url });

  try {
    const parsedUrl = new URL(url);

    // Handle OAuth callback
    if (parsedUrl.host === 'oauth' || parsedUrl.pathname.startsWith('/oauth')) {
      const code = parsedUrl.searchParams.get('code');
      const state = parsedUrl.searchParams.get('state');
      const error = parsedUrl.searchParams.get('error');
      const errorDescription = parsedUrl.searchParams.get('error_description');

      if (error) {
        logger.error('OAuth callback received error', { error, errorDescription });
        handleOAuthCallback(null, state, error, errorDescription);
      } else if (code) {
        logger.info('OAuth callback received code');
        handleOAuthCallback(code, state, null, null);
      } else {
        logger.error('OAuth callback missing code and error');
      }
    } else {
      logger.warn('Unknown protocol path', { path: parsedUrl.pathname });
    }
  } catch (error) {
    logger.error('Failed to parse protocol URL', error);
  }
}

// ============================================================================
// SINGLE INSTANCE LOCK (Windows/Linux)
// ============================================================================

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Another instance is already running, quit this one
  logger.info('Another instance is already running, quitting');
  app.quit();
} else {
  // Register protocol before ready (required on some platforms)
  registerProtocol();

  // Handle second instance (Windows/Linux protocol handling)
  app.on('second-instance', (_event, commandLine, _workingDirectory) => {
    logger.info('Second instance detected', { commandLine });

    // Find the protocol URL in the command line arguments
    const protocolUrl = commandLine.find(arg => arg.startsWith(`${PROTOCOL_NAME}://`));

    if (protocolUrl) {
      handleProtocolUrl(protocolUrl);
    }

    // Focus the main window
    const mainWindow = getMainWindow();
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });

  // macOS: Handle protocol URL via open-url event
  app.on('open-url', (event, url) => {
    event.preventDefault();
    logger.info('Received open-url event', { url });

    if (url.startsWith(`${PROTOCOL_NAME}://`)) {
      handleProtocolUrl(url);
    }
  });
}

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception', err);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection', reason);
});

// ============================================================================
// APP LIFECYCLE
// ============================================================================

async function initializeApp(): Promise<void> {
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
    const streamAnalyzer = getPTYStreamAnalyzer();
    const agentRegistry = getAgentRegistry();

    if (agentRegistry) {
      // Track detected agents: key is a composite of terminalId + timestamp to ensure uniqueness
      // Also track agent instance counts per name for display purposes
      const agentInstanceCounts = new Map<string, number>(); // agentName -> count
      const terminalToAgents = new Map<number, Set<string>>(); // terminalId -> Set of agentIds
      // Deduplication: Track recently seen agent names per terminal to avoid duplicate registrations
      // Key: "terminalId:agentName", Value: timestamp of last detection
      const recentAgentDetections = new Map<string, number>();
      const DEDUP_WINDOW_MS = 5000; // 5 seconds - same agent name detected within this window is ignored

      logger.info('[DEBUG] Setting up agent:spawn event listener on streamAnalyzer');

      streamAnalyzer.on('agent:spawn', (data: { terminalId: number; agentName: string; description?: string; timestamp: number; isRealAgent?: boolean }) => {
        logger.info('[DEBUG] agent:spawn event received!', data);

        const { terminalId, agentName, description, timestamp, isRealAgent } = data;

        // Deduplication: Check if we recently detected this same agent in this terminal
        const dedupKey = `${terminalId}:${agentName}`;
        const lastDetection = recentAgentDetections.get(dedupKey);
        if (lastDetection && (timestamp - lastDetection) < DEDUP_WINDOW_MS) {
          logger.debug(`[DEBUG] Skipping duplicate agent detection: ${agentName} (detected ${timestamp - lastDetection}ms ago)`);
          return;
        }
        recentAgentDetections.set(dedupKey, timestamp);

        // Clean up old dedup entries periodically (every 10 detections)
        if (recentAgentDetections.size > 50) {
          const cutoff = Date.now() - DEDUP_WINDOW_MS * 2;
          for (const [key, ts] of recentAgentDetections) {
            if (ts < cutoff) {
              recentAgentDetections.delete(key);
            }
          }
        }

        // Track instance count for this agent name
        const currentCount = agentInstanceCounts.get(agentName) || 0;
        const instanceNumber = currentCount + 1;
        agentInstanceCounts.set(agentName, instanceNumber);

        // Create a display name with instance number if > 1
        const displayName = instanceNumber > 1 ? `${agentName} #${instanceNumber}` : agentName;

        // Register the new agent (always create a new one for each spawn)
        logger.info(`[DEBUG] Spawning new agent in registry: ${displayName} (isRealAgent: ${isRealAgent})`);
        const agent = agentRegistry.spawn({
          name: displayName,
          cwd: process.cwd(), // Will be updated if we can determine it
          initialPrompt: description,
        });

        logger.info(`[DEBUG] Agent spawned successfully: ${displayName} (${agent.id})`);

        // Track which agents belong to which terminal for cleanup
        if (!terminalToAgents.has(terminalId)) {
          terminalToAgents.set(terminalId, new Set());
        }
        const terminalAgents = terminalToAgents.get(terminalId);
        if (terminalAgents) {
          terminalAgents.add(agent.id);
        }

        // Mark as active since we detected it running
        agentRegistry.markActive(agent.id);

        logger.info(`Registered detected agent: ${displayName} (${agent.id})`);

        // Notify renderer of new agent
        const mainWindow = getMainWindow();
        logger.info(`[DEBUG] Notifying renderer, mainWindow exists: ${!!mainWindow}, isDestroyed: ${mainWindow?.isDestroyed()}`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('agent:detected', {
            id: agent.id,
            name: displayName,
            description,
            terminalId,
          });
          logger.info('[DEBUG] Sent agent:detected event to renderer');
        }
      });

      // Clean up agents when terminal exits
      const { ipcMain } = await import('electron');
      ipcMain.on('terminal-exited', (_, { terminalId }: { terminalId: number }) => {
        const agentIds = terminalToAgents.get(terminalId);
        if (agentIds) {
          for (const agentId of agentIds) {
            const agent = agentRegistry.getAgent(agentId);
            // Only terminate if still in an active state
            if (agent && ['spawning', 'ready', 'active', 'idle'].includes(agent.status)) {
              logger.info(`Terminating agent ${agentId} due to terminal ${terminalId} exit`);
              agentRegistry.terminateAgent(agentId);
            }
          }
          terminalToAgents.delete(terminalId);
        }
      });

      streamAnalyzer.on('agent:complete', (data: { terminalId: number; agentId: string; agentName?: string; reason?: string; timestamp: number }) => {
        const { agentId, agentName, reason, terminalId } = data;

        // Find agent by partial ID match or name match within the terminal's agents
        const agentIds = terminalToAgents.get(terminalId);
        if (agentIds) {
          for (const id of agentIds) {
            const agent = agentRegistry.getAgent(id);
            if (!agent) continue;

            // Match by ID or by name (considering numbered instances like "orchestrator #2")
            const matchesById = agentId && (id.startsWith(agentId) || agentId.startsWith(id.substring(0, 7)));
            const matchesByName = agentName && (
              agent.name === agentName ||
              agent.name.startsWith(agentName + ' #') ||
              agent.name.toLowerCase() === agentName.toLowerCase()
            );

            if (matchesById || matchesByName) {
              // Only complete if still in an active state
              if (['spawning', 'ready', 'active', 'idle'].includes(agent.status)) {
                agentRegistry.complete(id, reason === 'error' ? 1 : 0);
                logger.info(`Agent completed: ${agent.name} (${id})`, { reason });
              }
              break;
            }
          }
        }
      });

      streamAnalyzer.on('agent:activity', (data: { terminalId: number; agentName: string; activity: string; timestamp: number }) => {
        const { terminalId } = data;
        // Update activity for all agents in this terminal
        const agentIds = terminalToAgents.get(terminalId);
        if (agentIds) {
          for (const agentId of agentIds) {
            const agent = agentRegistry.getAgent(agentId);
            if (agent && ['spawning', 'ready', 'active', 'idle'].includes(agent.status)) {
              agentRegistry.recordActivity(agentId);
            }
          }
        }
      });
    }

    logger.info('PTY stream analyzer wired to agent registry');

    // ============================================================================
    // HOOK SERVER EVENT LOGGING (for debugging)
    // ============================================================================
    // NOTE: The actual agent creation and hierarchy tracking is now done in
    // hookServer.ts handlers. These listeners are for debug logging only.
    // ============================================================================
    const hookServer = getHookServer();

    hookServer.on('session:start', (data: { sessionId?: string; projectPath?: string }) => {
      logger.debug('[MAIN] session:start event received', data);
    });

    hookServer.on('agent:start', (data: { agentName?: string; sessionId?: string }) => {
      logger.debug('[MAIN] agent:start event received', data);
    });

    hookServer.on('agent:stop', (data: { agentName?: string; sessionId?: string }) => {
      logger.debug('[MAIN] agent:stop event received', data);
    });

    hookServer.on('session:end', (data: { sessionId?: string }) => {
      logger.debug('[MAIN] session:end event received', data);
    });

    logger.info('Hook server events connected for debug logging');

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

    // Initialize GitHub service (restore auth state from storage)
    await initializeGitHub();
    logger.info('GitHub service initialized');

    // Start hook server and install hook scripts
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

      // Configure Claude's settings.json to use our hooks
      // This is critical - without this, Claude doesn't know to run our hook scripts
      const hooksConfigured = await areClaudeHooksConfigured();
      if (!hooksConfigured) {
        const configured = await configureClaudeHooks();
        if (configured) {
          logger.info('Claude hooks configured in settings.json');
        } else {
          logger.warn('Failed to configure Claude hooks in settings.json');
        }
      } else {
        logger.info('Claude hooks already configured in settings.json');
      }
    } catch (error) {
      // Log but don't fail - hook server is optional for core functionality
      logger.warn('Failed to start hook server', error);
    }

    // Register IPC handlers
    registerAllIpcHandlers();
    logger.info('IPC handlers registered');

    // Create main window
    createWindow();
    createMenu();
    logger.info('Window created');

    // Start session scanning after window is ready
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

    logger.info('GoodVibes initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize app', error);
    throw error;
  }
}

// App ready
app.whenReady().then(initializeApp);

// macOS: Re-create window when dock icon is clicked
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

/**
 * Performs graceful shutdown with timeout
 * Waits for active operations to complete before closing resources
 */
async function performGracefulShutdown(): Promise<void> {
  if (isShuttingDown) {
    logger.info('Shutdown already in progress');
    return;
  }

  isShuttingDown = true;
  logger.info('Starting graceful shutdown...');

  const startTime = Date.now();

  // Wait for terminals to close, but with a timeout
  const waitForTerminals = async (): Promise<void> => {
    const checkInterval = 100; // Check every 100ms
    while (getTerminalCount() > 0 && Date.now() - startTime < GRACEFUL_SHUTDOWN_TIMEOUT_MS) {
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    if (getTerminalCount() > 0) {
      logger.warn(`Shutdown timeout reached with ${getTerminalCount()} terminals still active, forcing close`);
    }
  };

  try {
    // Stop session manager watching
    const sessionManager = getSessionManager();
    if (sessionManager) {
      sessionManager.stopWatching();
      logger.info('Session manager stopped');
    }

    // Shutdown PTY stream analyzer
    shutdownPTYStreamAnalyzer();
    logger.info('PTY stream analyzer shut down');

    // Stop hook server
    await stopHookServer();
    logger.info('Hook server stopped');

    // Shutdown agent registry
    shutdownAgentRegistry();
    logger.info('Agent registry shut down');

    // Close all terminals
    closeAllTerminals();
    await waitForTerminals();
    logger.info('All terminals closed');

    // Close database
    closeDatabase();
    logger.info('Database closed');

    const elapsed = Date.now() - startTime;
    logger.info(`Graceful shutdown completed in ${elapsed}ms`);
  } catch (error) {
    logger.error('Error during graceful shutdown', error);
    // Force close resources on error
    closeAllTerminals();
    closeDatabase();
  }
}

// Cleanup on window close
app.on('window-all-closed', async () => {
  logger.info('All windows closed, cleaning up...');

  await performGracefulShutdown();

  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Before quit
app.on('before-quit', async (event) => {
  if (!isShuttingDown) {
    event.preventDefault();
    await performGracefulShutdown();
    app.quit();
  }
});

export { getMainWindow };
