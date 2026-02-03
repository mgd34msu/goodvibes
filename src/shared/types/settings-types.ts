// ============================================================================
// SETTINGS TYPES - Application settings and configuration types
// ============================================================================

import type { ThemeId } from './theme-types.js';

// ============================================================================
// Settings Types
// ============================================================================

export interface AppSettings {
  theme: 'dark' | 'light';
  colorTheme: ThemeId;
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
  // Terminal settings
  preferredShell: string | null;
  customShells: string[];
  preferredTextEditor: string | null;
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
  // Session backup settings
  sessionBackupEnabled: boolean;
  timezone: string;
  // Tag Display Settings
  showTagsInSessionList: boolean;
  maxVisibleTagsInList: number;
  // Tag Filter Settings
  defaultFilterLogic: 'and' | 'or';
  rememberFilterState: boolean;
  // AI Suggestion Settings
  enableAiSuggestions: boolean;
  aiSuggestionsSessionsPerHour: number;
  aiSuggestionsMinSessionLength: number; // minimum messages
  aiSuggestionsScanDepth: 'quick' | 'full';
  aiSuggestionsAutoAccept: boolean;
  aiSuggestionsAutoAcceptThreshold: number; // 0-1 confidence threshold
  tagScanRateLimitEnabled: boolean; // Enable rate limiting for tag scanning
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  colorTheme: 'goodvibes-classic',
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
  // Terminal settings
  preferredShell: null,
  customShells: [],
  preferredTextEditor: null,
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
  // Session backup settings
  sessionBackupEnabled: true,
  timezone: 'UTC',
  // Tag Display Settings
  showTagsInSessionList: true,
  maxVisibleTagsInList: 3,
  // Tag Filter Settings
  defaultFilterLogic: 'and',
  rememberFilterState: true,
  // AI Suggestion Settings
  enableAiSuggestions: false, // disabled by default
  aiSuggestionsSessionsPerHour: 60,
  aiSuggestionsMinSessionLength: 5,
  aiSuggestionsScanDepth: 'quick',
  aiSuggestionsAutoAccept: false,
  aiSuggestionsAutoAcceptThreshold: 0.9,
  tagScanRateLimitEnabled: true, // enabled by default
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
// Version 6: Added session backup settings
// Version 7: Added terminal shell settings (preferredShell, customShells)
// Version 8: Added preferredTextEditor setting
// Version 9: Added colorTheme setting for dynamic theming
// Version 10: Added timezone setting
export const SETTINGS_VERSION = 12;

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
  // Version 6: Added session backup settings
  6: [
    'sessionBackupEnabled',
  ],
  // Version 7: Added terminal shell settings
  7: [
    'preferredShell',
    'customShells',
  ],
  // Version 8: Added text editor setting
  8: [
    'preferredTextEditor',
  ],
  // Version 9: Added colorTheme setting
  9: ['colorTheme'],
  // Version 10: Added timezone setting
  10: ['timezone'],
  // Version 11: Added session tagging system settings
  11: [
    'showTagsInSessionList',
    'maxVisibleTagsInList',
    'defaultFilterLogic',
    'rememberFilterState',
    'enableAiSuggestions',
    'aiSuggestionsSessionsPerHour',
    'aiSuggestionsMinSessionLength',
    'aiSuggestionsScanDepth',
    'aiSuggestionsAutoAccept',
    'aiSuggestionsAutoAcceptThreshold',
  ],
  // Version 12: Added rate limit toggle for tag scanning
  12: [
    'tagScanRateLimitEnabled',
  ],
};

// Settings that were removed and should be cleaned up during migration
export const REMOVED_SETTINGS: Record<number, string[]> = {
  4: ['githubClientId'], // Moved to bundled OAuth credentials
};

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
// IPC Channel Types
// ============================================================================

import type { Session, SessionMessage, TerminalInfo, TerminalStartOptions, TerminalStartResult } from './session-types.js';
import type { Analytics } from './analytics-types.js';

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
