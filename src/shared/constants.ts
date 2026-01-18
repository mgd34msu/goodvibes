// ============================================================================
// SHARED CONSTANTS
// ============================================================================

// Context window limit for Claude
export const CONTEXT_WINDOW_LIMIT = 200000;

// Pagination
export const DEFAULT_PAGE_SIZE = 50;

// Session file patterns
export const SESSION_FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
export const AGENT_SESSION_PATTERN = /^agent-[a-z0-9]+\.jsonl$/i;

// Auto-tag patterns
export const AUTO_TAG_PATTERNS = [
  { pattern: /\b(bug|fix|error|issue|crash|fail)\b/i, tag: 'bugfix', color: '#ef4444' },
  { pattern: /\b(feature|implement|add|create|new)\b/i, tag: 'feature', color: '#22c55e' },
  { pattern: /\b(refactor|clean|improve|optimize)\b/i, tag: 'refactor', color: '#8b5cf6' },
  { pattern: /\b(test|spec|jest|mocha|pytest)\b/i, tag: 'testing', color: '#06b6d4' },
  { pattern: /\b(doc|readme|comment|explain)\b/i, tag: 'docs', color: '#f59e0b' },
  { pattern: /\b(deploy|build|ci|cd|pipeline)\b/i, tag: 'devops', color: '#ec4899' },
  { pattern: /\b(react|vue|angular|svelte)\b/i, tag: 'frontend', color: '#3b82f6' },
  { pattern: /\b(api|server|backend|database|sql)\b/i, tag: 'backend', color: '#10b981' },
  { pattern: /\b(style|css|scss|tailwind|design)\b/i, tag: 'styling', color: '#f472b6' },
] as const;

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

/** @deprecated Use MODEL_PRICING instead */
export const COST_PER_MILLION_INPUT_TOKENS = 3;

/** @deprecated Use MODEL_PRICING instead */
export const COST_PER_MILLION_OUTPUT_TOKENS = 15;

/** @deprecated No longer used - we have actual token breakdowns */
export const TOKEN_RATIO_ASSUMPTION = 0.5;

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

/** Hook script HTTP timeout (ms) */
export const HOOK_SCRIPT_TIMEOUT_MS = 5000;

/** Deduplication window for agent detection (ms) */
export const AGENT_DEDUP_WINDOW_MS = 5000;

/** Default retry delay (ms) */
export const DEFAULT_RETRY_DELAY_MS = 1000;

/** Maximum retry delay (ms) */
export const MAX_RETRY_DELAY_MS = 30000;

/** Default number of retries */
export const DEFAULT_MAX_RETRIES = 3;

/** File watch interval (ms) */
export const DEFAULT_FILE_WATCH_INTERVAL_MS = 1000;

// ============================================================================
// ARRAY VALIDATION HELPERS
// ============================================================================

/**
 * Check if an array has elements
 */
export function hasElements<T>(arr: T[] | null | undefined): arr is T[] {
  return Array.isArray(arr) && arr.length > 0;
}

/**
 * Check if an array is empty or undefined
 */
export function isEmpty<T>(arr: T[] | null | undefined): boolean {
  return !hasElements(arr);
}

// Terminal themes
export const TERMINAL_THEMES = {
  dark: {
    background: '#020617',
    foreground: '#e4e4e7',
    cursor: '#a855f7',
    cursorAccent: '#020617',
    selectionBackground: '#6366f150',
    black: '#27272a',
    red: '#ef4444',
    green: '#22c55e',
    yellow: '#f59e0b',
    blue: '#3b82f6',
    magenta: '#a855f7',
    cyan: '#06b6d4',
    white: '#e4e4e7',
    brightBlack: '#52525b',
    brightRed: '#f87171',
    brightGreen: '#4ade80',
    brightYellow: '#fbbf24',
    brightBlue: '#60a5fa',
    brightMagenta: '#c084fc',
    brightCyan: '#22d3ee',
    brightWhite: '#fafafa',
  },
  light: {
    background: '#fafafa',
    foreground: '#18181b',
    cursor: '#7c3aed',
    cursorAccent: '#fafafa',
    selectionBackground: '#6366f130',
    black: '#18181b',
    red: '#dc2626',
    green: '#16a34a',
    yellow: '#d97706',
    blue: '#2563eb',
    magenta: '#7c3aed',
    cyan: '#0891b2',
    white: '#f4f4f5',
    brightBlack: '#71717a',
    brightRed: '#ef4444',
    brightGreen: '#22c55e',
    brightYellow: '#f59e0b',
    brightBlue: '#3b82f6',
    brightMagenta: '#a855f7',
    brightCyan: '#06b6d4',
    brightWhite: '#fafafa',
  },
} as const;

// Keyboard shortcuts
export const KEYBOARD_SHORTCUTS = {
  newTerminal: { key: 'n', ctrlKey: true },
  closeTab: { key: 'w', ctrlKey: true },
  nextTab: { key: 'Tab', ctrlKey: true },
  prevTab: { key: 'Tab', ctrlKey: true, shiftKey: true },
  quickSwitcher: { key: 'k', ctrlKey: true },
  commandPalette: { key: 'p', ctrlKey: true, shiftKey: true },
  search: { key: 'f', ctrlKey: true },
  zoomIn: { key: '+', ctrlKey: true },
  zoomOut: { key: '-', ctrlKey: true },
  zoomReset: { key: '0', ctrlKey: true },
  toggleGit: { key: 'g', ctrlKey: true },
  quickNote: { key: 'n', ctrlKey: true, shiftKey: true },
  help: { key: 'F1' },
} as const;

// View names
export const VIEWS = [
  'terminal',
  'sessions',
  'analytics',
  'tasks',
  'knowledge',
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
    views: ['knowledge', 'tasks'],
  },
  {
    id: 'system',
    label: 'System',
    views: ['analytics', 'projects', 'settings'],
  },
];

// Session templates
export const SESSION_TEMPLATES = [
  { id: 'code-review', icon: '🔍', label: 'Code Review', desc: 'Review code for bugs, best practices, and improvements' },
  { id: 'refactor', icon: '🔧', label: 'Refactor', desc: 'Improve code structure and readability' },
  { id: 'debug', icon: '🐛', label: 'Debug Issue', desc: 'Find and fix bugs in the codebase' },
  { id: 'docs', icon: '📝', label: 'Documentation', desc: 'Generate or improve documentation' },
  { id: 'test', icon: '🧪', label: 'Write Tests', desc: 'Create unit and integration tests' },
  { id: 'feature', icon: '✨', label: 'New Feature', desc: 'Implement a new feature or enhancement' },
] as const;
