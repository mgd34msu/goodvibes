// ============================================================================
// HOOKS SERVICE - Shared Types and Interfaces
// ============================================================================

import type { HookEventType } from '../../database/primitives.js';

// Re-export for convenience
export type { HookConfig, HookEventType } from '../../database/primitives.js';

/**
 * Context passed to hooks during execution
 */
export interface HookExecutionContext {
  eventType: HookEventType;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  sessionId?: string;
  projectPath?: string;
  timestamp: number;
}

/**
 * Result of executing a single hook
 */
export interface HookExecutionResult {
  hookId: number;
  hookName: string;
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  shouldBlock: boolean; // exit code 2 means block the action
}

/**
 * Hook configuration in Claude settings.json format
 */
export interface ClaudeSettingsHook {
  matcher: string;
  hooks: Array<{
    type: 'command';
    command: string;
    timeout?: number;
  }>;
}

/**
 * Claude settings.json structure
 */
export interface ClaudeSettings {
  hooks?: {
    PreToolUse?: ClaudeSettingsHook[];
    PostToolUse?: ClaudeSettingsHook[];
    SessionStart?: ClaudeSettingsHook[];
    SessionEnd?: ClaudeSettingsHook[];
    Notification?: ClaudeSettingsHook[];
    Stop?: ClaudeSettingsHook[];
  };
  permissions?: {
    allow?: string[];
    deny?: string[];
  };
  env?: Record<string, string>;
  [key: string]: unknown;
}
