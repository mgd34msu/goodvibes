// ============================================================================
// PRIMITIVE SCHEMAS - Base validation schemas
// ============================================================================

import { z } from 'zod';

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

/**
 * Numeric ID schema - positive integer
 */
export const numericIdSchema = z.number()
  .int('ID must be an integer')
  .positive('ID must be positive');

/**
 * File path schema - validates against path traversal attacks
 */
export const filePathSchema = z.string()
  .min(1, 'Path is required')
  .max(1000, 'Path too long')
  .refine(
    (val) => !val.includes('..'),
    { message: 'Path traversal not allowed' }
  );

/**
 * Optional file path schema
 */
export const optionalFilePathSchema = filePathSchema.optional();

/**
 * Hex color schema
 */
export const hexColorSchema = z.string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Invalid hex color format');
