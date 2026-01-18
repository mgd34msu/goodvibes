// ============================================================================
// SEARCH SCHEMAS
// ============================================================================

import { z } from 'zod';

/**
 * Search query schema
 */
export const searchQuerySchema = z.string().max(1000);

/**
 * Advanced search options schema
 */
export const advancedSearchOptionsSchema = z.object({
  query: z.string().max(1000).optional(),
  projectName: z.string().max(500).optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  minTokens: z.number().int().nonnegative().optional(),
  maxTokens: z.number().int().nonnegative().optional(),
  minCost: z.number().nonnegative().optional(),
  maxCost: z.number().nonnegative().optional(),
  tags: z.array(z.string()).optional(),
  sortBy: z.enum(['date', 'tokens', 'cost', 'messages']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  limit: z.number().int().positive().max(1000).optional(),
  offset: z.number().int().nonnegative().optional(),
});

/**
 * Save search schema
 */
export const saveSearchSchema = z.object({
  name: z.string().min(1).max(200),
  query: z.string().max(1000),
  filters: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Knowledge search term schema
 */
export const knowledgeSearchTermSchema = z.string()
  .max(500, 'Search term too long')
  .transform((val) => val.trim());
