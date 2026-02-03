// ============================================================================
// PLUGIN SCHEMAS
// ============================================================================
//
// Zod schemas for plugin management operations
// ============================================================================

import { z } from 'zod';
import { filePathSchema } from './primitives.js';

/**
 * Plugin scope - determines where the plugin is installed
 */
export const pluginScopeSchema = z.enum(['user', 'project']);

/**
 * Plugin category
 */
export const pluginCategorySchema = z.enum([
  'productivity',
  'devops',
  'communication',
  'ai',
  'custom'
]);

/**
 * Plugin ID schema - must be a non-empty string
 */
export const pluginIdSchema = z.string().min(1, 'Plugin ID is required').max(200, 'Plugin ID too long');

/**
 * Install plugin schema
 */
export const installPluginSchema = z.object({
  repository: z.string().min(1, 'Repository URL is required').max(1000, 'Repository URL too long'),
  scope: pluginScopeSchema,
  projectPath: filePathSchema.optional(),
});

/**
 * Uninstall plugin schema
 */
export const uninstallPluginSchema = z.object({
  pluginId: pluginIdSchema,
  scope: pluginScopeSchema,
  projectPath: filePathSchema.optional(),
});

/**
 * Enable/disable plugin schema
 */
export const enablePluginSchema = z.object({
  pluginId: pluginIdSchema,
  enabled: z.boolean(),
});

/**
 * Type exports
 */
export type InstallPluginInput = z.infer<typeof installPluginSchema>;
export type UninstallPluginInput = z.infer<typeof uninstallPluginSchema>;
export type EnablePluginInput = z.infer<typeof enablePluginSchema>;
export type PluginScope = z.infer<typeof pluginScopeSchema>;
export type PluginCategory = z.infer<typeof pluginCategorySchema>;
