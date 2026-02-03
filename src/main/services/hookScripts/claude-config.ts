// ============================================================================
// HOOK SCRIPTS - Claude Settings Integration
// ============================================================================
//
// This module handles reading and writing Claude's settings.json to configure
// GoodVibes hooks. It manages the hooks configuration that tells Claude
// which scripts to execute for each hook event.
//
// ============================================================================

import fs from 'fs/promises';
import { existsSync } from 'fs';
import { Logger } from '../logger.js';
import {
  CLAUDE_SETTINGS_DIR,
  CLAUDE_SETTINGS_PATH,
  ALL_HOOK_EVENTS,
} from './types.js';
import type { ExtendedHookEventType, ClaudeHookEntry, ClaudeHookConfig } from './types.js';
import { getHookScriptPath } from './installation.js';

const logger = new Logger('HookScripts:ClaudeConfig');

// ============================================================================
// CONFIG GENERATION
// ============================================================================

/**
 * Generate Claude settings.json hook configuration for all events
 */
export function generateClaudeHooksConfig(): Record<string, ClaudeHookConfig[]> {
  const config: Record<string, ClaudeHookConfig[]> = {};

  for (const eventType of ALL_HOOK_EVENTS) {
    const scriptPath = getHookScriptPath(eventType);

    config[eventType] = [{
      matcher: '*',
      hooks: [{
        type: 'command',
        command: `node "${scriptPath}"`,
        timeout: 10000,
      }],
    }];
  }

  return config;
}

/**
 * Get the hook configuration for a specific event type
 */
export function getHookConfigForEvent(eventType: ExtendedHookEventType): ClaudeHookConfig {
  const scriptPath = getHookScriptPath(eventType);

  return {
    matcher: '*',
    hooks: [{
      type: 'command',
      command: `node "${scriptPath}"`,
      timeout: 10000,
    }],
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Check if a hook entry is a GoodVibes hook
 */
function isGoodVibesHook(hook: ClaudeHookEntry): boolean {
  return hook?.hooks?.some?.((h: { command?: string }) =>
    h?.command?.includes?.('.goodvibes/hooks/') ||
    h?.command?.includes?.('.goodvibes\\hooks\\')
  ) ?? false;
}

// ============================================================================
// CLAUDE SETTINGS OPERATIONS
// ============================================================================

/**
 * Configure Claude's settings.json to use GoodVibes hooks.
 * This is the critical step that tells Claude to actually run the hook scripts.
 */
export async function configureClaudeHooks(): Promise<boolean> {
  try {
    // Ensure Claude settings directory exists
    if (!existsSync(CLAUDE_SETTINGS_DIR)) {
      await fs.mkdir(CLAUDE_SETTINGS_DIR, { recursive: true });
      logger.info(`Created Claude settings directory: ${CLAUDE_SETTINGS_DIR}`);
    }

    // Read existing settings or start fresh
    let settings: Record<string, unknown> = {};
    if (existsSync(CLAUDE_SETTINGS_PATH)) {
      try {
        const content = await fs.readFile(CLAUDE_SETTINGS_PATH, 'utf-8');
        settings = JSON.parse(content);
        logger.debug('Read existing Claude settings.json');
      } catch (error) {
        logger.warn('Failed to parse existing Claude settings.json, starting fresh', {
          error: error instanceof Error ? error.message : String(error),
          path: CLAUDE_SETTINGS_PATH,
        });
        settings = {};
      }
    }

    // Generate hook configurations
    const hooksConfig = generateClaudeHooksConfig();

    // Merge with existing hooks (GoodVibes hooks take precedence)
    const existingHooks = (settings.hooks || {}) as Record<string, ClaudeHookEntry[]>;
    const mergedHooks: Record<string, unknown[]> = { ...existingHooks };

    for (const [eventType, goodvibesHooks] of Object.entries(hooksConfig)) {
      // Get existing hooks for this event type (non-GoodVibes ones)
      const existingEventHooks = (existingHooks[eventType] || []).filter((hook: ClaudeHookEntry) => {
        return !isGoodVibesHook(hook);
      });

      // Combine: existing non-GoodVibes hooks + GoodVibes hooks
      mergedHooks[eventType] = [...existingEventHooks, ...goodvibesHooks];
    }

    settings.hooks = mergedHooks;

    // Write updated settings
    await fs.writeFile(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
    logger.info(`Configured Claude hooks in: ${CLAUDE_SETTINGS_PATH}`);

    return true;
  } catch (error) {
    logger.error('Failed to configure Claude hooks:', error);
    return false;
  }
}

/**
 * Remove GoodVibes hooks from Claude's settings.json
 */
export async function removeClaudeHooks(): Promise<boolean> {
  try {
    if (!existsSync(CLAUDE_SETTINGS_PATH)) {
      return true; // Nothing to remove
    }

    const content = await fs.readFile(CLAUDE_SETTINGS_PATH, 'utf-8');
    const settings = JSON.parse(content);

    if (!settings.hooks) {
      return true; // No hooks to remove
    }

    // Filter out GoodVibes hooks
    const hooks = settings.hooks as Record<string, ClaudeHookEntry[]>;
    for (const eventType of Object.keys(hooks)) {
      hooks[eventType] = (hooks[eventType] || []).filter((hook: ClaudeHookEntry) => {
        return !isGoodVibesHook(hook);
      });

      // Remove empty arrays
      if (hooks[eventType].length === 0) {
        delete hooks[eventType];
      }
    }

    // Remove hooks object if empty
    if (Object.keys(hooks).length === 0) {
      delete settings.hooks;
    }

    await fs.writeFile(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
    logger.info('Removed GoodVibes hooks from Claude settings');

    return true;
  } catch (error) {
    logger.error('Failed to remove Claude hooks:', error);
    return false;
  }
}

/**
 * Check if Claude's settings.json is configured with GoodVibes hooks
 */
export async function areClaudeHooksConfigured(): Promise<boolean> {
  try {
    if (!existsSync(CLAUDE_SETTINGS_PATH)) {
      return false;
    }

    const content = await fs.readFile(CLAUDE_SETTINGS_PATH, 'utf-8');
    const settings = JSON.parse(content);

    if (!settings.hooks) {
      return false;
    }

    // Check if at least SessionStart hook is configured (our most important hook)
    const sessionStartHooks = settings.hooks.SessionStart || [];
    return sessionStartHooks.some((hook: ClaudeHookEntry) => isGoodVibesHook(hook));
  } catch (error) {
    logger.debug('Failed to check Claude hooks configuration:', error);
    return false;
  }
}
