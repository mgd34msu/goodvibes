// ============================================================================
// HOOKS SERVICE - Hook Execution Logic
// ============================================================================

import { spawn, ChildProcess } from 'child_process';
import { Logger } from '../logger.js';
import { DEFAULT_HOOK_TIMEOUT_MS } from '../../../shared/constants.js';
import { recordHookExecution } from '../../database/primitives.js';
import { validateHookCommand, validatePath, logSecurityEvent } from '../inputSanitizer.js';
import type { HookConfig } from './types.js';
import type { HookExecutionContext, HookExecutionResult } from './types.js';

const logger = new Logger('HookExecution');

// ============================================================================
// INPUT SANITIZATION - Security against injection via environment variables
// ============================================================================

/**
 * Sanitize a string value for use in environment variables.
 * Removes or escapes characters that could be used for injection attacks.
 *
 * Note: Environment variables passed to child processes are inherently safe
 * from command injection (they're data, not commands). However, hooks may
 * use these values in shell expansions or pass them to other commands,
 * so we sanitize to be defense-in-depth.
 */
function sanitizeEnvValue(value: string | undefined, maxLength: number = 65536): string {
  if (value === undefined || value === null) {
    return '';
  }

  // Convert to string if necessary
  let sanitized = String(value);

  // Truncate to prevent denial of service via huge values
  if (sanitized.length > maxLength) {
    sanitized = sanitized.slice(0, maxLength);
    logger.warn('Environment value truncated due to length', { originalLength: value.length, maxLength });
  }

  // Remove null bytes which can cause issues in C-based programs
  sanitized = sanitized.replace(/\0/g, '');

  return sanitized;
}

/**
 * Sanitize JSON data for environment variable use.
 * Ensures the JSON is valid and doesn't exceed size limits.
 */
function sanitizeJsonEnvValue(data: unknown, maxLength: number = 65536): string {
  if (data === undefined || data === null) {
    return '';
  }

  try {
    const json = JSON.stringify(data);
    if (json.length > maxLength) {
      logger.warn('JSON environment value truncated', { originalLength: json.length, maxLength });
      // For truncated JSON, return empty to avoid invalid JSON
      return '{}';
    }
    return json;
  } catch (error) {
    logger.warn('Failed to serialize JSON for environment variable', error);
    return '';
  }
}

/**
 * Manages hook execution lifecycle including process spawning,
 * timeout handling, and result collection.
 */
export class HookExecutor {
  private runningProcesses: Map<number, ChildProcess> = new Map();
  private readonly DEFAULT_TIMEOUT_MS = DEFAULT_HOOK_TIMEOUT_MS;

  /**
   * Execute all matching hooks for a given event context
   */
  async executeHooks(
    hooks: HookConfig[],
    context: HookExecutionContext,
    onExecuted?: (result: HookExecutionResult) => void
  ): Promise<HookExecutionResult[]> {
    const results: HookExecutionResult[] = [];

    for (const hook of hooks) {
      if (!this.matchesContext(hook, context)) {
        continue;
      }

      const result = await this.executeHook(hook, context);
      results.push(result);

      // Record execution in database
      recordHookExecution(
        hook.id,
        result.success ? 'success' : (result.exitCode === null ? 'timeout' : 'failure')
      );

      if (onExecuted) {
        onExecuted(result);
      }

      // If hook returned exit code 2, it wants to block the action
      if (result.shouldBlock) {
        logger.info(`Hook ${hook.name} requested to block action`);
        break;
      }
    }

    return results;
  }

