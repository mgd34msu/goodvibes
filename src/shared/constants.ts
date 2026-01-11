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
// COST ESTIMATION
// ============================================================================

/** Cost per million input tokens in USD */
export const COST_PER_MILLION_INPUT_TOKENS = 3;

/** Cost per million output tokens in USD */
export const COST_PER_MILLION_OUTPUT_TOKENS = 15;

/**
 * Assumed input/output token ratio for cost estimation when breakdown is unknown.
 *
 * When session files don't provide separate input/output token counts, we estimate
 * cost by assuming this ratio of total tokens. A value of 0.5 means we assume
 * 50% of tokens are input and 50% are output.
 *
 * This is a simplification since actual ratios vary significantly by use case:
 * - Code generation: May have higher output ratio (more generated code than prompts)
 * - Q&A sessions: May have more balanced ratios
 * - Context-heavy sessions: Higher input ratio (large files in context)
 *
 * The 0.5 default provides a reasonable middle-ground estimate. For accurate
 * cost tracking, sessions should provide the actual input/output breakdown
 * which takes precedence over this estimate.
 *
 * @see sessionManager.ts estimateCost() for usage
 */
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

// Terminal themes
export const TERMINAL_THEMES = {
  dark: {
    background: '#1a1a2e',
    foreground: '#e4e4e7',
    cursor: '#a855f7',
    cursorAccent: '#1a1a2e',
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
  'notes',
  'knowledge',
  'hooks',
  'mcp',
  'agents',
  'memory',
  'skills',
  'monitor',
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
    label: 'Claude',
    views: ['memory', 'agents', 'skills', 'mcp', 'hooks'],
  },
  {
    id: 'monitoring',
    label: 'Monitoring',
    views: ['monitor', 'analytics'],
  },
  {
    id: 'knowledge',
    label: 'Knowledge',
    views: ['knowledge', 'notes'],
  },
  {
    id: 'system',
    label: 'System',
    views: ['projects', 'settings'],
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
