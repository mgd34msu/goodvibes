// ============================================================================
// SESSION MANAGER SERVICE - Re-export from modular structure
// ============================================================================
//
// This file maintains backward compatibility by re-exporting all functions
// from the modular sessionManager/ directory.
//
// ============================================================================

export {
  initSessionManager,
  getSessionManager,
  SessionManagerInstance,
  type StatusCallback,
  type Session,
  type SessionMessage,
} from './sessionManager/index.js';
