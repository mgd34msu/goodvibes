// ============================================================================
// HOOK SCRIPTS - Validation
// ============================================================================
//
// This module provides validation utilities for hook scripts to ensure
// they are correctly formatted and functional.
//
// ============================================================================

import fs from 'fs/promises';
import { existsSync } from 'fs';
import { ALL_HOOK_EVENTS } from './types.js';
import type { HookScriptValidationResult, AllHookScriptsValidationResult } from './types.js';
import { getHookScriptPath } from './installation.js';

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Validate that a hook script is correctly formatted
 */
export async function validateHookScript(filePath: string): Promise<HookScriptValidationResult> {
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
export async function validateAllHookScripts(): Promise<AllHookScriptsValidationResult> {
  const results: Record<string, HookScriptValidationResult> = {};
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
