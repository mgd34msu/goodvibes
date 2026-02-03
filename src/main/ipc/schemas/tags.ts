// ============================================================================
// TAG SYSTEM SCHEMAS - Zod validation schemas for tag IPC handlers
// ============================================================================

import { z } from 'zod';
import { numericIdSchema, hexColorSchema, sessionIdSchema } from './primitives.js';



// ============================================================================
// TAG ENUMS
// ============================================================================

/**
 * Tag visual effect types
 */
export const tagEffectSchema = z.enum(['shimmer', 'glow', 'pulse']);

/**
 * Tag source - how the tag was applied to a session
 */
export const tagSourceSchema = z.enum(['user', 'ai', 'bulk', 'template']);

/**
 * Suggestion category types for AI-suggested tags
 */
export const suggestionCategorySchema = z.enum([
  'task_type',
  'technology',
  'domain',
  'complexity',
  'outcome',
  'pattern',
]);

/**
 * Suggestion status for tracking AI suggestions
 */
export const suggestionStatusSchema = z.enum(['pending', 'accepted', 'rejected', 'dismissed']);

/**
 * Tag scan status for background scanning operations
 */
export const scanStatusSchema = z.enum(['pending', 'queued', 'scanning', 'completed', 'skipped', 'failed']);

// ============================================================================
// TAG CRUD SCHEMAS
// ============================================================================

/**
 * Create tag input schema
 */
export const createTagSchema = z.object({
  name: z.string().min(1, 'Tag name is required').max(50, 'Tag name too long'),
  color: hexColorSchema.optional(),
  effect: tagEffectSchema.optional(),
  parentId: numericIdSchema.optional(),
  description: z.string().max(200, 'Description too long').optional(),
});

/**
 * Update tag input schema
 */
export const updateTagSchema = z.object({
  name: z.string().min(1, 'Tag name is required').max(50, 'Tag name too long').optional(),
  color: hexColorSchema.nullable().optional(),
  effect: tagEffectSchema.nullable().optional(),
  parentId: numericIdSchema.nullable().optional(),
  description: z.string().max(200, 'Description too long').nullable().optional(),
});

/**
 * Merge tags input schema - combines two tags into one
 */
export const mergeTagsSchema = z.object({
  sourceId: numericIdSchema,
  targetId: numericIdSchema,
}).refine(
  (data) => data.sourceId !== data.targetId,
  { message: 'Source and target tags must be different' }
);

// ============================================================================
// SESSION-TAG ASSOCIATION SCHEMAS
// ============================================================================

/**
 * Session-tag association schema
 */
export const sessionTagSchema = z.object({
  sessionId: sessionIdSchema,
  tagId: numericIdSchema,
  source: tagSourceSchema.optional().default('user'),
});

/**
 * Bulk session-tag operation schema
 */
export const bulkSessionTagSchema = z.object({
  sessionIds: z.array(sessionIdSchema).min(1, 'At least one session ID is required'),
  tagId: numericIdSchema,
  source: tagSourceSchema.optional().default('bulk'),
});

// ============================================================================
// TAG FILTER SCHEMAS
// ============================================================================

/**
 * Recursive tag filter expression schema
 * Supports AND, OR, NOT, and individual tag filters
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const tagFilterExpressionSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    type: z.enum(['tag', 'and', 'or', 'not']),
    tagId: numericIdSchema.optional(),
    children: z.array(tagFilterExpressionSchema).optional(),
  }).refine((data) => {
    // Tag type must have tagId
    if (data.type === 'tag') {
      return data.tagId !== undefined;
    }
    // NOT type must have exactly one child
    if (data.type === 'not') {
      return data.children?.length === 1;
    }
    // AND/OR types must have at least 2 children
    if (data.type === 'and' || data.type === 'or') {
      return (data.children?.length ?? 0) >= 2;
    }
    return true;
  }, {
    message: 'Invalid filter expression structure',
  })
);

// ============================================================================
// TAG SUGGESTION SCHEMAS
// ============================================================================

/**
 * Accept suggestion input schema
 */
export const acceptSuggestionSchema = z.object({
  suggestionId: numericIdSchema,
  createIfNotExists: z.boolean().optional().default(true),
  tagColor: hexColorSchema.optional(),
});

/**
 * Scan settings schema for AI tag scanning
 */
export const scanSettingsSchema = z.object({
  sessionsPerHour: z.number().int('Sessions per hour must be an integer').min(1).max(1000).optional(),
  minSessionLength: z.number().int('Min session length must be an integer').min(1).optional(),
  scanDepth: z.enum(['quick', 'full']).optional(),
  autoAccept: z.boolean().optional(),
  autoAcceptThreshold: z.number().min(0, 'Threshold must be at least 0').max(1, 'Threshold must be at most 1').optional(),
});

// ============================================================================
// TAG TEMPLATE SCHEMAS
// ============================================================================

/**
 * Create tag template input schema
 */
export const createTagTemplateSchema = z.object({
  name: z.string().min(1, 'Template name is required').max(50, 'Template name too long'),
  description: z.string().max(200, 'Description too long').optional(),
  tagIds: z.array(numericIdSchema).min(1, 'At least one tag ID is required'),
});

/**
 * Update tag template input schema
 */
export const updateTagTemplateSchema = z.object({
  name: z.string().min(1, 'Template name is required').max(50, 'Template name too long').optional(),
  description: z.string().max(200, 'Description too long').nullable().optional(),
  tagIds: z.array(numericIdSchema).min(1, 'At least one tag ID is required').optional(),
});

// ============================================================================
// TYPE EXPORTS
// ============================================================================

/**
 * Type exports for use in handlers
 */
export type TagEffect = z.infer<typeof tagEffectSchema>;
export type TagSource = z.infer<typeof tagSourceSchema>;
export type SuggestionCategory = z.infer<typeof suggestionCategorySchema>;
export type SuggestionStatus = z.infer<typeof suggestionStatusSchema>;
export type ScanStatus = z.infer<typeof scanStatusSchema>;

export type CreateTagInput = z.infer<typeof createTagSchema>;
export type UpdateTagInput = z.infer<typeof updateTagSchema>;
export type MergeTagsInput = z.infer<typeof mergeTagsSchema>;
export type SessionTagInput = z.infer<typeof sessionTagSchema>;
export type BulkSessionTagInput = z.infer<typeof bulkSessionTagSchema>;
export type TagFilterExpression = z.infer<typeof tagFilterExpressionSchema>;
export type AcceptSuggestionInput = z.infer<typeof acceptSuggestionSchema>;
export type ScanSettingsInput = z.infer<typeof scanSettingsSchema>;
export type CreateTagTemplateInput = z.infer<typeof createTagTemplateSchema>;
export type UpdateTagTemplateInput = z.infer<typeof updateTagTemplateSchema>;
