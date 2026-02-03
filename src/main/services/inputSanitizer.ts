// ============================================================================
// INPUT SANITIZER - Security utilities for command execution
// ============================================================================
//
// This module provides input validation and sanitization utilities to prevent
// command injection vulnerabilities when executing shell commands or spawning
// processes.
//
// IMPORTANT: Always use these utilities before passing user input to:
// - child_process.spawn()
// - child_process.exec()
// - child_process.execSync()
// - Any shell command construction
//
// ============================================================================

import { Logger } from './logger.js';

const logger = new Logger('InputSanitizer');

// ============================================================================
// SHELL METACHARACTER PATTERNS
// ============================================================================

/**
 * Dangerous shell metacharacters that can lead to command injection.
 * These characters have special meaning in both Unix shells and Windows cmd.
 */
const SHELL_METACHARACTERS = /[;&|`$(){}[\]<>!\n\r\\'"]/;

/**
 * Extended pattern that also catches command substitution patterns
 */
const COMMAND_SUBSTITUTION_PATTERN = /\$\(|\$\{|`/;

/**
 * Windows-specific dangerous patterns
 * Note: This pattern is defined for future Windows-specific validation.
 * Currently, SHELL_METACHARACTERS covers most cases for cross-platform security.
 */
const _WINDOWS_DANGEROUS_PATTERNS = /[&|<>^%]/;

/**
 * Path traversal patterns
 */
const PATH_TRAVERSAL_PATTERN = /\.\.[/\\]/;

// ============================================================================
// VALIDATION RESULTS
// ============================================================================

export interface ValidationResult {
  valid: boolean;
  error?: string;
  sanitized?: string;
}

// ============================================================================
// COMMAND VALIDATION
// ============================================================================

/**
 * Validate a command name (executable name only, not arguments).
 * Only allows alphanumeric characters, dots, hyphens, and underscores.
 *
 * @param command - The command/executable name to validate
 * @returns ValidationResult with valid flag and optional error message
 */
export function validateCommandName(command: string): ValidationResult {
  if (!command || typeof command !== 'string') {
    return { valid: false, error: 'Command must be a non-empty string' };
  }

  // Trim whitespace
  const trimmed = command.trim();

  if (trimmed.length === 0) {
    return { valid: false, error: 'Command cannot be empty' };
  }

  // Check for path components (only allow simple command names or absolute paths)
  // Reject relative paths that could escape intended directories
  if (PATH_TRAVERSAL_PATTERN.test(trimmed)) {
    logger.warn('Command contains path traversal pattern', { command: trimmed });
    return { valid: false, error: 'Command contains path traversal characters' };
  }

  // Allow alphanumeric, dots, hyphens, underscores, and path separators for absolute paths
  // This allows commands like: "node", "npm.cmd", "/usr/bin/git", "C:\Program Files\node.exe"
  const validCommandPattern = /^[\w.\-/\\:]+$/;

  if (!validCommandPattern.test(trimmed)) {
    logger.warn('Command contains invalid characters', { command: trimmed });
    return { valid: false, error: 'Command contains invalid characters' };
  }

  return { valid: true, sanitized: trimmed };
}

/**
 * Validate a command argument.
 * Rejects arguments containing shell metacharacters that could lead to injection.
 *
 * @param arg - The argument to validate
 * @returns ValidationResult with valid flag and optional error message
 */
export function validateCommandArgument(arg: string): ValidationResult {
  if (arg === undefined || arg === null) {
    return { valid: false, error: 'Argument must be defined' };
  }

  const argStr = String(arg);

  // Check for shell metacharacters
  if (SHELL_METACHARACTERS.test(argStr)) {
    logger.warn('Argument contains shell metacharacters', { arg: argStr.substring(0, 50) });
    return { valid: false, error: 'Argument contains potentially dangerous characters' };
  }

  // Check for command substitution patterns
  if (COMMAND_SUBSTITUTION_PATTERN.test(argStr)) {
    logger.warn('Argument contains command substitution pattern', { arg: argStr.substring(0, 50) });
    return { valid: false, error: 'Argument contains command substitution pattern' };
  }

  return { valid: true, sanitized: argStr };
}

/**
 * Validate an array of command arguments.
 *
 * @param args - Array of arguments to validate
 * @returns ValidationResult with valid flag and optional error for first invalid arg
 */
export function validateCommandArguments(args: string[]): ValidationResult {
  if (!Array.isArray(args)) {
    return { valid: false, error: 'Arguments must be an array' };
  }

  for (let i = 0; i < args.length; i++) {
    const result = validateCommandArgument(args[i]);
    if (!result.valid) {
      return { valid: false, error: `Invalid argument at index ${i}: ${result.error}` };
    }
  }

  return { valid: true };
}

// ============================================================================
// SAFE COMMAND LISTS
// ============================================================================

/**
 * Allowlist of commands that are safe to execute for specific purposes.
 * This provides defense-in-depth by limiting what can be executed.
 */
export const ALLOWED_COMMANDS: Record<string, string[]> = {
  // Commands for checking if executables exist
  existence_check: ['where', 'which'],
  // Git operations
  git: ['git'],
  // Claude CLI
  claude: ['claude', 'claude.cmd', 'claude.exe'],
  // Node.js
  node: ['node', 'node.exe', 'npm', 'npm.cmd', 'npx', 'npx.cmd'],
  // Shells (for intentional shell execution like hooks)
  shells: ['cmd.exe', '/bin/sh', '/bin/bash', '/bin/zsh'],
};

/**
 * Check if a command is in the allowlist for a specific category.
 *
 * @param command - The command to check
 * @param category - The category of allowed commands
 * @returns true if allowed, false otherwise
 */
export function isAllowedCommand(command: string, category: keyof typeof ALLOWED_COMMANDS): boolean {
  const allowed = ALLOWED_COMMANDS[category];
  if (!allowed) {
    return false;
  }

  // Extract just the command name (without path) for comparison
  const commandName = command.split(/[/\\]/).pop()?.toLowerCase() || '';
  const fullCommandLower = command.toLowerCase();

  return allowed.some(cmd =>
    commandName === cmd.toLowerCase() ||
    fullCommandLower.endsWith(cmd.toLowerCase())
  );
}

// ============================================================================
// PATH VALIDATION
// ============================================================================

/**
 * Validate a file/directory path to prevent directory traversal attacks.
 *
 * @param pathStr - The path to validate
 * @param allowAbsolute - Whether to allow absolute paths (default: true)
 * @returns ValidationResult with valid flag and optional error message
 */
export function validatePath(pathStr: string, allowAbsolute = true): ValidationResult {
  if (!pathStr || typeof pathStr !== 'string') {
    return { valid: false, error: 'Path must be a non-empty string' };
  }

  const trimmed = pathStr.trim();

  // Check for null bytes (common injection technique)
  if (trimmed.includes('\0')) {
    logger.warn('Path contains null byte', { path: trimmed });
    return { valid: false, error: 'Path contains null byte' };
  }

  // Check for path traversal
  if (PATH_TRAVERSAL_PATTERN.test(trimmed)) {
    logger.warn('Path contains traversal pattern', { path: trimmed });
    return { valid: false, error: 'Path contains directory traversal' };
  }

  // Check if absolute path is allowed
  const isAbsolute = /^[/\\]|^[A-Za-z]:/.test(trimmed);
  if (isAbsolute && !allowAbsolute) {
    return { valid: false, error: 'Absolute paths are not allowed' };
  }

  return { valid: true, sanitized: trimmed };
}

// ============================================================================
// ENVIRONMENT VARIABLE VALIDATION
// ============================================================================

/**
 * Validate environment variable name.
 * Only allows alphanumeric characters and underscores.
 *
 * @param name - The environment variable name
 * @returns ValidationResult
 */
export function validateEnvVarName(name: string): ValidationResult {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: 'Environment variable name must be a non-empty string' };
  }

  // Environment variable names should be alphanumeric with underscores
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return { valid: false, error: 'Invalid environment variable name format' };
  }

  return { valid: true, sanitized: name };
}

