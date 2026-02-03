// ============================================================================
// PRIMITIVE SCHEMAS - Base validation schemas
// ============================================================================

import { z } from 'zod';
import * as path from 'path';

// ============================================================================
// PATH TRAVERSAL PREVENTION
// ============================================================================

/**
 * Dangerous path patterns that could indicate path traversal or other attacks.
 * These patterns are checked in addition to the path normalization check.
 */
const DANGEROUS_PATH_PATTERNS = [
  /\.\.[/\\]/, // Parent directory traversal (..\, ../)
  /[/\\]\.\.($|[/\\])/, // Embedded parent directory
  /^\.\.($|[/\\])/, // Starts with parent directory
  /%2e%2e/i, // URL-encoded ..
  /%252e%252e/i, // Double URL-encoded ..
  /%c0%ae/i, // Overlong UTF-8 encoded .
  /\0/, // Null byte injection
  /^[/\\]$/, // Root directory only (Unix/Windows)
];

/**
 * Validates that a path does not contain path traversal sequences.
 * Uses multiple layers of protection:
 * 1. Pattern matching for known dangerous sequences
 * 2. Path normalization comparison to detect sneaky traversal
 */
function isPathSafe(inputPath: string): boolean {
  // Check for dangerous patterns
  for (const pattern of DANGEROUS_PATH_PATTERNS) {
    if (pattern.test(inputPath)) {
      return false;
    }
  }

  // Normalize the path and compare - if normalization changes the path
  // in a way that affects parent directory access, it's suspicious
  try {
    const normalized = path.normalize(inputPath);
    // After normalization, if we still have '..' components, reject
    if (normalized.includes('..')) {
      return false;
    }
    // Check if normalization reveals hidden traversal
    // e.g., "foo/../../../bar" normalizes to "../../bar" which is dangerous
    if (normalized.startsWith('..')) {
      return false;
    }
  } catch {
    // If normalization fails, the path is invalid
    return false;
  }

  return true;
}

/**
 * Creates a detailed error message for path validation failures
 */
function getPathValidationError(inputPath: string): string {
  if (inputPath.includes('..')) {
    return 'Path traversal sequences (..) are not allowed';
  }
  if (/%2e|%c0/i.test(inputPath)) {
    return 'URL-encoded path traversal sequences are not allowed';
  }
  if (inputPath.includes('\0')) {
    return 'Null bytes are not allowed in paths';
  }
  return 'Invalid path format';
}

// ============================================================================
// SESSION ID SCHEMAS
// ============================================================================

/**
 * Session ID schema - validates UUID or agent-* format
 */
export const sessionIdSchema = z.string()
  .min(1, 'Session ID is required')
  .max(100, 'Session ID too long')
  .refine(
    (val) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val) ||
             /^agent-[a-z0-9]+$/i.test(val),
    { message: 'Invalid session ID format' }
  );

// ============================================================================
// NUMERIC SCHEMAS
// ============================================================================

/**
 * Numeric ID schema - positive integer
 */
export const numericIdSchema = z.number()
  .int('ID must be an integer')
  .positive('ID must be positive');

/**
 * Pagination limit schema - positive integer with reasonable max
 * Use .default(N) when importing to set a context-specific default
 */
export const paginationLimitSchema = z.number()
  .int('Limit must be an integer')
  .positive('Limit must be positive')
  .max(1000, 'Limit cannot exceed 1000')
  .optional();

// ============================================================================
// FILE PATH SCHEMAS
// ============================================================================

/**
 * File path schema - validates against path traversal attacks.
 *
 * Security measures:
 * - Checks for direct '..' sequences
 * - Checks for URL-encoded traversal attempts
 * - Checks for null byte injection
 * - Validates path normalization doesn't reveal hidden traversal
 * - Limits path length to prevent buffer overflow attacks
 */
export const filePathSchema = z.string()
  .min(1, 'Path is required')
  .max(1000, 'Path too long')
  .refine(
    (val) => isPathSafe(val),
    (val) => ({ message: getPathValidationError(val) })
  );

/**
 * Optional file path schema
 */
export const optionalFilePathSchema = filePathSchema.optional();

/**
 * Project/working directory path schema.
 * More permissive than filePathSchema as it allows absolute paths,
 * but still validates against path traversal.
 */
export const projectPathSchema = z.string()
  .min(1, 'Project path is required')
  .max(1000, 'Project path too long')
  .refine(
    (val) => isPathSafe(val),
    (val) => ({ message: getPathValidationError(val) })
  );

/**
 * Optional project path schema
 */
export const optionalProjectPathSchema = projectPathSchema.optional();

/**
 * Relative file path schema - must not be absolute.
 * Used for file operations within a known directory.
 */
export const relativeFilePathSchema = z.string()
  .min(1, 'File path is required')
  .max(500, 'File path too long')
  .refine(
    (val) => {
      // Check for Unix absolute paths
      if (path.isAbsolute(val)) return false;
      // Check for Windows absolute paths (works cross-platform)
      if (/^[a-zA-Z]:[/\\]/.test(val)) return false;
      // Check for UNC paths
      if (/^\\\\/.test(val)) return false;
      return true;
    },
    { message: 'Path must be relative' }
  )
  .refine(
    (val) => isPathSafe(val),
    (val) => ({ message: getPathValidationError(val) })
  );

/**
 * Array of file paths schema
 */
export const filePathArraySchema = z.array(filePathSchema)
  .max(100, 'Too many files');

/**
 * Array of relative file paths schema
 */
export const relativeFilePathArraySchema = z.array(relativeFilePathSchema)
  .max(100, 'Too many files');

// ============================================================================
// FILENAME SCHEMAS
// ============================================================================

/**
 * Safe filename pattern - no path separators or dangerous characters
 */
const SAFE_FILENAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Filename schema - validates a safe filename (no path components)
 */
export const filenameSchema = z.string()
  .min(1, 'Filename is required')
  .max(255, 'Filename too long')
  .refine(
    (val) => SAFE_FILENAME_PATTERN.test(val),
    { message: 'Invalid filename format' }
  )
  .refine(
    (val) => !val.includes('/') && !val.includes('\\'),
    { message: 'Filename cannot contain path separators' }
  );

// ============================================================================
// COLOR SCHEMAS
// ============================================================================

/**
 * Hex color schema
 */
export const hexColorSchema = z.string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Invalid hex color format');

// ============================================================================
// EXPORT UTILITY FUNCTIONS
// ============================================================================

/**
 * Utility function to check if a path is safe (exported for use in other modules)
 */
export { isPathSafe, getPathValidationError };
