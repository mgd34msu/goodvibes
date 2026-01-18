// ============================================================================
// SESSION SCHEMAS
// ============================================================================

import { z } from 'zod';
import { sessionIdSchema, projectPathSchema as baseProjectPathSchema, paginationLimitSchema as basePaginationLimitSchema } from './primitives.js';

// Re-export sessionIdSchema for convenience
export { sessionIdSchema };

/**
 * Session-specific pagination limit with default of 50
 * Note: For agency handlers, use paginationLimitSchema from primitives directly
 */
export const sessionPaginationLimitSchema = basePaginationLimitSchema.default(50);

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
  limit: sessionPaginationLimitSchema,
});

/**
 * Schema for session:search handler
 */
export const sessionSearchSchema = z.object({
  query: sessionSearchQuerySchema,
  projectPath: projectPathSchema.optional(),
  limit: sessionPaginationLimitSchema,
});

/**
 * Schema for session:getRecent handler
 */
export const getRecentSessionsSchema = z.object({
  limit: sessionPaginationLimitSchema,
}).optional();

// Type exports for use in handlers
export type GetSessionsForProjectInput = z.infer<typeof getSessionsForProjectSchema>;
export type SessionSearchInput = z.infer<typeof sessionSearchSchema>;
export type GetRecentSessionsInput = z.infer<typeof getRecentSessionsSchema>;