/**
 * Validate environment variable value.
 * Rejects values that could lead to injection when used in shell contexts.
 *
 * @param value - The environment variable value
 * @returns ValidationResult
 */
export function validateEnvVarValue(value: string): ValidationResult {
  if (value === undefined || value === null) {
    return { valid: false, error: 'Environment variable value must be defined' };
  }

  const valueStr = String(value);

  // Check for command substitution that could be expanded
  if (COMMAND_SUBSTITUTION_PATTERN.test(valueStr)) {
    logger.warn('Environment variable value contains command substitution');
    return { valid: false, error: 'Value contains command substitution pattern' };
  }

  return { valid: true, sanitized: valueStr };
}

/**
 * Validate an entire environment object.
 *
 * @param env - Environment variable object
 * @returns ValidationResult with details about first invalid entry
 */
export function validateEnvironment(env: Record<string, string>): ValidationResult {
  if (!env || typeof env !== 'object') {
    return { valid: false, error: 'Environment must be an object' };
  }

  for (const [name, value] of Object.entries(env)) {
    const nameResult = validateEnvVarName(name);
    if (!nameResult.valid) {
      return { valid: false, error: `Invalid env var name '${name}': ${nameResult.error}` };
    }

    const valueResult = validateEnvVarValue(value);
    if (!valueResult.valid) {
      return { valid: false, error: `Invalid env var value for '${name}': ${valueResult.error}` };
    }
  }

  return { valid: true };
}

