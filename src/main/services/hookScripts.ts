// ============================================================================
// HOOK SCRIPTS - Re-export from modular structure
// ============================================================================
//
// This file maintains backward compatibility by re-exporting all functions
// from the modular hookScripts/ directory.
//
// For new code, prefer importing directly from './hookScripts/index.js'
//
// ============================================================================

export {
  // Types
  type ExtendedHookEventType,
  type HookCategory,
  type ClaudeHookEntry,
  type ClaudeHookConfig,
  type HookScriptValidationResult,
  type AllHookScriptsValidationResult,
  // Constants
  HOOKS_DIR,
  CLAUDE_SETTINGS_DIR,
  CLAUDE_SETTINGS_PATH,
  ALL_HOOK_EVENTS,
  // Script generation
  getHookCategory,
  eventTypeToFileName,
  generateHookScript,
  // Installation
  getHookScriptPath,
  installHookScript,
  installAllHookScripts,
  getInstalledHookScripts,
  removeAllHookScripts,
  areHookScriptsInstalled,
  // Claude config
  generateClaudeHooksConfig,
  getHookConfigForEvent,
  configureClaudeHooks,
  removeClaudeHooks,
  areClaudeHooksConfigured,
  // Validation
  validateHookScript,
  validateAllHookScripts,
} from './hookScripts/index.js';
