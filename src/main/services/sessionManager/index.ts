// ============================================================================
// SESSION MANAGER - Main exports
// ============================================================================

import { SessionManagerInstance } from './service.js';
import type { StatusCallback } from './types.js';

// Re-export types
export type { StatusCallback, Session, SessionMessage } from './types.js';

// Re-export the service class
export { SessionManagerInstance };

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let sessionManager: SessionManagerInstance | null = null;

export function initSessionManager(statusCallback: StatusCallback): void {
  sessionManager = new SessionManagerInstance(statusCallback);
}

export function getSessionManager(): SessionManagerInstance | null {
  return sessionManager;
}
