// ============================================================================
// SESSION SUMMARIES DATABASE - Main exports
// ============================================================================
//
// This module provides database operations for storing session summaries,
// enabling cross-session search, session comparison, and resumption.
//
// ============================================================================

// Re-export types
export type {
  SessionSummary,
  SessionCheckpoint,
  SessionComparison,
  SessionSummaryRow,
  SessionCheckpointRow,
} from './types.js';

// Re-export schema creation
export { createSessionSummariesTables } from './schema.js';

// Re-export CRUD operations
export {
  upsertSessionSummary,
  getSessionSummary,
  getSessionSummaryBySessionId,
  getRecentSessionsForProject,
  getRecentSessions,
  updateSessionMetrics,
  endSession,
  updateContextSnapshot,
  updateLastPrompt,
  addFileChange,
  createCheckpoint,
  getCheckpoint,
  getSessionCheckpoints,
  deleteCheckpoint,
  mapRowToSessionSummary,
  mapRowToCheckpoint,
} from './queries.js';

// Re-export FTS and comparison operations
export {
  searchSessions,
  findSessionsByFile,
  compareSessions,
  cleanupOldSessions,
} from './fts.js';
