// ============================================================================
// KNOWLEDGE SCHEMAS
// ============================================================================

import { z } from 'zod';
import { numericIdSchema } from './primitives.js';

/**
 * Knowledge entry creation schema
 */
export const createKnowledgeEntrySchema = z.object({
  title: z.string().min(1).max(500),
  content: z.string().min(1).max(100000),
  category: z.string().max(100).optional(),
  tags: z.string().max(500).optional(),
});

/**
 * Knowledge entry update schema
 */
export const updateKnowledgeEntrySchema = z.object({
  id: numericIdSchema,
  title: z.string().min(1).max(500),
  content: z.string().min(1).max(100000),
  category: z.string().max(100).optional(),
  tags: z.string().max(500).optional(),
});
