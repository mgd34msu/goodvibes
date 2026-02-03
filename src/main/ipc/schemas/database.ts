// ============================================================================
// DATABASE SCHEMAS - Validation schemas for database IPC handlers
// ============================================================================
//
// Provides Zod schemas for validating inputs to database IPC operations
// including activity logs, analytics, and other database operations.
// ============================================================================

import { z } from 'zod';
import { sessionIdSchema } from './primitives.js';

// ============================================================================
// ACTIVITY LOG SCHEMAS
// ============================================================================

/**
 * Activity type schema - defines allowed activity types
 */
export const activityTypeSchema = z.string()
  .min(1, 'Activity type is required')
  .max(100, 'Activity type too long')
  .regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/, 'Invalid activity type format');

/**
 * Activity description schema
 */
export const activityDescriptionSchema = z.string()
  .min(1, 'Description is required')
  .max(5000, 'Description too long');

/**
 * Activity metadata schema - allows structured JSON data
 */
export const activityMetadataSchema = z.record(z.string(), z.unknown()).optional();

/**
 * Log activity input schema
 * Note: This is re-exported from export.ts as logActivitySchema for backward compatibility.
 * Use this schema for database activity logging operations.
 */
export const logActivityInputSchema = z.object({
  type: activityTypeSchema,
  sessionId: sessionIdSchema.nullable(),
  description: activityDescriptionSchema,
  metadata: activityMetadataSchema,
});

/**
 * Get recent activity limit schema
 */
export const recentActivityLimitSchema = z.number()
  .int('Limit must be an integer')
  .positive('Limit must be positive')
  .max(1000, 'Limit cannot exceed 1000')
  .optional();

// ============================================================================
// NOTES STATUS SCHEMA
// ============================================================================

/**
 * Quick note status schema for fetching notes
 */
export const quickNoteStatusQuerySchema = z.enum(['active', 'completed', 'archived', 'all']);

// ============================================================================
// SEARCH TERM SCHEMA
// ============================================================================

/**
 * Search term schema - validates search queries to prevent injection
 */
export const searchTermSchema = z.string()
  .max(500, 'Search term too long')
  .transform((val) => val.trim());

// ============================================================================
// TYPE EXPORTS
// ============================================================================

export type LogActivityInput = z.infer<typeof logActivityInputSchema>;
export type ActivityType = z.infer<typeof activityTypeSchema>;
export type QuickNoteStatusQuery = z.infer<typeof quickNoteStatusQuerySchema>;

// ============================================================================
// RE-EXPORTS FOR CONVENIENCE
// ============================================================================
// Re-export related schemas that are used for database operations

export { numericIdSchema, sessionIdSchema } from './primitives.js';
export { createCollectionSchema, updateCollectionSchema, sessionCollectionSchema, createSmartCollectionSchema } from './collections.js';
export { createTagSchema, sessionTagSchema } from './tags.js';
export { savePromptSchema } from './prompts.js';
export { createQuickNoteSchema, updateQuickNoteSchema, setQuickNoteStatusSchema } from './notes.js';
export { getNotificationsSchema } from './notifications.js';
export { createKnowledgeEntrySchema, updateKnowledgeEntrySchema } from './knowledge.js';
export { searchQuerySchema, advancedSearchOptionsSchema, saveSearchSchema } from './search.js';
