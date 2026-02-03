// ============================================================================
// HOOK SCRIPTS - Installation
// ============================================================================
//
// This module handles installing, removing, and querying hook scripts
// in the ~/.goodvibes/hooks/ directory.
//
// ============================================================================

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { Logger } from '../logger.js';
import { HOOKS_DIR, ALL_HOOK_EVENTS } from './types.js';
import type { ExtendedHookEventType } from './types.js';
import { generateHookScript, eventTypeToFileName } from './script-generator.js';

const logger = new Logger('HookScripts:Installation');

// ============================================================================
// PATH UTILITIES
// ============================================================================

/**
 * Get the path to a hook script
 */
export function getHookScriptPath(eventType: ExtendedHookEventType): string {
  const fileName = eventTypeToFileName(eventType) + '.js';
  return path.join(HOOKS_DIR, fileName);
}

// ============================================================================
// INSTALLATION
// ============================================================================

/**
 * Install a single hook script
 */
export async function installHookScript(eventType: ExtendedHookEventType): Promise<string> {
  const filePath = getHookScriptPath(eventType);

  const content = generateHookScript(eventType);
  await fs.writeFile(filePath, content, { encoding: 'utf-8', mode: 0o755 });

  logger.debug(`Installed hook script: ${filePath}`);
  return filePath;
}

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

// ============================================================================
// REMOVAL
// ============================================================================

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
// STATUS CHECKS
// ============================================================================

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
