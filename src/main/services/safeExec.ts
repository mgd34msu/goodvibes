// ============================================================================
// SAFE COMMAND EXECUTION UTILITY
// ============================================================================
//
// This module provides secure command execution utilities that prevent
// shell injection attacks by:
// 1. Using array-form arguments (avoiding shell interpretation)
// 2. Validating command inputs
// 3. Providing explicit documentation for intentional shell usage
//
// SECURITY NOTES:
// - NEVER use shell: true unless absolutely required for shell features
// - ALWAYS validate user-provided inputs before passing to commands
// - Use the array-form spawn/exec methods from this module
// ============================================================================

import { spawn, spawnSync, SpawnSyncOptions, SpawnOptions, ChildProcess } from 'child_process';
import { Logger } from './logger.js';

const logger = new Logger('SafeExec');

// ============================================================================
// VALIDATION UTILITIES
// ============================================================================

/**
 * Allowed characters for command names (executable paths)
 * Allows alphanumeric, dash, underscore, dot, forward/back slashes, spaces (for Windows paths)
 */
const SAFE_COMMAND_PATTERN = /^[a-zA-Z0-9_\-./\\ :]+$/;

/**
 * Dangerous patterns that should never appear in command arguments
 */
const DANGEROUS_PATTERNS = [
  /\$\(/,      // Command substitution $(...)
  /`/,         // Backtick command substitution
  /\$\{/,      // Variable expansion ${...}
  /[|;&]/,     // Pipe, command separator, background
  /\n/,        // Newline (command injection)
  /\r/,        // Carriage return
  />\s*[|&]/,  // Redirect to pipe/background
  /<\s*[|&]/,  // Input redirect from pipe
];

/**
 * Validate a command name (executable path)
 */
export function validateCommand(command: string): { valid: boolean; error?: string } {
  if (!command || typeof command !== 'string') {
    return { valid: false, error: 'Command must be a non-empty string' };
  }

  if (!SAFE_COMMAND_PATTERN.test(command)) {
    return { valid: false, error: `Invalid characters in command: ${command}` };
  }

  // Check for path traversal attacks
  if (command.includes('..')) {
    return { valid: false, error: 'Path traversal not allowed in command' };
  }

  return { valid: true };
}

/**
 * Validate command arguments for dangerous patterns
 */
export function validateArguments(args: string[]): { valid: boolean; error?: string } {
  if (!Array.isArray(args)) {
    return { valid: false, error: 'Arguments must be an array' };
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (typeof arg !== 'string') {
      return { valid: false, error: `Argument ${i} must be a string` };
    }

    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(arg)) {
        return {
          valid: false,
          error: `Potentially dangerous pattern in argument ${i}: ${arg.substring(0, 50)}`
        };
      }
    }
  }

  return { valid: true };
}

/**
 * Sanitize a string for safe use in command arguments
 * Removes or escapes dangerous characters
 */
export function sanitizeArgument(arg: string): string {
  if (typeof arg !== 'string') {
    return '';
  }

  // Remove dangerous characters
  return arg
    .replace(/[\n\r]/g, ' ')  // Replace newlines with spaces
    .replace(/[`$]/g, '')      // Remove backticks and dollar signs
    .replace(/[|;&]/g, '')     // Remove pipe, semicolon, ampersand
    .trim();
}

// ============================================================================
// SAFE EXECUTION FUNCTIONS
// ============================================================================

export interface SafeExecResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
}

export interface SafeExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  encoding?: BufferEncoding;
  /**
   * Skip argument validation. Use only when you have already validated inputs
   * or when the arguments come from a trusted source (e.g., hardcoded values).
   */
  skipValidation?: boolean;
}

/**
 * Execute a command synchronously with array-form arguments (safe)
 *
 * @param command - The executable to run
 * @param args - Array of arguments (NOT a single string with spaces)
 * @param options - Execution options
 * @returns Execution result
 */
