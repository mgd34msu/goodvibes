// ============================================================================
// FEATURE INSTALLATION SCHEMAS
// ============================================================================

import { z } from 'zod';
import { filePathSchema } from './primitives.js';
import { extendedHookEventTypeSchema } from './hooks.js';

/**
 * Feature type - corresponds to .claude directory structure
 */
export const featureTypeSchema = z.enum(['agents', 'skills', 'commands', 'hooks']);

/**
 * Feature scope - determines where the file is written
 */
export const featureScopeSchema = z.enum(['user', 'project']);

/**
 * Base feature installation schema
 */
const baseInstallSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200, 'Name too long'),
  content: z.string().min(1, 'Content is required').max(500000, 'Content too long'),
  scope: featureScopeSchema,
  projectPath: z.string().max(1000, 'Project path too long').optional(),
});

/**
 * Agent installation schema
 */
export const installAgentSchema = baseInstallSchema;

/**
 * Skill installation schema
 */
export const installSkillSchema = baseInstallSchema;

/**
 * Command installation schema
 */
export const installCommandSchema = baseInstallSchema;

/**
 * Hook installation schema - includes additional hook-specific fields
 */
export const installHookSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200, 'Name too long'),
  script: z.string().min(1, 'Script content is required').max(100000, 'Script too long'),
  eventType: extendedHookEventTypeSchema,
  matcher: z.string().max(500, 'Matcher too long').optional(),
  scope: featureScopeSchema,
  projectPath: z.string().max(1000, 'Project path too long').optional(),
});

/**
 * Base uninstall schema
 */
const baseUninstallSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200, 'Name too long'),
  scope: featureScopeSchema,
  projectPath: z.string().max(1000, 'Project path too long').optional(),
});

/**
 * Agent uninstall schema
 */
export const uninstallAgentSchema = baseUninstallSchema;

/**
 * Skill uninstall schema
 */
export const uninstallSkillSchema = baseUninstallSchema;

/**
 * Command uninstall schema
 */
export const uninstallCommandSchema = baseUninstallSchema;

/**
 * Hook uninstall schema - includes eventType to identify hook in settings.json
 */
export const uninstallHookSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200, 'Name too long'),
  eventType: extendedHookEventTypeSchema,
  scope: featureScopeSchema,
  projectPath: z.string().max(1000, 'Project path too long').optional(),
});

/**
 * Type exports
 */
export type InstallAgentInput = z.infer<typeof installAgentSchema>;
export type InstallSkillInput = z.infer<typeof installSkillSchema>;
export type InstallCommandInput = z.infer<typeof installCommandSchema>;
export type InstallHookInput = z.infer<typeof installHookSchema>;

export type UninstallAgentInput = z.infer<typeof uninstallAgentSchema>;
export type UninstallSkillInput = z.infer<typeof uninstallSkillSchema>;
export type UninstallCommandInput = z.infer<typeof uninstallCommandSchema>;
export type UninstallHookInput = z.infer<typeof uninstallHookSchema>;
