// ============================================================================
// SHARED TYPES - Used by both main and renderer processes
// ============================================================================

// ============================================================================
// Session Types
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
// Analytics Types
// ============================================================================

export interface Analytics {
  totalSessions: number;
  totalTokens: number;
  totalCost: number;
  dailyCost: number;
  avgTokensPerSession: number;
  costByProject: Record<string, number>;
  sessionsOverTime: SessionTimeData[];
  messageCount: number;
  totalMessages: number;
  messagesToday?: number;
  totalSubagents: number;
  favoriteCount: number;
}

export interface SessionTimeData {
  date: string;
  count: number;
  tokens: number;
  cost: number;
}

export interface ToolUsageStat {
  toolName: string;
  totalCount: number;
  lastUsed: string;
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
// Settings Types
// ============================================================================

export interface AppSettings {
  theme: 'dark' | 'light';
  fontSize: number;
  claudePath: string | null;
  defaultCwd: string | null;
  projectsRoot: string | null;
  startupBehavior: 'empty' | 'last-project' | 'folder-picker';
  restoreTabs: boolean;
  autoSessionWatch: boolean;
  hideAgentSessions: boolean;
  skipPermissions: boolean;
  gitPanelPosition: 'left' | 'right';
  gitAutoRefresh: boolean;
  gitShowOnStart: boolean;
  dailyBudget: number | null;
  monthlyBudget: number | null;
  budgetNotifications: boolean;
  // Preview settings - Visibility (show/hide block types entirely)
  showThinkingBlocks: boolean;
  showToolUseBlocks: boolean;
  showToolResultBlocks: boolean;
  showSystemBlocks: boolean;
  showSummaryBlocks: boolean;
  // Preview settings - Default expand state (if visible)
  expandUserByDefault: boolean;
  expandAssistantByDefault: boolean;
  expandThinkingByDefault: boolean;
  expandToolUseByDefault: boolean;
  expandToolResultByDefault: boolean;
  expandSystemByDefault: boolean;
  expandSummaryByDefault: boolean;
  // GitHub Integration settings
  githubEnabled: boolean;
  githubShowInGitPanel: boolean;
  githubAutoLoadPRs: boolean;
  githubAutoLoadCI: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  fontSize: 14,
  claudePath: null,
  defaultCwd: null,
  projectsRoot: null,
  startupBehavior: 'empty',
  restoreTabs: false,
  autoSessionWatch: true,
  hideAgentSessions: true,
  skipPermissions: false,
  gitPanelPosition: 'right',
  gitAutoRefresh: true,
  gitShowOnStart: false,
  dailyBudget: null,
  monthlyBudget: null,
  budgetNotifications: false,
  // Preview settings - Visibility (show/hide block types entirely)
  showThinkingBlocks: true,
  showToolUseBlocks: true,
  showToolResultBlocks: true,
  showSystemBlocks: true,
  showSummaryBlocks: true,
  // Preview settings - Default expand state (if visible)
  expandUserByDefault: true,
  expandAssistantByDefault: true,
  expandThinkingByDefault: false,
  expandToolUseByDefault: false,
  expandToolResultByDefault: false,
  expandSystemByDefault: false,
  expandSummaryByDefault: false,
  // GitHub Integration settings
  githubEnabled: true,
  githubShowInGitPanel: true,
  githubAutoLoadPRs: true,
  githubAutoLoadCI: true,
};

// Settings version - increment this when adding new settings that need migration
// Version 2: Added preview visibility settings (showThinkingBlocks, etc.) with true defaults
// Version 3: Added GitHub integration settings
// Version 4: Removed githubClientId (now bundled with app, not user-configurable)
// Version 5: Reset GitHub settings to new defaults (enabled by default)
//   Note: Versions 5-7 were originally separate attempts to fix the same bug where
//   GitHub settings persisted as false after changing defaults to true. The root cause
//   was the migration saving the version number before saving the migrated values,
//   which could fail silently. This has been fixed in settingsStore.ts by:
//   1. Saving migrated values first, then version
//   2. Always saving version even if some values fail (to prevent infinite retry loops)
//   Versions 6-7 have been consolidated into v5 since they all reset the same settings.
export const SETTINGS_VERSION = 5;

// Settings that were added/changed in each version and need to be reset to defaults
export const SETTINGS_MIGRATIONS: Record<number, (keyof AppSettings)[]> = {
  2: [
    'showThinkingBlocks',
    'showToolUseBlocks',
    'showToolResultBlocks',
    'showSystemBlocks',
    'showSummaryBlocks',
    'expandUserByDefault',
    'expandAssistantByDefault',
    'expandThinkingByDefault',
    'expandToolUseByDefault',
    'expandToolResultByDefault',
    'expandSystemByDefault',
    'expandSummaryByDefault',
  ],
  3: [
    'githubEnabled',
    'githubShowInGitPanel',
    'githubAutoLoadPRs',
    'githubAutoLoadCI',
  ],
  // Version 4: No new settings, just removed githubClientId
  // Migration handled by removing the key from stored settings
  4: [],
  // Version 5: Reset GitHub settings to new defaults (enabled by default)
  // This migration ensures users who had old false values get the new true defaults.
  5: [
    'githubEnabled',
    'githubShowInGitPanel',
  ],
};

// Settings that were removed and should be cleaned up during migration
export const REMOVED_SETTINGS: Record<number, string[]> = {
  4: ['githubClientId'], // Moved to bundled OAuth credentials
};

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
// Notification Types
// ============================================================================

export interface AppNotification {
  id: number;
  type: NotificationType;
  title: string;
  message: string | null;
  priority: 'low' | 'normal' | 'high';
  read: boolean;
  dismissed: boolean;
  sessionId: string | null;
  createdAt: string;
}

export type NotificationType = 'info' | 'success' | 'warning' | 'error' | 'budget' | 'session';

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
// Git Types
// ============================================================================

export interface GitStatus {
  success: boolean;
  output?: string;
  error?: string;
  stderr?: string;
}

export interface GitChange {
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'staged';
  file: string;
}

export interface GitFileChange {
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'ignored';
  file: string;
  staged: boolean;
  indexStatus: string;
  workTreeStatus: string;
  originalPath?: string; // For renamed files
}

export interface GitBranchInfo {
  name: string;
  hash: string;
  upstream?: string;
  isCurrent: boolean;
  isRemote: boolean;
}

export interface GitCommitInfo {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string;
  subject: string;
}

export interface GitCommitDetail {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  body: string;
  files: GitCommitFile[];
  stats: {
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
}

export interface GitCommitFile {
  file: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';
  insertions: number;
  deletions: number;
  oldPath?: string; // For renamed files
}

export interface GitFileDiff {
  file: string;
  hunks: GitDiffHunk[];
  isBinary: boolean;
  oldPath?: string;
}

export interface GitDiffHunk {
  header: string;
  lines: GitDiffLine[];
}

export interface GitDiffLine {
  type: 'context' | 'addition' | 'deletion' | 'header';
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export interface GitDetailedStatus {
  success: boolean;
  error?: string;
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: GitFileChange[];
  branch: string;
  ahead: number;
  behind: number;
}

export interface GitAheadBehind {
  success: boolean;
  ahead: number;
  behind: number;
  hasRemote: boolean;
  hasUpstream: boolean;
  error?: string;
}

export interface GitRemote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface GitStashEntry {
  index: number;
  message: string;
  branch: string;
}

// ============================================================================
// Extended Git Types for New Features
// ============================================================================

export interface GitBlameLine {
  hash: string;
  author: string;
  authorTime: string;
  lineNumber: number;
  content: string;
}

export interface GitTag {
  name: string;
  hash: string;
  message?: string;
  tagger?: string;
  date?: string;
  isAnnotated: boolean;
}

export interface GitFileHistoryEntry {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
}

export interface GitConflictFile {
  file: string;
  ourStatus: string;
  theirStatus: string;
}

export interface GitReflogEntry {
  hash: string;
  shortHash: string;
  action: string;
  message: string;
  date: string;
  index: number;
}

export interface GitSubmodule {
  path: string;
  url: string;
  branch?: string;
  hash: string;
  status: 'initialized' | 'uninitialized' | 'modified' | 'unknown';
}

export interface GitWorktree {
  path: string;
  hash: string;
  branch?: string;
  isMain: boolean;
  isDetached: boolean;
}

// ============================================================================
// IPC Channel Types
// ============================================================================

export type IpcChannels = {
  // Terminal
  'start-claude': (options: TerminalStartOptions) => TerminalStartResult;
  'kill-terminal': (id: number) => boolean;
  'get-terminals': () => TerminalInfo[];

  // Sessions
  'get-sessions': () => Session[];
  'get-session': (id: string) => Session | null;
  'get-session-messages': (id: string) => SessionMessage[];
  'delete-session': (id: string) => boolean;
  'toggle-favorite': (id: string) => boolean;
  'toggle-archive': (id: string) => boolean;

  // Analytics
  'get-analytics': () => Analytics;

  // Settings
  'get-setting': (key: string) => unknown;
  'set-setting': (data: { key: string; value: unknown }) => boolean;
  'get-all-settings': () => Record<string, unknown>;

  // And many more...
};

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
