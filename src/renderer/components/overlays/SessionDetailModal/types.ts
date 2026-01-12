// ============================================================================
// SESSION DETAIL MODAL TYPES
// ============================================================================

import type { Session } from '../../../../shared/types';

export interface SessionDetailModalProps {
  session: Session;
  onClose: () => void;
}

export interface RawEntry {
  type?: string;
  message?: {
    role?: string;
    content?: string | Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown }>;
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
}

export interface ParsedEntry {
  id: number;
  type: string;
  content: string;
  timestamp?: string;
  toolName?: string;
  toolId?: string;
  toolInput?: unknown;
  isError?: boolean;
  tokens?: number;
}

export interface EntryCounts {
  total: number;
  user: number;
  assistant: number;
  tool_use: number;
  tool_result: number;
  thinking: number;
  system: number;
  summary: number;
}

export interface EntryConfig {
  label: string;
  borderColor: string;
  bgColor: string;
  iconColor: string;
  badgeBg: string;
  badgeText: string;
}
