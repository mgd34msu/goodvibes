// ============================================================================
// PROJECT CONFIG SCHEMAS - Zod validation for project config IPC handlers
// ============================================================================

import { z } from 'zod';
import { filePathSchema } from './primitives.js';

// ============================================================================
// PROJECT PATH VALIDATION
// ============================================================================

/**
 * Project path schema - validates file system paths
 * Ensures paths are reasonable length and don't contain traversal attacks
 */
export const projectPathSchema = filePathSchema.refine(
  (val) => val.length >= 1 && val.length <= 1000,
  { message: 'Project path must be between 1 and 1000 characters' }
);

// ============================================================================
// PROJECT CONFIG INPUT SCHEMAS
// ============================================================================

/**
 * Input schema for get-project-config and get-project-config-by-path handlers
 */
export const getProjectConfigInputSchema = projectPathSchema;

/**
 * Input schema for delete-project-config handler
 */
export const deleteProjectConfigInputSchema = projectPathSchema;

/**
 * Schema for partial project settings - allows any JSON-serializable value
 */
export const projectSettingsSchema = z.record(z.string(), z.unknown());

/**
 * Schema for hook reference - just the hook IDs for a project
 */
export const hookConfigReferenceSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1).max(200),
  eventType: z.enum([
    'PreToolUse',
    'PostToolUse',
    'SessionStart',
    'SessionEnd',
    'Notification',
    'Stop',
  ]),
  matcher: z.string().max(500).nullable(),
  command: z.string().min(1).max(4000),
  timeout: z.number().int().positive().max(300000), // Max 5 minutes
  enabled: z.boolean(),
  scope: z.enum(['user', 'project']),
  projectPath: z.string().max(1000).nullable(),
  executionCount: z.number().int().nonnegative(),
  lastExecuted: z.string().nullable(),
  lastResult: z.enum(['success', 'failure', 'timeout']).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  hookType: z.enum(['command', 'prompt']),
  prompt: z.string().max(10000).nullable(),
});

/**
 * Input schema for create-project-config handler
 */
export const createProjectConfigInputSchema = z.object({
  projectPath: projectPathSchema,
  defaultTemplateId: z.string().max(100).nullable().optional(),
  settings: projectSettingsSchema.optional().default({}),
  hooks: z.array(hookConfigReferenceSchema).optional().default([]),
  mcpServers: z.array(z.string().max(100)).optional().default([]),
  claudeMdOverride: z.string().max(100000).nullable().optional(),
});

/**
 * Input schema for update-project-config handler
 */
export const updateProjectConfigInputSchema = z.object({
  projectPath: projectPathSchema,
  updates: z.object({
    defaultTemplateId: z.string().max(100).nullable().optional(),
    settings: projectSettingsSchema.optional(),
    hooks: z.array(hookConfigReferenceSchema).optional(),
    mcpServers: z.array(z.string().max(100)).optional(),
    claudeMdOverride: z.string().max(100000).nullable().optional(),
  }),
});

// ============================================================================
// TYPE EXPORTS
// ============================================================================

export type ProjectPath = z.infer<typeof projectPathSchema>;
export type CreateProjectConfigInput = z.infer<typeof createProjectConfigInputSchema>;
export type UpdateProjectConfigInput = z.infer<typeof updateProjectConfigInputSchema>;
