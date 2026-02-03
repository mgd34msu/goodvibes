// ============================================================================
// PROTOCOL MODULE - Custom URL Scheme Handling
// ============================================================================
//
// Handles registration and routing of the custom protocol (goodvibes://)
// for OAuth callbacks and other deep linking functionality.
// ============================================================================

import { app, BrowserWindow } from 'electron';
import path from 'path';
import { Logger } from '../services/logger.js';
import { handleOAuthCallback } from '../services/github.js';
import { getMainWindow } from '../window.js';

const logger = new Logger('Protocol');

export const PROTOCOL_NAME = 'goodvibes';

/**
 * Register the custom protocol for OAuth callbacks.
 * Must be called before the app 'ready' event.
 */
export function registerProtocol(): void {
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
export async function handleProtocolUrl(url: string): Promise<void> {
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
        await handleOAuthCallback(null, state, error, errorDescription);
      } else if (code) {
        logger.info('OAuth callback received code');
        await handleOAuthCallback(code, state, null, null);
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

/**
 * Set up single instance lock and protocol handlers.
 * Returns false if another instance is already running.
 */
export function setupSingleInstance(): boolean {
  const gotTheLock = app.requestSingleInstanceLock();

  if (!gotTheLock) {
    logger.info('Another instance is already running, quitting');
    app.quit();
    return false;
  }

  // Register protocol before ready (required on some platforms)
  registerProtocol();

  // Handle second instance (Windows/Linux protocol handling)
  app.on('second-instance', (_event, commandLine, _workingDirectory) => {
    logger.info('Second instance detected', { commandLine });

    // Find the protocol URL in the command line arguments
    const protocolUrl = commandLine.find(arg => arg.startsWith(`${PROTOCOL_NAME}://`));

    if (protocolUrl) {
      handleProtocolUrl(protocolUrl).catch((error) => {
        logger.error('Failed to handle protocol URL from second instance', error);
      });
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
      handleProtocolUrl(url).catch((error) => {
        logger.error('Failed to handle protocol URL from open-url event', error);
      });
    }
  });

  return true;
}

/**
 * Set up handlers for app activation events (macOS dock click, etc.)
 */
export function setupActivationHandlers(): void {
  // macOS: Re-create window when dock icon is clicked
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      // Import dynamically to avoid circular dependency
      import('../window.js').then(({ createWindow }) => {
        createWindow();
      });
    }
  });
}
