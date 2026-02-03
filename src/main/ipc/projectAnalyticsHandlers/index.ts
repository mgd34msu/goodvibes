// ============================================================================
// PROJECT ANALYTICS IPC HANDLERS - Project Registry, Coordination, Templates, Recommendations
// ============================================================================
//
// This module registers IPC handlers for:
// - Project Registry (registration, settings, analytics)
// - Project Coordination (cross-project agents, shared skills)
// - Project Templates (create, apply, manage)
// - Global Analytics (cross-project metrics)
// - Test Monitor (test result parsing, statistics)
// - Agent Recommendations
//
// ============================================================================

import { Logger } from '../../services/logger.js';
import { startTestMonitor, stopTestMonitor } from '../../services/testMonitor.js';
import {
  registerProjectHandlers,
  registerTemplateHandlers,
  registerCoordinationHandlers,
} from './projectRegistry.js';
import {
  registerAnalyticsHandlers,
  registerTestMonitorHandlers,
} from './analytics.js';
import { registerRecommendationHandlers } from './recommendations.js';

const logger = new Logger('ProjectAnalyticsIPC');

// ============================================================================
// REGISTRATION
// ============================================================================

export function registerProjectAnalyticsHandlers(): void {
  // Project Registry Handlers
  registerProjectHandlers();

  // Template Handlers
  registerTemplateHandlers();

  // Coordination Handlers
  registerCoordinationHandlers();

  // Analytics Handlers
  registerAnalyticsHandlers();

  // Test Monitor Handlers
  registerTestMonitorHandlers();

  // Recommendation Handlers
  registerRecommendationHandlers();

  logger.info('Project Analytics IPC handlers registered');
}

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize Project Analytics services
 * Call this during app startup after hook server is ready
 */
export function initializeProjectAnalyticsServices(): void {
  startTestMonitor();
  logger.info('Project Analytics monitoring services initialized');
}

/**
 * Cleanup Project Analytics services
 * Call this during app shutdown
 */
export function cleanupProjectAnalyticsServices(): void {
  stopTestMonitor();
  logger.info('Project Analytics monitoring services cleaned up');
}
