// ============================================================================
// IPC HANDLER REGISTRATION - ORCHESTRATOR
// ============================================================================
//
// This module orchestrates the registration of all IPC handlers.
// Individual handlers are split into domain-specific modules in ./handlers/
// ============================================================================

import { Logger } from '../services/logger.js';
import { initProjectRegistry } from '../services/projectRegistry.js';
import { initProjectCoordinator } from '../services/projectCoordinator.js';
import { registerPhase5to8Handlers } from './phase5to8Handlers.js';
import { registerPhase9to12Handlers } from './phase9to12Handlers.js';

// Domain handlers
import {
  registerTerminalHandlers,
  registerSessionHandlers,
  registerGitHandlers,
  registerDatabaseHandlers,
  registerSettingsHandlers,
  registerProjectsHandlers,
  registerGitHubHandlers,
  registerHooksHandlers,
  registerPrimitivesHandlers,
  registerAgencyHandlers,
  registerExportHandlers,
  registerClipboardHandlers,
} from './handlers/index.js';

const logger = new Logger('IPC');

/**
 * Registers all IPC handlers for the application.
 * This is the main entry point for IPC handler setup.
 */
export function registerAllIpcHandlers(): void {
  // ============================================================================
  // CORE HANDLERS
  // ============================================================================

  // Terminal management
  registerTerminalHandlers();

  // Session management
  registerSessionHandlers();

  // Settings and app info
  registerSettingsHandlers();

  // ============================================================================
  // DATA HANDLERS
  // ============================================================================

  // Database operations (collections, tags, prompts, notes, notifications, knowledge, search, analytics)
  registerDatabaseHandlers();

  // Export functionality
  registerExportHandlers();

  // ============================================================================
  // GIT & GITHUB HANDLERS
  // ============================================================================

  // Git operations
  registerGitHandlers();

  // GitHub integration
  registerGitHubHandlers();

  // ============================================================================
  // PROJECT HANDLERS
  // ============================================================================

  // File/folder and recent projects
  registerProjectsHandlers();

  // ============================================================================
  // AGENT & AUTOMATION HANDLERS
  // ============================================================================

  // Hooks configuration and events
  registerHooksHandlers();

  // Primitives (MCP servers, agent templates, project configs, agent registry, skills, tasks)
  registerPrimitivesHandlers();

  // Agency index (agent & skill browser)
  registerAgencyHandlers();

  // ============================================================================
  // UI HANDLERS
  // ============================================================================

  // Clipboard and context menus
  registerClipboardHandlers();

  // ============================================================================
  // PHASE HANDLERS
  // ============================================================================

  // Initialize project registry and coordinator services
  initProjectRegistry();
  initProjectCoordinator();

  // Register phase-specific handlers
  registerPhase5to8Handlers();
  registerPhase9to12Handlers();

  logger.info('All IPC handlers registered');
}

// Re-export utilities for use by handler modules
export { withContext } from './utils.js';
