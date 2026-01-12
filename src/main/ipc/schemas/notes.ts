// ============================================================================
// NOTES SCHEMAS
// ============================================================================

import { z } from 'zod';
import { numericIdSchema, sessionIdSchema } from './primitives.js';

/**
 * Quick note creation schema
 */
export const createQuickNoteSchema = z.object({
  content: z.string().min(1).max(10000),
  sessionId: sessionIdSchema.optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
});

/**
 * Quick note update schema
 */
export const updateQuickNoteSchema = z.object({
  id: numericIdSchema,
  content: z.string().min(1).max(10000),
});

/**
 * Quick note status schema
 */
export const setQuickNoteStatusSchema = z.object({
  id: numericIdSchema,
  status: z.enum(['active', 'completed', 'archived']),
});
