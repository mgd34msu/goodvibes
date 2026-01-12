// ============================================================================
// HOOKS SCHEMAS
// ============================================================================

import { z } from 'zod';
import { numericIdSchema } from './primitives.js';

/**
 * Hook event type schema
 */
export const hookEventTypeSchema = z.enum([
  'session_start',
  'session_end',
  'commit_before',
  'commit_after',
  'push_before',
  'push_after',
  'pull_before',
  'pull_after',
  'branch_checkout',
  'file_change',
]);

/**
 * Hook creation schema
 */
export const createHookSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  eventType: hookEventTypeSchema,
  script: z.string().min(1).max(100000),
  enabled: z.boolean(),
  async: z.boolean().optional(),
  timeout: z.number().int().positive().max(300000).optional(), // 5 min max
  projectPath: z.string().max(1000).optional(),
});

/**
 * Hook update schema
 */
export const updateHookSchema = z.object({
  id: numericIdSchema,
  updates: createHookSchema.partial(),
});

/**
 * Get hooks by event schema
 */
export const getHooksByEventSchema = z.object({
  eventType: hookEventTypeSchema,
  projectPath: z.string().max(1000).optional(),
});
