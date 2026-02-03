// ============================================================================
// SESSION TYPES - Session and message related types
// ============================================================================

export interface Session {
  id: string;
  projectName: string | null;
  filePath: string | null;
  startTime: string | null;
  endTime: string | null;
  messageCount: number;
  tokenCount: number;
  cost: number;
  status: SessionStatus;
  tags: string | null;
  notes: string | null;
  favorite: boolean;
  archived: boolean;
  collectionId: number | null;
  summary: string | null;
  customTitle: string | null;
  rating: number | null;
  outcome: SessionOutcome | null;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  fileMtime: number | null;
  createdAt: string;
  updatedAt: string;
}

export type SessionStatus = 'active' | 'completed' | 'error' | 'unknown';
export type SessionOutcome = 'success' | 'partial' | 'failed' | 'abandoned';

export interface SessionMessage {
  id: number;
  sessionId: string;
  messageIndex: number;
  role: MessageRole;
  content: string;
  timestamp: string | null;
  tokenCount: number;
  toolName: string | null;
  toolInput: string | null;
  toolResult: string | null;
  createdAt: string;
}

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool' | 'tool_result' | 'thinking' | 'unknown';

// ============================================================================
// Terminal Types
// ============================================================================

export interface TerminalInfo {
  id: number;
  name: string;
  cwd: string;
  startTime: Date;
  resumeSessionId?: string;
  sessionType?: 'user' | 'subagent';
  isPreview?: boolean;
  previewSessionId?: string;
  isPlainTerminal?: boolean;
}

export interface TerminalStartOptions {
  cwd?: string;
  name?: string;
  resumeSessionId?: string;
  sessionType?: 'user' | 'subagent';
  isPlainTerminal?: boolean;
}

export interface TerminalStartResult {
  id?: number;
  name?: string;
  cwd?: string;
  resumeSessionId?: string;
  sessionType?: string;
  isPlainTerminal?: boolean;
  error?: string;
}

// ============================================================================
// Collection Types
// ============================================================================

export interface Collection {
  id: number;
  name: string;
  color: string;
  icon: string;
  parentId: number | null;
  sortOrder: number;
  createdAt: string;
}

export interface SmartCollection {
  id: number;
  name: string;
  color: string;
  icon: string;
  rules: SmartCollectionRule[];
  matchMode: 'all' | 'any';
  createdAt: string;
  updatedAt: string;
}

export interface SmartCollectionRule {
  type: 'TAG' | 'PROJECT' | 'DATE_RANGE' | 'RATING' | 'COST' | 'OUTCOME';
  value?: string | number;
  operator?: 'eq' | 'gte' | 'lte';
  startDate?: string;
  endDate?: string;
}

// ============================================================================
// Tag Types
// ============================================================================

export interface Tag {
  id: number;
  name: string;
  color: string;
  parentId: number | null;
  parentName?: string;
  createdAt: string;
}

// ============================================================================
// Bookmark Types
// ============================================================================

export interface Bookmark {
  id: number;
  sessionId: string;
  messageIndex: number;
  label: string;
  color: string;
  createdAt: string;
}

// ============================================================================
// Prompt Types
// ============================================================================

export interface Prompt {
  id: number;
  title: string;
  content: string;
  category: string;
  useCount: number;
  lastUsed: string | null;
  createdAt: string;
}

// ============================================================================
// Quick Note Types
// ============================================================================

export interface QuickNote {
  id: number;
  content: string;
  sessionId: string | null;
  status: 'active' | 'completed' | 'archived';
  priority: 'low' | 'normal' | 'high';
  projectName?: string;
  createdAt: string;
}

// ============================================================================
// Knowledge Base Types
// ============================================================================

export interface KnowledgeEntry {
  id: number;
  title: string;
  content: string;
  category: string | null;
  tags: string | null;
  sourceSessionId: string | null;
  viewCount: number;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// Session Link Types
// ============================================================================

export interface SessionLink {
  id: number;
  sourceSessionId: string;
  targetSessionId: string;
  linkType: 'related' | 'continuation' | 'parent' | 'child';
  notes: string | null;
  sourceProject?: string;
  targetProject?: string;
  createdAt: string;
}

// ============================================================================
// Activity Log Types
// ============================================================================

export interface ActivityLogEntry {
  id: number;
  type: string;
  sessionId: string | null;
  description: string;
  metadata: string | null;
  timestamp: string;
}

// ============================================================================
// Session Preview Types
// ============================================================================

export type SessionEntryType =
  | 'user'
  | 'assistant'
  | 'tool_use'
  | 'tool_result'
  | 'thinking'
  | 'system'
  | 'summary'
  | 'unknown';

export interface ParsedSessionEntry {
  id: number;
  type: SessionEntryType;
  content: string;
  timestamp?: string;
  toolName?: string;
  toolId?: string;
  toolInput?: Record<string, unknown>;
  isError?: boolean;
  costUSD?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export interface SessionEntryCounts {
  total: number;
  user: number;
  assistant: number;
  tool_use: number;
  tool_result: number;
  thinking: number;
  system: number;
  summary: number;
  unknown: number;
}

// ============================================================================
// Scan Status Types
// ============================================================================

export interface ScanStatus {
  status: 'scanning' | 'complete' | 'error';
  message?: string;
  progress?: {
    current: number;
    total: number;
  };
}

// ============================================================================
// Export Formats
// ============================================================================

export type ExportFormat = 'markdown' | 'json' | 'html';

export interface ExportOptions {
  sessionId: string;
  format: ExportFormat;
}

// ============================================================================
// Search Types
// ============================================================================

export interface SearchOptions {
  query?: string;
  favorite?: boolean;
  archived?: boolean;
  collectionId?: number;
  startDate?: string;
  endDate?: string;
  minCost?: number;
  maxCost?: number;
  project?: string;
  limit?: number;
}

export interface SavedSearch {
  id: number;
  name: string;
  query: string;
  filters: string;
  createdAt: string;
}
