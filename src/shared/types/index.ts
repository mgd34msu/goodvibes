// ============================================================================
// SHARED TYPES - Used by both main and renderer processes
// ============================================================================
//
// This file re-exports all types from domain-specific modules for backward
// compatibility. New code should import from specific modules where possible.
//
// ============================================================================

// Session and message related types
export type {
  Session,
  SessionStatus,
  SessionOutcome,
  SessionMessage,
  MessageRole,
  TerminalInfo,
  TerminalStartOptions,
  TerminalStartResult,
  Collection,
  SmartCollection,
  SmartCollectionRule,
  Tag,
  Bookmark,
  Prompt,
  QuickNote,
  KnowledgeEntry,
  SessionLink,
  ActivityLogEntry,
  SessionEntryType,
  ParsedSessionEntry,
  SessionEntryCounts,
  ScanStatus,
  ExportFormat,
  ExportOptions,
  SearchOptions,
  SavedSearch,
} from './session-types.js';

// Tag system types
export type {
  TagEffect,
  TagSource,
  SuggestionCategory,
  SuggestionStatus,
  SessionTag,
  TagSuggestion,
  SuggestionFeedback,
  TagTemplate,
  CreateTagInput,
  UpdateTagInput,
  TagFilterExpression,
  ScanProgress,
  ScanStatusInfo,
  ScanCostEstimate,
  TagStatistics,
} from './tag-types.js';

// Analytics and project types
export type {
  Analytics,
  SessionTimeData,
  ToolUsageStat,
  RegisteredProject,
  ProjectSettings,
  ProjectTemplate,
  TemplateAgent,
  ProjectAnalytics,
} from './analytics-types.js';

// Settings and notification types
export type {
  AppSettings,
  AppNotification,
  NotificationType,
  IpcChannels,
} from './settings-types.js';

export {
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  SETTINGS_MIGRATIONS,
  REMOVED_SETTINGS,
} from './settings-types.js';

// Git types
export type {
  GitStatus,
  GitChange,
  GitFileChange,
  GitBranchInfo,
  GitCommitInfo,
  GitCommitDetail,
  GitCommitFile,
  GitFileDiff,
  GitDiffHunk,
  GitDiffLine,
  GitDetailedStatus,
  GitAheadBehind,
  GitRemote,
  GitStashEntry,
  GitBlameLine,
  GitTag,
  GitFileHistoryEntry,
  GitConflictFile,
  GitReflogEntry,
  GitSubmodule,
  GitWorktree,
} from './git-types.js';

// IPC result types
export type {
  IPCResult,
  IPCBooleanResult,
} from './ipc-types.js';

export {
  ipcOk,
  ipcErr,
  ipcBoolOk,
  ipcBoolErr,
} from './ipc-types.js';

// Theme types
export type {
  ColorScale,
  GlowColors,
  GradientStops,
  SemanticColorSet,
  BackgroundColors,
  TextColors,
  BorderColors,
  TerminalColors,
  ThemeColors,
  Theme,
  ThemeId,
  ThemeMetadata,
} from './theme-types.js';

export {
  THEME_IDS,
  DEFAULT_THEME_ID,
  isThemeId,
} from './theme-types.js';
