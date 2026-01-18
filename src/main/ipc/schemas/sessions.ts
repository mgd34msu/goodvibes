// ============================================================================
// SESSION SCHEMAS
// ============================================================================

import { z } from 'zod';
import { sessionIdSchema, projectPathSchema as baseProjectPathSchema } from './primitives.js';

// Re-export sessionIdSchema for convenience
export { sessionIdSchema };

/**
 * Pagination limit schema - positive integer with reasonable max
 */
export const paginationLimitSchema = z.number()
  .int('Limit must be an integer')
  .positive('Limit must be positive')
  .max(1000, 'Limit cannot exceed 1000')
  .optional()
  .default(50);

/**
 * Project path schema - re-export from primitives with path traversal protection
 */
export const projectPathSchema = baseProjectPathSchema;

/**
 * Session search query schema
 */
export const sessionSearchQuerySchema = z.string()
  .min(1, 'Search query is required')
  .max(500, 'Search query too long');

/**
 * Schema for session:getForProject handler
 */
export const getSessionsForProjectSchema = z.object({
  projectPath: projectPathSchema,
  limit: paginationLimitSchema,
});

/**
 * Schema for session:search handler
 */
export const sessionSearchSchema = z.object({
  query: sessionSearchQuerySchema,
  projectPath: projectPathSchema.optional(),
  limit: paginationLimitSchema,
});

/**
 * Schema for session:getRecent handler
 */
export const getRecentSessionsSchema = z.object({
  limit: paginationLimitSchema,
}).optional();

// Type exports for use in handlers
export type GetSessionsForProjectInput = z.infer<typeof getSessionsForProjectSchema>;
export type SessionSearchInput = z.infer<typeof sessionSearchSchema>;
export type GetRecentSessionsInput = z.infer<typeof getRecentSessionsSchema>;
