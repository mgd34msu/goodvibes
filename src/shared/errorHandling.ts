// ============================================================================
// ERROR HANDLING UTILITIES - Consistent error handling across the app
// ============================================================================
//
// This module provides standardized error handling patterns to ensure
// consistent error messages, logging, and user feedback throughout the app.
// ============================================================================

import { formatTimestamp } from './dateUtils.js';

// ============================================================================
// ERROR TYPES
// ============================================================================

/**
 * Base application error with additional context
 */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>,
    public readonly originalError?: Error
  ) {
    super(message);
    this.name = 'AppError';
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      context: this.context,
      stack: this.stack,
    };
  }
}

/**
 * Network-related errors (API calls, IPC, etc.)
 */
export class NetworkError extends AppError {
  constructor(
    message: string,
    public readonly statusCode?: number,
    context?: Record<string, unknown>,
    originalError?: Error
  ) {
    super(message, 'NETWORK_ERROR', context, originalError);
    this.name = 'NetworkError';
  }
}

/**
 * Validation errors for user input
 */
export class ValidationError extends AppError {
  constructor(
    message: string,
    public readonly field?: string,
    public readonly invalidValue?: unknown,
    context?: Record<string, unknown>
  ) {
    super(message, 'VALIDATION_ERROR', { ...context, field, invalidValue });
    this.name = 'ValidationError';
  }
}

/**
 * Database/storage errors
 */
export class StorageError extends AppError {
  constructor(
    message: string,
    public readonly operation: string,
    context?: Record<string, unknown>,
    originalError?: Error
  ) {
    super(message, 'STORAGE_ERROR', { ...context, operation }, originalError);
    this.name = 'StorageError';
  }
}

/**
 * Git operation errors
 */
export class GitError extends AppError {
  constructor(
    message: string,
    public readonly gitCommand: string,
    public readonly stderr?: string,
    context?: Record<string, unknown>,
    originalError?: Error
  ) {
    super(message, 'GIT_ERROR', { ...context, gitCommand, stderr }, originalError);
    this.name = 'GitError';
  }
}

/**
 * IPC communication errors
 */
export class IPCError extends AppError {
  constructor(
    message: string,
    public readonly channel: string,
    context?: Record<string, unknown>,
    originalError?: Error
  ) {
    super(message, 'IPC_ERROR', { ...context, channel }, originalError);
    this.name = 'IPCError';
  }
}

/**
 * Terminal/PTY errors
 */
export class TerminalError extends AppError {
  constructor(
    message: string,
    public readonly terminalId: number,
    context?: Record<string, unknown>,
    originalError?: Error
  ) {
    super(message, 'TERMINAL_ERROR', { ...context, terminalId }, originalError);
    this.name = 'TerminalError';
  }
}

// ============================================================================
// ERROR CLASSIFICATION
// ============================================================================

/**
 * Classify an unknown error into a known error type
 */
export function classifyError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase();

    // Network errors
    if (
      message.includes('network') ||
      message.includes('fetch') ||
      message.includes('econnrefused') ||
      message.includes('etimedout') ||
      message.includes('socket')
    ) {
      return new NetworkError(error.message, undefined, undefined, error);
    }

    // Git errors
    if (
      message.includes('git') ||
      message.includes('repository') ||
      message.includes('commit') ||
      message.includes('branch')
    ) {
      return new GitError(error.message, 'unknown', undefined, undefined, error);
    }

    // Database errors
    if (
      message.includes('sqlite') ||
      message.includes('database') ||
      message.includes('constraint')
    ) {
      return new StorageError(error.message, 'unknown', undefined, error);
    }

    // IPC errors
    if (message.includes('ipc') || message.includes('electron')) {
      return new IPCError(error.message, 'unknown', undefined, error);
    }

    // Generic application error
    return new AppError(error.message, 'UNKNOWN_ERROR', undefined, error);
  }

  // Non-Error thrown
  return new AppError(String(error), 'UNKNOWN_ERROR');
}

// ============================================================================
// ERROR FORMATTING
// ============================================================================

/**
 * Format error for display to users (sanitized, user-friendly)
 */
export function formatUserError(error: unknown): string {
  const appError = classifyError(error);

  // User-friendly messages for known error types
  switch (appError.code) {
    case 'NETWORK_ERROR':
      return 'Unable to connect. Please check your internet connection and try again.';
    case 'VALIDATION_ERROR':
      return appError.message;
    case 'STORAGE_ERROR':
      return 'Failed to save data. Please try again.';
    case 'GIT_ERROR':
      return `Git operation failed: ${appError.message}`;
    case 'IPC_ERROR':
      return 'Communication error. Please restart the application.';
    case 'TERMINAL_ERROR':
      return 'Terminal error. Please try closing and reopening the terminal.';
    default:
      return 'An unexpected error occurred. Please try again.';
  }
}

/**
 * Format error for logging (detailed, includes stack traces)
 */
