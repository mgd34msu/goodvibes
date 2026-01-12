// ============================================================================
// TAG SCHEMAS
// ============================================================================

import { z } from 'zod';
import { numericIdSchema, hexColorSchema, sessionIdSchema } from './primitives.js';

/**
 * Tag creation schema
 */
export const createTagSchema = z.object({
  name: z.string().min(1).max(50),
  color: hexColorSchema,
});

/**
 * Session-tag association schema
 */
export const sessionTagSchema = z.object({
  sessionId: sessionIdSchema,
  tagId: numericIdSchema,
});
