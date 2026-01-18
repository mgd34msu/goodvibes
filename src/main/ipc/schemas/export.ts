// ============================================================================
// EXPORT SCHEMAS
// ============================================================================

import { z } from 'zod';
import { sessionIdSchema, filePathSchema } from './primitives.js';

/**
 * Export session schema
 */
export const exportSessionSchema = z.object({
  sessionId: sessionIdSchema,
  format: z.enum(['markdown', 'json', 'html']),
});

/**
 * Bulk export schema
 */
export const bulkExportSchema = z.array(sessionIdSchema);

/**
 * Add recent project schema
 */
export const addRecentProjectSchema = z.object({
  path: filePathSchema,
  name: z.string().max(200).optional(),
});

/**
 * Log activity schema
 */
export const logActivitySchema = z.object({
  type: z.string().min(1).max(100),
  sessionId: sessionIdSchema.nullable(),
  description: z.string().min(1).max(5000),
  metadata: z.unknown().optional(),
});

/**
 * Activity limit schema
 */
export const activityLimitSchema = z.number().int().positive().max(1000).optional();
