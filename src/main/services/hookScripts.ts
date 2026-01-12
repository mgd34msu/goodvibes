// ============================================================================
// HOOK SCRIPTS - Generate and install Claude hook scripts
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

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { Logger } from './logger.js';
import { HOOK_SERVER_PORT } from './hookServer.js';
import type { ExtendedHookEventType } from '../database/hookEvents.js';

const logger = new Logger('HookScripts');

// ============================================================================
// TYPES
// ============================================================================

/**
 * Claude hook configuration entry in settings.json
 */
interface ClaudeHookEntry {
  hooks?: Array<{
    command?: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

// ============================================================================
// CONSTANTS
// ============================================================================

export const HOOKS_DIR = path.join(os.homedir(), '.goodvibes', 'hooks');

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
// SCRIPT TEMPLATES
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
type HookCategory = 'PreToolUse' | 'UserPromptSubmit' | 'PostToolUse' | 'Stop';

function getHookCategory(eventType: ExtendedHookEventType): HookCategory {
  switch (eventType) {
    case 'PreToolUse':
      return 'PreToolUse';
    case 'UserPromptSubmit':
      return 'UserPromptSubmit';
    case 'PostToolUse':
      return 'PostToolUse';
    // All other hooks are "stop" hooks that can prevent continuation
    case 'SessionStart':
    case 'SessionEnd':
    case 'SubagentStart':
    case 'SubagentStop':
    case 'Stop':
    case 'Notification':
    case 'PreCompact':
    case 'PermissionRequest':
    case 'PostToolUseFailure':
    default:
      return 'Stop';
  }
}

/**
 * Generate the hook script content for a given event type
 */
function generateHookScript(eventType: ExtendedHookEventType): string {
  // Convert event type to kebab-case for file naming
  const fileName = eventType.replace(/([A-Z])/g, '-$1').toLowerCase().slice(1);
  const hookCategory = getHookCategory(eventType);

  return `#!/usr/bin/env node
// ============================================================================
// GoodVibes Hook Script: ${eventType}
// Generated automatically - do not edit manually
// ============================================================================
//
// This script is executed by Claude Code for the ${eventType} hook event.
// It reads JSON from stdin, forwards to GoodVibes's HTTP server,
// and returns the decision to Claude in the CORRECT format.
//
// Hook Category: ${hookCategory}
//
// ============================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Configuration
const GOODVIBES_PORT = ${HOOK_SERVER_PORT};
const GOODVIBES_HOST = '127.0.0.1';
const TIMEOUT_MS = 5000;
const HOOK_EVENT_NAME = '${eventType}';
const HOOK_CATEGORY = '${hookCategory}';
const LOG_FILE = path.join(os.homedir(), '.goodvibes', 'hooks.log');

// Log function - writes to file for debugging
function logToFile(message) {
  try {
    const timestamp = new Date().toISOString();
    fs.appendFileSync(LOG_FILE, \`[\${timestamp}] [\${HOOK_EVENT_NAME}] \${message}\\n\`);
  } catch (e) {
    // Ignore log errors
  }
}

logToFile('Hook script started');

/**
 * Format response for Claude based on hook category.
 * Claude expects different JSON schemas for different hook types.
 */
function formatResponseForClaude(serverResponse) {
  const decision = serverResponse.decision || 'allow';
  const blocked = decision === 'block' || decision === 'deny';

  switch (HOOK_CATEGORY) {
    case 'PreToolUse':
      // Schema: { hookEventName, permissionDecision, permissionDecisionReason?, updatedInput? }
      const preToolResponse = {
        hookEventName: HOOK_EVENT_NAME,
        permissionDecision: blocked ? 'deny' : 'allow',
      };
      if (serverResponse.message) {
        preToolResponse.permissionDecisionReason = serverResponse.message;
      }
      if (serverResponse.modified_input) {
        preToolResponse.updatedInput = serverResponse.modified_input;
      }
      return preToolResponse;

    case 'UserPromptSubmit':
      // Schema: { hookEventName, additionalContext (required) }
      return {
        hookEventName: HOOK_EVENT_NAME,
        additionalContext: serverResponse.inject_context || '',
      };

    case 'PostToolUse':
      // Schema: { hookEventName, additionalContext? }
      const postToolResponse = {
        hookEventName: HOOK_EVENT_NAME,
      };
      if (serverResponse.inject_context) {
        postToolResponse.additionalContext = serverResponse.inject_context;
      }
      return postToolResponse;

    case 'Stop':
    default:
      // Schema: { continue: boolean, stopReason? }
      // Stop hooks use "continue" to indicate whether to proceed
      const stopResponse = {
        continue: !blocked,
      };
      if (blocked && serverResponse.message) {
        stopResponse.stopReason = serverResponse.message;
      }
      // For session/agent start hooks, we can inject context via additionalContext
      if (serverResponse.inject_context) {
        stopResponse.additionalContext = serverResponse.inject_context;
      }
      return stopResponse;
  }
}

/**
 * Get the default allow response for this hook category
 */
function getDefaultAllowResponse() {
  switch (HOOK_CATEGORY) {
    case 'PreToolUse':
      return { hookEventName: HOOK_EVENT_NAME, permissionDecision: 'allow' };
    case 'UserPromptSubmit':
      return { hookEventName: HOOK_EVENT_NAME, additionalContext: '' };
    case 'PostToolUse':
      return { hookEventName: HOOK_EVENT_NAME };
    case 'Stop':
    default:
      return { continue: true };
  }
}

// Read JSON from stdin (how Claude passes hook data)
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});

process.stdin.on('end', async () => {
  try {
    logToFile('Received input: ' + input.substring(0, 500));

    // Parse the input from Claude
    const hookData = input.trim() ? JSON.parse(input) : {};
    logToFile('Parsed hook data, keys: ' + Object.keys(hookData).join(', '));

    // Forward to GoodVibes's HTTP server
    logToFile('Posting to GoodVibes...');
    const response = await postToGoodVibes('/api/hooks/${fileName}', {
      hook_event_name: '${eventType}',
      ...hookData,
      timestamp: Date.now(),
    });
    logToFile('GoodVibes response: ' + JSON.stringify(response));

    // Format and output the response in Claude's expected format
    const claudeResponse = formatResponseForClaude(response);
    logToFile('Sending to Claude: ' + JSON.stringify(claudeResponse));
    console.log(JSON.stringify(claudeResponse));

    // Exit with code 2 if blocked/denied, 0 otherwise
    const blocked = response.decision === 'block' || response.decision === 'deny';
    logToFile('Exiting with code: ' + (blocked ? 2 : 0));
    process.exit(blocked ? 2 : 0);

  } catch (err) {
    // On error, fail open (allow the action)
    // This ensures GoodVibes issues don't break Claude
    logToFile('ERROR: ' + err.message);
    console.error('[GoodVibes] Hook error:', err.message);
    console.log(JSON.stringify(getDefaultAllowResponse()));
    process.exit(0);
  }
});

// Handle stdin errors
process.stdin.on('error', (err) => {
  console.error('[GoodVibes] stdin error:', err.message);
  console.log(JSON.stringify(getDefaultAllowResponse()));
  process.exit(0);
});

/**
 * POST data to GoodVibes's HTTP server
 */
function postToGoodVibes(path, data) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(data);

    const req = http.request({
      hostname: GOODVIBES_HOST,
      port: GOODVIBES_PORT,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          // If we can't parse the response, treat as allow
          resolve({ decision: 'allow' });
        }
      });
    });

    req.on('error', (err) => {
      // If GoodVibes is not running, allow the action
      resolve({ decision: 'allow' });
    });

    req.on('timeout', () => {
      req.destroy();
      // On timeout, allow the action
      resolve({ decision: 'allow' });
    });

    req.write(postData);
    req.end();
  });
}
`;
}

// ============================================================================
// INSTALLATION
// ============================================================================

/**
 * Install all hook scripts to ~/.goodvibes/hooks/
 */
export async function installAllHookScripts(): Promise<void> {
  logger.info('Installing hook scripts...');

  // Ensure hooks directory exists
  if (!existsSync(HOOKS_DIR)) {
    await fs.mkdir(HOOKS_DIR, { recursive: true });
    logger.info(`Created hooks directory: ${HOOKS_DIR}`);
  }

  // Generate and write each hook script
  for (const eventType of ALL_HOOK_EVENTS) {
    await installHookScript(eventType);
  }

  logger.info(`Installed ${ALL_HOOK_EVENTS.length} hook scripts to ${HOOKS_DIR}`);
}

/**
 * Install a single hook script
 */
export async function installHookScript(eventType: ExtendedHookEventType): Promise<string> {
  const fileName = eventType.replace(/([A-Z])/g, '-$1').toLowerCase().slice(1) + '.js';
  const filePath = path.join(HOOKS_DIR, fileName);

  const content = generateHookScript(eventType);
  await fs.writeFile(filePath, content, { encoding: 'utf-8', mode: 0o755 });

  logger.debug(`Installed hook script: ${filePath}`);
  return filePath;
}

/**
 * Get the path to a hook script
 */
export function getHookScriptPath(eventType: ExtendedHookEventType): string {
  const fileName = eventType.replace(/([A-Z])/g, '-$1').toLowerCase().slice(1) + '.js';
  return path.join(HOOKS_DIR, fileName);
}

/**
 * Check if all hook scripts are installed
 */
export async function areHookScriptsInstalled(): Promise<boolean> {
  // First check if the hooks directory exists at all
  if (!existsSync(HOOKS_DIR)) {
    logger.debug(`Hooks directory does not exist: ${HOOKS_DIR}`);
    return false;
  }

  for (const eventType of ALL_HOOK_EVENTS) {
    const filePath = getHookScriptPath(eventType);
    if (!existsSync(filePath)) {
      logger.debug(`Hook script missing: ${filePath}`);
      return false;
    }
  }
  return true;
}

/**
 * Get the list of installed hook scripts
 */
export async function getInstalledHookScripts(): Promise<string[]> {
  if (!existsSync(HOOKS_DIR)) {
    return [];
  }

  const files = await fs.readdir(HOOKS_DIR);
  return files.filter(f => f.endsWith('.js')).map(f => path.join(HOOKS_DIR, f));
}

/**
 * Remove all hook scripts
 */
export async function removeAllHookScripts(): Promise<void> {
  if (!existsSync(HOOKS_DIR)) {
    return;
  }

  const files = await getInstalledHookScripts();
  for (const file of files) {
    await fs.unlink(file);
  }

  logger.info('Removed all hook scripts');
}

// ============================================================================
// CLAUDE SETTINGS INTEGRATION
// ============================================================================

/**
 * Generate Claude settings.json hook configuration for all events
 */
export function generateClaudeHooksConfig(): Record<string, Array<{
  matcher: string;
  hooks: Array<{ type: 'command'; command: string; timeout?: number }>;
}>> {
  const config: Record<string, Array<{
    matcher: string;
    hooks: Array<{ type: 'command'; command: string; timeout?: number }>;
  }>> = {};

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
export function getHookConfigForEvent(eventType: ExtendedHookEventType): {
  matcher: string;
  hooks: Array<{ type: 'command'; command: string; timeout?: number }>;
} {
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
// CLAUDE SETTINGS INTEGRATION
// ============================================================================

/**
 * Path to Claude's user-level settings.json
 */
export const CLAUDE_SETTINGS_DIR = path.join(os.homedir(), '.claude');
export const CLAUDE_SETTINGS_PATH = path.join(CLAUDE_SETTINGS_DIR, 'settings.json');

/**
 * Configure Claude's settings.json to use GoodVibes hooks
 * This is the critical step that tells Claude to actually run the hook scripts
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
      } catch {
        logger.warn('Failed to parse existing Claude settings.json, starting fresh');
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
        // Keep hooks that don't contain our scripts path
        const isGoodVibesHook = hook?.hooks?.some?.((h: { command?: string }) =>
          h?.command?.includes?.('.goodvibes/hooks/') ||
          h?.command?.includes?.('.goodvibes\\hooks\\')
        );
        return !isGoodVibesHook;
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
        const isGoodVibesHook = hook?.hooks?.some?.((h: { command?: string }) =>
          h?.command?.includes?.('.goodvibes/hooks/') ||
          h?.command?.includes?.('.goodvibes\\hooks\\')
        );
        return !isGoodVibesHook;
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
    const hasGoodVibesHook = sessionStartHooks.some((hook: ClaudeHookEntry) =>
      hook?.hooks?.some?.((h: { command?: string }) =>
        h?.command?.includes?.('.goodvibes/hooks/') ||
        h?.command?.includes?.('.goodvibes\\hooks\\')
      )
    );

    return hasGoodVibesHook;
  } catch (error) {
    logger.debug('Failed to check Claude hooks configuration:', error);
    return false;
  }
}

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Validate that a hook script is correctly formatted
 */
export async function validateHookScript(filePath: string): Promise<{
  valid: boolean;
  error?: string;
}> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');

    // Check for required elements
    if (!content.includes('#!/usr/bin/env node')) {
      return { valid: false, error: 'Missing shebang' };
    }

    if (!content.includes('process.stdin')) {
      return { valid: false, error: 'Missing stdin handling' };
    }

    if (!content.includes('postToGoodVibes')) {
      return { valid: false, error: 'Missing GoodVibes communication' };
    }

    if (!content.includes('process.exit')) {
      return { valid: false, error: 'Missing exit code handling' };
    }

    return { valid: true };
  } catch (error) {
    const err = error as Error;
    return { valid: false, error: err.message };
  }
}

/**
 * Validate all installed hook scripts
 */
export async function validateAllHookScripts(): Promise<{
  valid: boolean;
  results: Record<string, { valid: boolean; error?: string }>;
}> {
  const results: Record<string, { valid: boolean; error?: string }> = {};
  let allValid = true;

  for (const eventType of ALL_HOOK_EVENTS) {
    const filePath = getHookScriptPath(eventType);

    if (!existsSync(filePath)) {
      results[eventType] = { valid: false, error: 'Script not installed' };
      allValid = false;
      continue;
    }

    const result = await validateHookScript(filePath);
    results[eventType] = result;

    if (!result.valid) {
      allValid = false;
    }
  }

  return { valid: allValid, results };
}
