// ============================================================================
// HOOK SCRIPTS - Types and Constants
// ============================================================================

import path from 'path';
import os from 'os';
import type { ExtendedHookEventType } from '../../database/hookEvents.js';

// Re-export the extended hook event type for convenience
export type { ExtendedHookEventType } from '../../database/hookEvents.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * Directory where hook scripts are installed
 */
export const HOOKS_DIR = path.join(os.homedir(), '.goodvibes', 'hooks');

/**
 * Path to Claude's user-level settings directory
 */
export const CLAUDE_SETTINGS_DIR = path.join(os.homedir(), '.claude');

/**
 * Path to Claude's user-level settings.json
 */
export const CLAUDE_SETTINGS_PATH = path.join(CLAUDE_SETTINGS_DIR, 'settings.json');

/**
 * All 12 Claude hook event types
 */
export const ALL_HOOK_EVENTS: ExtendedHookEventType[] = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'PermissionRequest',
  'UserPromptSubmit',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'Notification',
];

// ============================================================================
// TYPES
// ============================================================================

/**
 * Hook categories for determining output format.
 * Claude Code expects different JSON schemas for different hook types:
 *
 * PreToolUse:
 *   { hookEventName, permissionDecision: "allow"|"deny"|"ask", permissionDecisionReason?, updatedInput? }
 *
 * UserPromptSubmit:
 *   { hookEventName, additionalContext (required, can be empty string) }
 *
 * PostToolUse:
 *   { hookEventName, additionalContext? }
 *
 * Stop hooks (SessionStart, SessionEnd, SubagentStart, SubagentStop, Stop, Notification, PreCompact, PermissionRequest, PostToolUseFailure):
 *   { continue: true|false, stopReason? }
 */
export type HookCategory = 'PreToolUse' | 'UserPromptSubmit' | 'PostToolUse' | 'Stop';

/**
 * Claude hook configuration entry in settings.json
 */
export interface ClaudeHookEntry {
  hooks?: Array<{
    command?: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

/**
 * Hook configuration for Claude settings.json
 */
export interface ClaudeHookConfig {
  matcher: string;
  hooks: Array<{
    type: 'command';
    command: string;
    timeout?: number;
  }>;
}

/**
 * Result of validating a hook script
 */
export interface HookScriptValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Result of validating all hook scripts
 */
export interface AllHookScriptsValidationResult {
  valid: boolean;
  results: Record<string, HookScriptValidationResult>;
}
