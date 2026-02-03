// ============================================================================
// PROJECT ANALYTICS IPC HANDLERS - Re-export from modular structure
// ============================================================================
//
// This file maintains backward compatibility by re-exporting all functions
// from the modular projectAnalyticsHandlers/ directory.
//
// ============================================================================

export {
  registerProjectAnalyticsHandlers,
  initializeProjectAnalyticsServices,
  cleanupProjectAnalyticsServices,
} from './projectAnalyticsHandlers/index.js';
