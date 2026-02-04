// ============================================================================
// SHUTDOWN MODULE - Graceful Shutdown Handling
// ============================================================================
//
// Manages graceful shutdown of all services and resources.
// ============================================================================

import { app } from 'electron';
import { Logger } from '../services/logger.js';
import { closeDatabase } from '../database/index.js';
import { getSessionManager } from '../services/sessionManager.js';
import { closeAllTerminals, getTerminalCount } from '../services/terminalManager.js';
import { shutdownAgentRegistry } from '../services/agentRegistry.js';
import { shutdownPTYStreamAnalyzer } from '../services/ptyStreamAnalyzer.js';
import { stopHookServer } from '../services/hookServer.js';
import { shutdownGitWatcher } from '../services/gitWatcher.js';
import { shutdownDeviceFlow } from '../services/github/index.js';
import { removeAllListeners } from './listenerRegistry.js';
import { GRACEFUL_SHUTDOWN_TIMEOUT_MS } from '../../shared/constants.js';

const logger = new Logger('Shutdown');

// Track shutdown state
let isShuttingDown = false;

/**
 * Returns whether shutdown is currently in progress
 */
export function getIsShuttingDown(): boolean {
  return isShuttingDown;
}

/**
 * Performs graceful shutdown with timeout.
 * Waits for active operations to complete before closing resources.
 */
export async function performGracefulShutdown(): Promise<void> {
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

    // Remove listeners BEFORE shutting down services to prevent race conditions
    removeAllListeners();

    // Shutdown PTY stream analyzer
    shutdownPTYStreamAnalyzer();
    logger.info('PTY stream analyzer shut down');

    // Stop hook server
    await stopHookServer();
    logger.info('Hook server stopped');

    // Shutdown agent registry
    shutdownAgentRegistry();
    logger.info('Agent registry shut down');

    // Shutdown git watcher
    shutdownGitWatcher();
    logger.info('Git watcher shut down');

    // Shutdown GitHub device flow
    shutdownDeviceFlow();
    logger.info('GitHub device flow shut down');

    // Close all terminals
    closeAllTerminals();
    await waitForTerminals();
    logger.info('All terminals closed');

    // Close database
    closeDatabase();
    logger.info('Database closed');

    const elapsed = Date.now() - startTime;
    logger.info(`Graceful shutdown completed in ${elapsed}ms`);

    // Shutdown logger last (after all logging is complete)
    Logger.shutdown();
  } catch (error) {
    logger.error('Error during graceful shutdown', error);
    // Force close resources on error
    shutdownGitWatcher();
    shutdownDeviceFlow();
    closeAllTerminals();
    closeDatabase();
    Logger.shutdown();
  }
}

/**
 * Set up shutdown handlers for window-all-closed and before-quit events
 */
export function setupShutdownHandlers(): void {
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
}