  /**
   * Execute a single hook and return the result
   */
  async executeHook(hook: HookConfig, context: HookExecutionContext): Promise<HookExecutionResult> {
    const startTime = Date.now();

    logger.debug(`Executing hook: ${hook.name}`, { eventType: hook.eventType });

    // Validate hook command before execution
    const commandValidation = validateHookCommand(hook.command);
    if (!commandValidation.valid) {
      logger.error(`Hook command validation failed: ${hook.name}`, {
        error: commandValidation.error,
      });
      logSecurityEvent('hook-execution', hook.command, [], commandValidation.error || 'Invalid hook command');
      return {
        hookId: hook.id,
        hookName: hook.name,
        success: false,
        exitCode: null,
        stdout: '',
        stderr: `[Security: ${commandValidation.error}]`,
        durationMs: Date.now() - startTime,
        shouldBlock: false,
      };
    }

    // Validate cwd path if provided
    const cwdPath = context.projectPath || process.cwd();
    const cwdValidation = validatePath(cwdPath);
    if (!cwdValidation.valid) {
      logger.error(`Hook cwd validation failed: ${hook.name}`, {
        error: cwdValidation.error,
        cwd: cwdPath,
      });
      logSecurityEvent('hook-execution', hook.command, [cwdPath], cwdValidation.error || 'Invalid cwd path');
      return {
        hookId: hook.id,
        hookName: hook.name,
        success: false,
        exitCode: null,
        stdout: '',
        stderr: `[Security: Invalid working directory]`,
        durationMs: Date.now() - startTime,
        shouldBlock: false,
      };
    }

    return new Promise((resolve) => {
      const timeout = hook.timeout || this.DEFAULT_TIMEOUT_MS;
      let stdout = '';
      let stderr = '';
      let resolved = false;

      // Prepare environment with sanitized values to prevent injection
      // Even though env vars are data (not commands), hooks may use them
      // in shell expansions, so we sanitize as defense-in-depth
      const env = {
        ...process.env,
        GOODVIBES_HOOK_EVENT: sanitizeEnvValue(context.eventType),
        GOODVIBES_HOOK_TOOL: sanitizeEnvValue(context.toolName),
        GOODVIBES_HOOK_INPUT: sanitizeJsonEnvValue(context.toolInput),
        GOODVIBES_HOOK_RESULT: sanitizeEnvValue(context.toolResult),
        GOODVIBES_SESSION_ID: sanitizeEnvValue(context.sessionId),
        GOODVIBES_PROJECT_PATH: sanitizeEnvValue(context.projectPath),
        GOODVIBES_TIMESTAMP: sanitizeEnvValue(context.timestamp.toString()),
      };

      // Spawn the command - use validated/sanitized command
      const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
      const shellFlag = process.platform === 'win32' ? '/c' : '-c';
      const safeCommand = commandValidation.sanitized || hook.command;

      const child = spawn(shell, [shellFlag, safeCommand], {
        env,
        cwd: cwdValidation.sanitized || cwdPath,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.runningProcesses.set(hook.id, child);

      // Set up timeout
      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          child.kill('SIGKILL');
          this.runningProcesses.delete(hook.id);

          resolve({
            hookId: hook.id,
            hookName: hook.name,
            success: false,
            exitCode: null,
            stdout,
            stderr: stderr + '\n[Hook timed out]',
            durationMs: Date.now() - startTime,
            shouldBlock: false,
          });
        }
      }, timeout);

      // Collect stdout
      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      // Collect stderr
      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      // Handle completion
      child.on('close', (exitCode) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          this.runningProcesses.delete(hook.id);

          resolve({
            hookId: hook.id,
            hookName: hook.name,
            success: exitCode === 0,
            exitCode,
            stdout,
            stderr,
            durationMs: Date.now() - startTime,
            shouldBlock: exitCode === 2, // Exit code 2 means block the action
          });
        }
      });

      // Handle errors
      child.on('error', (error) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          this.runningProcesses.delete(hook.id);

          resolve({
            hookId: hook.id,
            hookName: hook.name,
            success: false,
            exitCode: null,
            stdout,
            stderr: stderr + `\n[Error: ${error.message}]`,
            durationMs: Date.now() - startTime,
            shouldBlock: false,
          });
        }
      });
    });
  }

  /**
   * Check if a hook matches the execution context
   */
  matchesContext(hook: HookConfig, context: HookExecutionContext): boolean {
    if (!hook.matcher || hook.matcher === '*') {
      return true;
    }

    // For tool events, match against tool name
    if (context.toolName) {
      const pattern = hook.matcher;

      // Handle patterns like "Bash(*)" or "Edit(src/*)"
      const match = pattern.match(/^(\w+)\((.*)\)$/);
      if (match) {
        const [, toolPattern, argPattern] = match;

        // Check tool name
        if (toolPattern !== '*' && toolPattern !== context.toolName) {
          return false;
        }

        // Check argument pattern (simplified glob matching)
        if (argPattern !== '*' && context.toolInput) {
          const inputStr = JSON.stringify(context.toolInput);
          
          // Protect against ReDoS by validating pattern
          if (argPattern.length > 200) {
            logger.warn('Hook pattern too long, rejecting', { pattern: argPattern });
            return false;
          }
          
          const wildcardCount = (argPattern.match(/\*/g) || []).length;
          if (wildcardCount > 10) {
            logger.warn('Hook pattern has too many wildcards, rejecting', { pattern: argPattern });
            return false;
          }
          
          // Escape regex special characters before replacing wildcards
          const escapedPattern = argPattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
          const regex = new RegExp(escapedPattern.replace(/\*/g, '.*'));
          return regex.test(inputStr);
        }

        return true;
      }

      // Simple tool name match
      return hook.matcher === context.toolName;
    }

    return true;
  }

  /**
   * Kill a running hook process by ID
   */
  killHook(hookId: number): boolean {
    const proc = this.runningProcesses.get(hookId);
    if (proc) {
      proc.kill('SIGKILL');
      this.runningProcesses.delete(hookId);
      logger.info(`Killed hook process: ${hookId}`);
      return true;
    }
    return false;
  }

  /**
   * Kill all running hook processes
   */
  killAllHooks(): void {
    for (const [hookId, proc] of this.runningProcesses) {
      proc.kill('SIGKILL');
      logger.debug(`Killed hook process: ${hookId}`);
    }
    this.runningProcesses.clear();
  }

  /**
   * Get the number of currently running hooks
   */
  getRunningCount(): number {
    return this.runningProcesses.size;
  }
}
