// ============================================================================
// AGENT SCHEMAS
// ============================================================================

import { z } from 'zod';
import { numericIdSchema, filePathSchema, sessionIdSchema } from './primitives.js';

/**
 * MCP server creation schema
 */
export const createMCPServerSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  command: z.string().min(1).max(1000),
  args: z.array(z.string().max(1000)).optional(),
  env: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean(),
  autoStart: z.boolean().optional(),
});

/**
 * MCP server update schema
 */
export const updateMCPServerSchema = z.object({
  id: numericIdSchema,
  updates: createMCPServerSchema.partial(),
});

/**
 * MCP server status schema
 */
export const setMCPServerStatusSchema = z.object({
  id: numericIdSchema,
  status: z.enum(['connected', 'disconnected', 'error', 'connecting']),
  errorMessage: z.string().max(5000).optional(),
});

/**
 * Agent template creation schema
 */
export const createAgentTemplateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  systemPrompt: z.string().min(1).max(100000),
  model: z.string().max(100).optional(),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  tools: z.array(z.string().max(200)).optional(),
  enabled: z.boolean(),
});

/**
 * Agent template update schema
 */
export const updateAgentTemplateSchema = z.object({
  id: z.string().min(1).max(100),
  updates: createAgentTemplateSchema.partial(),
});

/**
 * Project config creation schema
 */
export const createProjectConfigSchema = z.object({
  projectPath: filePathSchema,
  defaultBranch: z.string().max(200).optional(),
  claudeConfig: z.record(z.string(), z.unknown()).optional(),
  hooks: z.array(z.number().int().positive()).optional(),
  agents: z.array(z.string()).optional(),
});

/**
 * Project config update schema
 */
export const updateProjectConfigSchema = z.object({
  projectPath: filePathSchema,
  updates: createProjectConfigSchema.partial(),
});

/**
 * Agent status schema
 */
export const agentStatusSchema = z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']);

/**
 * Agent registry entry creation schema
 */
export const createAgentRegistryEntrySchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  templateId: z.string().max(100).optional(),
  parentId: z.string().max(100).optional(),
  sessionId: sessionIdSchema.optional(),
  projectPath: filePathSchema.optional(),
  status: agentStatusSchema,
  task: z.string().max(10000).optional(),
});

/**
 * Agent registry entry update schema
 */
export const updateAgentRegistryEntrySchema = z.object({
  id: z.string().min(1).max(100),
  updates: z.object({
    status: agentStatusSchema.optional(),
    errorMessage: z.string().max(10000).optional(),
  }),
});

/**
 * Skill creation schema
 */
export const createSkillSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  content: z.string().min(1).max(100000),
  category: z.string().max(100).optional(),
  tags: z.array(z.string().max(50)).optional(),
  enabled: z.boolean(),
});

/**
 * Skill update schema
 */
export const updateSkillSchema = z.object({
  id: numericIdSchema,
  updates: createSkillSchema.partial(),
});

/**
 * Task definition creation schema
 */
export const createTaskDefinitionSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  prompt: z.string().min(1).max(100000),
  category: z.string().max(100).optional(),
  agentTemplate: z.string().max(100).optional(),
  enabled: z.boolean(),
});

/**
 * Task definition update schema
 */
export const updateTaskDefinitionSchema = z.object({
  id: numericIdSchema,
  updates: createTaskDefinitionSchema.partial(),
});

/**
 * Session analytics creation schema
 */
export const createSessionAnalyticsSchema = z.object({
  sessionId: sessionIdSchema,
  totalMessages: z.number().int().nonnegative().optional(),
  userMessages: z.number().int().nonnegative().optional(),
  assistantMessages: z.number().int().nonnegative().optional(),
  toolCalls: z.number().int().nonnegative().optional(),
  errorCount: z.number().int().nonnegative().optional(),
  avgResponseTime: z.number().nonnegative().optional(),
});

/**
 * Session analytics update schema
 */
export const updateSessionAnalyticsSchema = z.object({
  sessionId: sessionIdSchema,
  updates: createSessionAnalyticsSchema.omit({ sessionId: true }),
});

/**
 * Record tool usage schema
 */
export const recordToolUsageSchema = z.object({
  sessionId: sessionIdSchema,
  toolName: z.string().min(1).max(200),
  input: z.string().max(100000).optional(),
  output: z.string().max(100000).optional(),
  duration: z.number().nonnegative().optional(),
  success: z.boolean(),
  errorMessage: z.string().max(10000).optional(),
});