// ============================================================================
// HOOK COMMAND VALIDATION
// ============================================================================

/**
 * Validate a hook command string.
 * Hook commands are intentionally executed in a shell, but we still need
 * to prevent certain dangerous patterns.
 *
 * @param command - The hook command to validate
 * @returns ValidationResult
 */
export function validateHookCommand(command: string): ValidationResult {
  if (!command || typeof command !== 'string') {
    return { valid: false, error: 'Hook command must be a non-empty string' };
  }

  const trimmed = command.trim();

  if (trimmed.length === 0) {
    return { valid: false, error: 'Hook command cannot be empty' };
  }

  // Limit command length to prevent buffer overflow attacks
  if (trimmed.length > 4096) {
    return { valid: false, error: 'Hook command exceeds maximum length' };
  }

  // Check for null bytes
  if (trimmed.includes('\0')) {
    logger.warn('Hook command contains null byte');
    return { valid: false, error: 'Hook command contains null byte' };
  }

  // Prevent command substitution in a way that could escape the intended shell
  // Note: We allow $VAR and $(cmd) because hooks are intended to run shell commands
  // But we prevent certain escape sequences that could break out of quoting
  const dangerousEscapes = /\\x[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}|\\[0-7]{3}/;
  if (dangerousEscapes.test(trimmed)) {
    logger.warn('Hook command contains dangerous escape sequence');
    return { valid: false, error: 'Hook command contains dangerous escape sequence' };
  }

  return { valid: true, sanitized: trimmed };
}

// ============================================================================
// SANITIZATION UTILITIES
// ============================================================================

/**
 * Escape a string for safe use in a shell command.
 * Use this ONLY when you must construct a shell string (not recommended).
 * Prefer using array-form arguments with spawn() instead.
 *
 * @param str - The string to escape
 * @returns Escaped string safe for shell use
 */
export function escapeShellArg(str: string): string {
  if (process.platform === 'win32') {
    // Windows cmd.exe escaping
    // Wrap in double quotes and escape internal double quotes and percent signs
    return `"${str.replace(/(["%^])/g, '^$1')}"`;
  } else {
    // Unix shell escaping
    // Wrap in single quotes and escape any internal single quotes
    return `'${str.replace(/'/g, "'\\''")}'`;
  }
}

/**
 * Create a safe command checker function that validates against an allowlist.
 *
 * @param allowedCommands - Array of allowed command names
 * @returns Function that checks if a command is allowed
 */
export function createCommandChecker(allowedCommands: string[]): (cmd: string) => boolean {
  const allowedSet = new Set(allowedCommands.map(c => c.toLowerCase()));

  return (cmd: string): boolean => {
    const commandName = cmd.split(/[/\\]/).pop()?.toLowerCase() || '';
    return allowedSet.has(commandName) || allowedSet.has(cmd.toLowerCase());
  };
}

// ============================================================================
// LOGGING AND MONITORING
// ============================================================================

/**
 * Log a potentially dangerous command attempt for security monitoring.
 *
 * @param context - Context where the command was attempted
 * @param command - The command that was attempted
 * @param args - Arguments passed to the command
 * @param reason - Reason for blocking/flagging
 */
export function logSecurityEvent(
  context: string,
  command: string,
  args: string[],
  reason: string
): void {
  logger.warn('Security event: potential command injection attempt', {
    context,
    command: command.substring(0, 100),
    argCount: args.length,
    reason,
    timestamp: new Date().toISOString(),
  });
}
