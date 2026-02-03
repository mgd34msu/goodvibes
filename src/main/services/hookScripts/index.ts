// ============================================================================
// HOOK SCRIPTS - Main Entry Point
// ============================================================================
//
// This module generates and installs hook scripts to ~/.goodvibes/hooks/
// These scripts are executed by Claude Code for each hook event, and they
// forward the event data to GoodVibes's HTTP server.
//
// Claude hooks work by:
// 1. Claude spawns the hook script as a child process
// 2. Claude sends JSON to the script's stdin
// 3. Script reads stdin, processes, writes JSON to stdout
// 4. Script exits with code (0=allow, 2=block)
//
// ============================================================================

// Re-export types
export type {
  ExtendedHookEventType,
  HookCategory,
  ClaudeHookEntry,
  ClaudeHookConfig,
  HookScriptValidationResult,
  AllHookScriptsValidationResult,
} from './types.js';

// Re-export constants
export {
  HOOKS_DIR,
  CLAUDE_SETTINGS_DIR,
  CLAUDE_SETTINGS_PATH,
  ALL_HOOK_EVENTS,
} from './types.js';

// Re-export script generation
export {
  getHookCategory,
  eventTypeToFileName,
  generateHookScript,
} from './script-generator.js';

// Re-export installation functions
export {
  getHookScriptPath,
  installHookScript,
  installAllHookScripts,
  getInstalledHookScripts,
  removeAllHookScripts,
  areHookScriptsInstalled,
} from './installation.js';

// Re-export Claude config functions
export {
  generateClaudeHooksConfig,
  getHookConfigForEvent,
  configureClaudeHooks,
  removeClaudeHooks,
  areClaudeHooksConfigured,
} from './claude-config.js';

// Re-export validation functions
export {
  validateHookScript,
  validateAllHookScripts,
} from './validation.js';
