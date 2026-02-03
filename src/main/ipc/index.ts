// ============================================================================
// IPC HANDLER REGISTRATION - ORCHESTRATOR
// ============================================================================
//
// This module orchestrates the registration of all IPC handlers.
// Individual handlers are split into domain-specific modules in ./handlers/
// ============================================================================

import { Logger } from '../services/logger.js';
import { initProjectRegistry } from '../services/projectRegistry/index.js';
import { initProjectCoordinator } from '../services/projectCoordinator/index.js';
import { registerApprovalAgentHandlers } from './approvalAgentHandlers.js';
import { registerProjectAnalyticsHandlers } from './projectAnalyticsHandlers.js';

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
  registerFeatureHandlers,
  registerPluginHandlers,
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

  // Feature installation
  registerFeatureHandlers();

  // Plugin management
  registerPluginHandlers();

  // ============================================================================
  // UI HANDLERS
  // ============================================================================

  // Clipboard and context menus
  registerClipboardHandlers();

  // ============================================================================
  // ADVANCED FEATURE HANDLERS
  // ============================================================================

  // Initialize project registry and coordinator services
  initProjectRegistry();
  initProjectCoordinator();

  // Register approval, agent, and project analytics handlers
  registerApprovalAgentHandlers();
  registerProjectAnalyticsHandlers();

  logger.info('All IPC handlers registered');
}

// Re-export utilities for use by handler modules
export { withContext } from './utils.js';
