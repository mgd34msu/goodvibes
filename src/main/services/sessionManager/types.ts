// ============================================================================
// SESSION MANAGER TYPES
// ============================================================================

import type { Session, SessionMessage } from '../../../shared/types/index.js';

// Re-export for convenience
export type { Session, SessionMessage };

export type StatusCallback = (status: string, message?: string, progress?: { current: number; total: number }) => void;

export interface SessionFile {
  path: string;
  mtime: number;
}

export interface TokenStats {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

export interface ParsedSessionData {
  messages: Partial<SessionMessage>[];
  tokenStats: TokenStats;
  costUSD: number;
  model: string | null;
  toolUsage: Map<string, number>;
}

