// ============================================================================
// SESSION PREVIEW VIEW TYPES
// ============================================================================

import type { SessionEntryType, ParsedSessionEntry, SessionEntryCounts } from '../../../../shared/types';

export interface SessionPreviewViewProps {
  sessionId: string;
  sessionName: string;
}

export interface RawEntry {
  type?: string;
  message?: {
    role?: string;
    content?: string | Array<{
      type: string;
      text?: string;
      thinking?: string;
      id?: string;
      name?: string;
      input?: unknown;
      tool_use_id?: string;
      content?: string;
    }>;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  costUSD?: number;
  tool_use_id?: string;
  content?: string | unknown;
  is_error?: boolean;
  summary?: string;
  timestamp?: string;
  // Special entry types to filter out
  operation?: string; // queue-operation
  snapshot?: unknown; // file-history-snapshot
  messageId?: string; // file-history-snapshot
}

export interface TypeConfig {
  label: string;
  borderColor: string;
  bgColor: string;
  iconColor: string;
  badgeBg: string;
  badgeText: string;
}

// Re-export types from shared
export type { SessionEntryType, ParsedSessionEntry, SessionEntryCounts };