export function formatLogError(error: unknown): string {
  const appError = classifyError(error);

  const parts: string[] = [
    `[${appError.code}] ${appError.name}: ${appError.message}`,
  ];

  if (appError.context) {
    parts.push(`Context: ${JSON.stringify(appError.context, null, 2)}`);
  }

  if (appError.stack) {
    parts.push(`Stack: ${appError.stack}`);
  }

  if (appError.originalError?.stack) {
    parts.push(`Original Stack: ${appError.originalError.stack}`);
  }

  return parts.join('\n');
}

// ============================================================================
// ERROR HANDLING UTILITIES
// ============================================================================

/**
 * Result type for operations that can fail
 */
export type Result<T, E = AppError> =
  | { success: true; value: T }
  | { success: false; error: E };

/**
 * Create a success result
 */
export function ok<T>(value: T): Result<T, never> {
  return { success: true, value };
}

/**
 * Create a failure result
 */
export function err<E>(error: E): Result<never, E> {
  return { success: false, error };
}

/**
 * Wrap an async function to return a Result instead of throwing
 */
export async function tryAsync<T>(
  fn: () => Promise<T>,
  errorTransform?: (error: unknown) => AppError
): Promise<Result<T>> {
  try {
    const value = await fn();
    return ok(value);
  } catch (error) {
    const appError = errorTransform ? errorTransform(error) : classifyError(error);
    return err(appError);
  }
}

/**
 * Wrap a sync function to return a Result instead of throwing
 */
export function trySync<T>(
  fn: () => T,
  errorTransform?: (error: unknown) => AppError
): Result<T> {
  try {
    const value = fn();
    return ok(value);
  } catch (error) {
    const appError = errorTransform ? errorTransform(error) : classifyError(error);
    return err(appError);
  }
}

// ============================================================================
// ERROR LOGGING
// ============================================================================

/**
 * Log levels
 */
export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
}

/**
 * Error logger interface
 */
export interface ErrorLogger {
  log(level: LogLevel, message: string, context?: Record<string, unknown>): void;
  error(error: unknown, context?: Record<string, unknown>): void;
}

/**
 * Console-based error logger
 */
export const consoleLogger: ErrorLogger = {
  log(level: LogLevel, message: string, context?: Record<string, unknown>) {
    const timestamp = formatTimestamp();
    const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;

    switch (level) {
      case LogLevel.DEBUG:
        console.debug(logMessage, context);
        break;
      case LogLevel.INFO:
        console.info(logMessage, context);
        break;
      case LogLevel.WARN:
        console.warn(logMessage, context);
        break;
      case LogLevel.ERROR:
        console.error(logMessage, context);
        break;
    }
  },

  error(error: unknown, context?: Record<string, unknown>) {
    const appError = classifyError(error);
    this.log(LogLevel.ERROR, formatLogError(error), {
      ...context,
      errorCode: appError.code,
      errorName: appError.name,
    });
  },
};

// ============================================================================
// ERROR BOUNDARY HELPERS
// ============================================================================

/**
 * Extract error info for error boundaries
 */
export interface ErrorBoundaryInfo {
  message: string;
  code: string;
  recoverable: boolean;
  suggestedAction: string;
}

/**
 * Get error boundary display info
 */
export function getErrorBoundaryInfo(error: unknown): ErrorBoundaryInfo {
  const appError = classifyError(error);

  const defaultInfo: ErrorBoundaryInfo = {
    message: formatUserError(error),
    code: appError.code,
    recoverable: true,
    suggestedAction: 'Try refreshing the page or restarting the application.',
  };

  switch (appError.code) {
    case 'NETWORK_ERROR':
      return {
        ...defaultInfo,
        suggestedAction: 'Check your internet connection and try again.',
      };
    case 'VALIDATION_ERROR':
      return {
        ...defaultInfo,
        suggestedAction: 'Please correct the input and try again.',
      };
    case 'STORAGE_ERROR':
      return {
        ...defaultInfo,
        recoverable: false,
        suggestedAction: 'Restart the application. If the problem persists, check disk space.',
      };
    case 'GIT_ERROR':
      return {
        ...defaultInfo,
        suggestedAction: 'Check your Git configuration and try again.',
      };
    case 'IPC_ERROR':
      return {
        ...defaultInfo,
        recoverable: false,
        suggestedAction: 'Restart the application.',
      };
    case 'TERMINAL_ERROR':
      return {
        ...defaultInfo,
        suggestedAction: 'Close and reopen the terminal tab.',
      };
    default:
      return defaultInfo;
  }
}

// ============================================================================
// ASSERTION HELPERS
// ============================================================================

/**
 * Assert that a condition is true, throw if not
 */
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new AppError(message, 'ASSERTION_ERROR');
  }
}

/**
 * Assert that a value is defined (not null or undefined)
 */
export function assertDefined<T>(
  value: T | null | undefined,
  message: string = 'Value is null or undefined'
): T {
  if (value === null || value === undefined) {
    throw new AppError(message, 'ASSERTION_ERROR');
  }
  return value;
}

/**
 * Assert that a value is never reached (exhaustiveness check)
 */
export function assertNever(value: never, message?: string): never {
  throw new AppError(
    message || `Unexpected value: ${JSON.stringify(value)}`,
    'ASSERTION_ERROR'
  );
}
