// ============================================================================
// AGENCY SCHEMAS - Zod validation for agency IPC handlers
// ============================================================================

import { z } from 'zod';
import { numericIdSchema, sessionIdSchema, filePathSchema } from './primitives.js';

// ============================================================================
// BASIC TYPES
// ============================================================================

/**
 * Agent/Skill type discriminator
 */
export const entityTypeSchema = z.enum(['agent', 'skill']);

/**
 * Slug schema - URL-friendly identifier
 */
export const slugSchema = z.string()
  .min(1, 'Slug is required')
  .max(200, 'Slug too long')
  .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens');

/**
 * Category path schema - hierarchical category identifier
 */
export const categoryPathSchema = z.string()
  .min(1, 'Category path is required')
  .max(500, 'Category path too long');

/**
 * Search query schema
 */
export const searchQuerySchema = z.string()
  .min(1, 'Search query is required')
  .max(500, 'Search query too long');

/**
 * Pagination limit schema
 */
export const paginationLimitSchema = z.number()
  .int('Limit must be an integer')
  .positive('Limit must be positive')
  .max(1000, 'Limit too large')
  .optional();

/**
 * Priority schema for agent/skill ordering
 */
export const prioritySchema = z.number()
  .int('Priority must be an integer')
  .min(0, 'Priority cannot be negative')
  .max(1000, 'Priority too large')
  .optional();

// ============================================================================
// INITIALIZATION SCHEMAS
// ============================================================================

/**
 * Agency index initialization schema
 */
export const agencyInitConfigSchema = z.object({
  agencyPath: filePathSchema,
});

// ============================================================================
// AGENT OPERATION SCHEMAS
// ============================================================================

/**
 * Search agents schema
 */
export const searchAgentsSchema = z.object({
  query: searchQuerySchema,
  limit: paginationLimitSchema,
});

/**
 * Activate agent schema
 */
export const activateAgentSchema = z.object({
  agentId: numericIdSchema,
  sessionId: sessionIdSchema.optional(),
  projectPath: filePathSchema.optional(),
  priority: prioritySchema,
});

/**
 * Deactivate agent schema
 */
export const deactivateAgentSchema = z.object({
  agentId: numericIdSchema,
  sessionId: sessionIdSchema.optional(),
  projectPath: filePathSchema.optional(),
});

// ============================================================================
// SKILL OPERATION SCHEMAS
// ============================================================================

/**
 * Search skills schema
 */
export const searchSkillsSchema = z.object({
  query: searchQuerySchema,
  limit: paginationLimitSchema,
});

/**
 * Queue skill schema
 */
export const queueSkillSchema = z.object({
  skillId: numericIdSchema,
  sessionId: sessionIdSchema.optional(),
  projectPath: filePathSchema.optional(),
  priority: prioritySchema,
});

/**
 * Clear skill queue schema
 */
export const clearSkillQueueSchema = z.object({
  sessionId: sessionIdSchema.optional(),
  projectPath: filePathSchema.optional(),
});

// ============================================================================
// CONTEXT INJECTION SCHEMAS
// ============================================================================

/**
 * Context injection schema
 */
export const contextInjectionSchema = z.object({
  sessionId: sessionIdSchema,
  projectPath: filePathSchema,
  workingDirectory: filePathSchema,
});

/**
 * Working directory schema - for read/clear operations
 */
export const workingDirectorySchema = filePathSchema;

// ============================================================================
// TYPE EXPORTS
// ============================================================================

export type EntityType = z.infer<typeof entityTypeSchema>;
export type AgencyInitConfig = z.infer<typeof agencyInitConfigSchema>;
export type SearchAgentsInput = z.infer<typeof searchAgentsSchema>;
export type ActivateAgentInput = z.infer<typeof activateAgentSchema>;
export type DeactivateAgentInput = z.infer<typeof deactivateAgentSchema>;
export type SearchSkillsInput = z.infer<typeof searchSkillsSchema>;
export type QueueSkillInput = z.infer<typeof queueSkillSchema>;
export type ClearSkillQueueInput = z.infer<typeof clearSkillQueueSchema>;
export type ContextInjectionInput = z.infer<typeof contextInjectionSchema>;
