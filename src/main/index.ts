// ============================================================================
// MAIN PROCESS ENTRY POINT
// ============================================================================
//
// This is the entry point for the Electron main process.
// The heavy lifting is delegated to the lifecycle module.
// ============================================================================

import { app } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { Logger } from './services/logger.js';
import {
  initializeApp,
  setupSingleInstance,
  setupActivationHandlers,
  setupShutdownHandlers,
} from './lifecycle/index.js';

const __filename = fileURLToPath(import.meta.url);
const _dirname = path.dirname(__filename); // Kept for potential future use, prefixed with _ to avoid unused warning

const logger = new Logger('Main');

// ============================================================================
// ERROR HANDLERS
// ============================================================================

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception', err);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection', reason);
});

// ============================================================================
// SINGLE INSTANCE LOCK
// ============================================================================
// Request single instance lock - if another instance is running, this will
// quit and pass the protocol URL to the existing instance.

const hasLock = setupSingleInstance();

if (hasLock) {
  // ============================================================================
  // APP LIFECYCLE SETUP
  // ============================================================================

  // Set up activation handlers (macOS dock click, etc.)
  setupActivationHandlers();

  // Set up shutdown handlers (window-all-closed, before-quit)
  setupShutdownHandlers();

  // App ready - initialize everything
  app.whenReady().then(initializeApp);
}

// ============================================================================
// EXPORTS
// ============================================================================

// Re-export getMainWindow for backward compatibility with imports
export { getMainWindow } from './window.js';
