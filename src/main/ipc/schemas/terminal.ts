// ============================================================================
// TERMINAL SCHEMAS
// ============================================================================

import { z } from 'zod';
import { filePathSchema, sessionIdSchema } from './primitives.js';

/**
 * Terminal start options schema
 */
export const terminalStartOptionsSchema = z.object({
  cwd: filePathSchema.optional(),
  name: z.string().max(200).optional(),
  resumeSessionId: sessionIdSchema.optional(),
  sessionType: z.enum(['user', 'subagent']).optional(),
});

/**
 * Terminal input schema
 */
export const terminalInputSchema = z.object({
  id: z.number().int().nonnegative(),
  data: z.string(),
});

/**
 * Terminal resize schema
 */
export const terminalResizeSchema = z.object({
  id: z.number().int().nonnegative(),
  cols: z.number().int().positive().max(500),
  rows: z.number().int().positive().max(200),
});
