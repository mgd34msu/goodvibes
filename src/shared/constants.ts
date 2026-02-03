// ============================================================================
// SHARED CONSTANTS
// ============================================================================

// Maximum recent projects to keep
export const MAX_RECENT_PROJECTS = 10;

// Session scanning intervals (in milliseconds)
export const SESSION_SCAN_INTERVAL_MS = 2000;
export const NEW_SESSION_THRESHOLD_MS = 30000;
export const LIVE_SESSION_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
export const SESSION_FILE_WATCH_INTERVAL_MS = 500;
export const LIVE_SESSION_CHECK_THRESHOLD_MS = 30000; // 30 seconds

// ============================================================================
// COST ESTIMATION (per million tokens in USD)
// ============================================================================

/**
 * Model pricing per million tokens (MTok) in USD.
 * Source: https://platform.claude.com/docs/en/about-claude/pricing
 *
 * Cache multipliers:
 * - Cache creation (5m): 1.25x base input price
 * - Cache read: 0.1x base input price
 */
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Opus models
  'claude-opus-4-5': { input: 5, output: 25 },
  'claude-opus-4-1': { input: 15, output: 75 },
  'claude-opus-4': { input: 15, output: 75 },
  'claude-opus-3': { input: 15, output: 75 },
  // Sonnet models
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-sonnet-3-7': { input: 3, output: 15 },
  'claude-sonnet-3-5': { input: 3, output: 15 },
  // Haiku models
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-haiku-3-5': { input: 0.8, output: 4 },
  'claude-haiku-3': { input: 0.25, output: 1.25 },
};

/** Cache write multiplier (1.25x base input price) */
export const CACHE_WRITE_MULTIPLIER = 1.25;

/** Cache read multiplier (0.1x base input price) */
export const CACHE_READ_MULTIPLIER = 0.1;

/** Default pricing when model is unknown (uses Sonnet 4 pricing) */
export const DEFAULT_INPUT_PRICE = 3;
export const DEFAULT_OUTPUT_PRICE = 15;

// ============================================================================
// TIMEOUTS AND LIMITS
// ============================================================================

/** Delay before starting session scan after window ready (ms) */
export const SESSION_SCAN_INIT_DELAY_MS = 500;

/** Maximum length for string validations */
export const MAX_STRING_LENGTH = 10000;

/** Maximum path length for file path validations */
export const MAX_PATH_LENGTH = 1000;

/** Graceful shutdown timeout (ms) */
export const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10000;

/** Git command timeout (ms) */
export const GIT_COMMAND_TIMEOUT_MS = 30000;

/** Default hook timeout (ms) */
export const DEFAULT_HOOK_TIMEOUT_MS = 30000;

/** Deduplication window for agent detection (ms) */
export const AGENT_DEDUP_WINDOW_MS = 5000;

// ============================================================================
// UI CONFIGURATION
// ============================================================================

// View names
export const VIEWS = [
  'terminal',
  'sessions',
  'analytics',
  'tasks',
  'notebook',
  'files',
  'hooks',
  'mcp',
  'plugins',
  'agents',
  'memory',
  'skills',
  'commands',
  'projects',
  'settings',
] as const;

export type ViewName = (typeof VIEWS)[number];

// Navigation menu groupings for the title bar
export interface NavGroup {
  id: string;
  label: string;
  views: ViewName[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'code',
    label: 'Code',
    views: ['terminal', 'sessions'],
  },
  {
    id: 'claude',
    label: 'Features',
    views: ['memory', 'agents', 'skills', 'commands', 'hooks', 'mcp', 'plugins'],
  },
  {
    id: 'organize',
    label: 'Organize',
    views: ['notebook', 'files', 'tasks'],
  },
  {
    id: 'system',
    label: 'System',
    views: ['analytics', 'projects', 'settings'],
  },
];