export function safeExecSync(
  command: string,
  args: string[],
  options?: SafeExecOptions
): SafeExecResult {
  // Validate command
  const cmdValidation = validateCommand(command);
  if (!cmdValidation.valid) {
    logger.warn(`Rejected invalid command: ${command}`);
    return {
      success: false,
      stdout: '',
      stderr: '',
      exitCode: null,
      error: cmdValidation.error,
    };
  }

  // Validate arguments unless skipped
  if (!options?.skipValidation) {
    const argsValidation = validateArguments(args);
    if (!argsValidation.valid) {
      logger.warn(`Rejected invalid arguments for ${command}`);
      return {
        success: false,
        stdout: '',
        stderr: '',
        exitCode: null,
        error: argsValidation.error,
      };
    }
  }

  try {
    const spawnOptions: SpawnSyncOptions = {
      cwd: options?.cwd,
      env: options?.env,
      timeout: options?.timeout,
      encoding: options?.encoding || 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      // SECURITY: Never use shell: true
      shell: false,
      windowsHide: true,
    };

    const result = spawnSync(command, args, spawnOptions);

    return {
      success: result.status === 0,
      stdout: result.stdout?.toString() || '',
      stderr: result.stderr?.toString() || '',
      exitCode: result.status,
      error: result.error?.message,
    };
  } catch (error) {
    logger.error(`Command execution failed: ${command}`, error);
    return {
      success: false,
      stdout: '',
      stderr: '',
      exitCode: null,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Execute a command asynchronously with array-form arguments (safe)
 *
 * @param command - The executable to run
 * @param args - Array of arguments (NOT a single string with spaces)
 * @param options - Execution options
 * @returns Promise resolving to execution result
 */
export function safeExecAsync(
  command: string,
  args: string[],
  options?: SafeExecOptions
): Promise<SafeExecResult> {
  return new Promise((resolve) => {
    // Validate command
    const cmdValidation = validateCommand(command);
    if (!cmdValidation.valid) {
      logger.warn(`Rejected invalid command: ${command}`);
      resolve({
        success: false,
        stdout: '',
        stderr: '',
        exitCode: null,
        error: cmdValidation.error,
      });
      return;
    }

    // Validate arguments unless skipped
    if (!options?.skipValidation) {
      const argsValidation = validateArguments(args);
      if (!argsValidation.valid) {
        logger.warn(`Rejected invalid arguments for ${command}`);
        resolve({
          success: false,
          stdout: '',
          stderr: '',
          exitCode: null,
          error: argsValidation.error,
        });
        return;
      }
    }

    try {
      const spawnOptions: SpawnOptions = {
        cwd: options?.cwd,
        env: options?.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // SECURITY: Never use shell: true
        shell: false,
        windowsHide: true,
      };

      const child = spawn(command, args, spawnOptions);

      let stdout = '';
      let stderr = '';
      let timeoutId: NodeJS.Timeout | null = null;

      if (options?.timeout) {
        timeoutId = setTimeout(() => {
          child.kill('SIGTERM');
          resolve({
            success: false,
            stdout,
            stderr,
            exitCode: null,
            error: `Command timed out after ${options.timeout}ms`,
          });
        }, options.timeout);
      }

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        if (timeoutId) clearTimeout(timeoutId);
        resolve({
          success: code === 0,
          stdout,
          stderr,
          exitCode: code,
        });
      });

      child.on('error', (error) => {
        if (timeoutId) clearTimeout(timeoutId);
        resolve({
          success: false,
          stdout,
          stderr,
          exitCode: null,
          error: error.message,
        });
      });
    } catch (error) {
      logger.error(`Command execution failed: ${command}`, error);
      resolve({
        success: false,
        stdout: '',
        stderr: '',
        exitCode: null,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });
}

/**
 * Spawn a command asynchronously with array-form arguments (safe)
 * Returns the child process for streaming output
 *
 * @param command - The executable to run
 * @param args - Array of arguments (NOT a single string with spaces)
 * @param options - Execution options
 * @returns Child process or null if validation fails
 */
export function safeSpawn(
  command: string,
  args: string[],
  options?: SafeExecOptions & SpawnOptions
): ChildProcess | null {
  // Validate command
  const cmdValidation = validateCommand(command);
  if (!cmdValidation.valid) {
    logger.warn(`Rejected invalid command: ${command}`);
    return null;
  }

  // Validate arguments unless skipped
  if (!options?.skipValidation) {
    const argsValidation = validateArguments(args);
    if (!argsValidation.valid) {
      logger.warn(`Rejected invalid arguments for ${command}`);
      return null;
    }
  }

  const spawnOptions: SpawnOptions = {
    cwd: options?.cwd,
    env: options?.env,
    stdio: options?.stdio || ['pipe', 'pipe', 'pipe'],
    // SECURITY: Never use shell: true
    shell: false,
    windowsHide: true,
  };

  return spawn(command, args, spawnOptions);
}

// ============================================================================
// PLATFORM-SPECIFIC UTILITIES
// ============================================================================

/**
 * Check if a command exists on the system
 * Uses 'where' on Windows, 'which' on Unix
 *
 * @param command - The command name to check
 * @returns true if the command exists and is executable
 */
export function commandExists(command: string): boolean {
  // Validate the command name first
  const validation = validateCommand(command);
  if (!validation.valid) {
    return false;
  }

  const isWindows = process.platform === 'win32';
  const checkCommand = isWindows ? 'where' : 'which';

  const result = safeExecSync(checkCommand, [command], { skipValidation: true });
  return result.success;
}

/**
 * Get the full path to a command
 *
 * @param command - The command name to look up
 * @returns The full path or null if not found
 */
export function getCommandPath(command: string): string | null {
  // Validate the command name first
  const validation = validateCommand(command);
  if (!validation.valid) {
    return null;
  }

  const isWindows = process.platform === 'win32';
  const checkCommand = isWindows ? 'where' : 'which';

  const result = safeExecSync(checkCommand, [command], { skipValidation: true });
  if (result.success && result.stdout) {
    // 'where' on Windows may return multiple paths, take the first one
    return result.stdout.split('\n')[0].trim();
  }

  return null;
}

// ============================================================================
// INTENTIONAL SHELL EXECUTION (DOCUMENTED)
// ============================================================================

/**
 * Execute a command with shell interpretation.
 *
 * SECURITY WARNING: This function intentionally uses shell: true.
 * Only use this when you need shell features (pipes, redirects, globbing)
 * and when the command is NOT derived from user input.
 *
 * @param shellCommand - The shell command to execute (will be interpreted by shell)
 * @param options - Execution options
 * @returns Execution result
 *
 * @example
 * // This is safe - hardcoded command
 * shellExecSync('echo $HOME | grep user');
 *
 * // THIS IS DANGEROUS - user input
 * shellExecSync(`cat ${userInput}`); // DON'T DO THIS!
 */
export function shellExecSync(
  shellCommand: string,
  options?: Omit<SafeExecOptions, 'skipValidation'>
): SafeExecResult {
  // Log intentional shell usage for audit
  logger.debug(`Intentional shell execution: ${shellCommand.substring(0, 100)}`);

  const isWindows = process.platform === 'win32';
  const shell = isWindows ? 'cmd.exe' : '/bin/sh';
  const shellArg = isWindows ? '/c' : '-c';

  try {
    const result = spawnSync(shell, [shellArg, shellCommand], {
      cwd: options?.cwd,
      env: options?.env,
      timeout: options?.timeout,
      encoding: options?.encoding || 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    return {
      success: result.status === 0,
      stdout: result.stdout?.toString() || '',
      stderr: result.stderr?.toString() || '',
      exitCode: result.status,
      error: result.error?.message,
    };
  } catch (error) {
    logger.error(`Shell command execution failed`, error);
    return {
      success: false,
      stdout: '',
      stderr: '',
      exitCode: null,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
