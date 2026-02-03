// ============================================================================
// COLLECTION SCHEMAS
// ============================================================================

import { z } from 'zod';
import { numericIdSchema, hexColorSchema, sessionIdSchema } from './primitives.js';

/**
 * Collection creation schema
 */
export const createCollectionSchema = z.object({
  name: z.string().min(1).max(100),
  color: hexColorSchema.optional(),
  icon: z.string().max(10).optional(),
});

/**
 * Collection update schema
 */
export const updateCollectionSchema = z.object({
  id: numericIdSchema,
  name: z.string().min(1).max(100),
  color: hexColorSchema,
  icon: z.string().max(10),
});

/**
 * Session-collection association schema
 */
export const sessionCollectionSchema = z.object({
  sessionId: sessionIdSchema,
  collectionId: numericIdSchema,
});

/**
 * Smart collection rule schema
 */
export const smartCollectionRuleSchema = z.object({
  field: z.enum(['projectName', 'messageCount', 'tokenCount', 'cost', 'customTitle', 'tags']),
  operator: z.enum(['contains', 'equals', 'startsWith', 'endsWith', 'greaterThan', 'lessThan', 'hasTag']),
  value: z.union([z.string(), z.number()]),
});

/**
 * Smart collection creation schema
 */
export const createSmartCollectionSchema = z.object({
  name: z.string().min(1).max(100),
  rules: z.array(smartCollectionRuleSchema).min(1),
  color: hexColorSchema.optional(),
  icon: z.string().max(10).optional(),
  matchMode: z.enum(['all', 'any']).optional(),
});
