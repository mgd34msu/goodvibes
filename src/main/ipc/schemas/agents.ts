// ============================================================================
// AGENT SCHEMAS
// ============================================================================

import { z } from 'zod';
import { numericIdSchema, filePathSchema, sessionIdSchema } from './primitives.js';

// ============================================================================
// MCP SERVER SCHEMAS
// ============================================================================

/**
 * MCP server transport type
 */
export const mcpTransportSchema = z.enum(['stdio', 'http']);

/**
 * MCP server scope type
 */
export const mcpScopeSchema = z.enum(['user', 'project']);

/**
 * MCP server status type
 */
export const mcpStatusSchema = z.enum(['connected', 'disconnected', 'error', 'unknown']);

/**
 * Base MCP server schema (without refine, for partial())
 * Matches Omit<MCPServer, 'id' | 'status' | 'lastConnected' | 'errorMessage' | 'toolCount' | 'createdAt' | 'updatedAt'>
 */
const mcpServerBaseSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200, 'Name too long'),
  description: z.string().max(1000, 'Description too long').nullable().optional(),
  transport: mcpTransportSchema,
  command: z.string().max(1000, 'Command too long').nullable().optional(),
  url: z.string().url('Invalid URL format').max(2000, 'URL too long').nullable().optional(),
  args: z.array(z.string().max(1000, 'Argument too long')).default([]),
  env: z.record(z.string(), z.string()).default({}),
  scope: mcpScopeSchema.default('user'),
  projectPath: filePathSchema.nullable().optional(),
  enabled: z.boolean(),
});

/**
 * MCP server creation schema - includes cross-field validation
 */
export const createMCPServerSchema = mcpServerBaseSchema.refine(
  (data) => {
    // stdio transport requires command, http transport requires url
    if (data.transport === 'stdio') {
      return data.command && data.command.length > 0;
    }
    if (data.transport === 'http') {
      return data.url && data.url.length > 0;
    }
    return true;
  },
  {
    message: 'stdio transport requires command, http transport requires url',
  }
);

/**
 * MCP server update schema - uses base schema partial for flexibility
 */
export const updateMCPServerSchema = z.object({
  id: numericIdSchema,
  updates: mcpServerBaseSchema.partial(),
});

/**
 * MCP server status update schema
 */
export const setMCPServerStatusSchema = z.object({
  id: numericIdSchema,
  status: mcpStatusSchema,
  errorMessage: z.string().max(5000, 'Error message too long').optional(),
});

// ============================================================================
// AGENT TEMPLATE SCHEMAS
// ============================================================================

/**
 * Agent permission mode type
 */
export const permissionModeSchema = z.enum(['default', 'plan', 'bypassPermissions']);

/**
 * Agent template creation schema - matches Omit<AgentTemplate, 'createdAt' | 'updatedAt'>
 */
export const createAgentTemplateSchema = z.object({
  id: z.string().min(1, 'ID is required').max(100, 'ID too long'),
  name: z.string().min(1, 'Name is required').max(200, 'Name too long'),
  description: z.string().max(5000, 'Description too long').nullable().optional(),
  cwd: z.string().max(1000, 'CWD too long').nullable().optional(),
  initialPrompt: z.string().max(100000, 'Initial prompt too long').nullable().optional(),
  claudeMdContent: z.string().max(500000, 'Claude MD content too long').nullable().optional(),
  flags: z.array(z.string().max(200)).default([]),
  model: z.string().max(100, 'Model name too long').nullable().optional(),
  permissionMode: permissionModeSchema.nullable().optional(),
  allowedTools: z.array(z.string().max(200)).nullable().optional(),
  deniedTools: z.array(z.string().max(200)).nullable().optional(),
});

/**
 * Agent template update schema
 */
export const updateAgentTemplateSchema = z.object({
  id: z.string().min(1, 'ID is required').max(100, 'ID too long'),
  updates: createAgentTemplateSchema.omit({ id: true }).partial(),
});

// ============================================================================
// PROJECT CONFIG SCHEMAS
// ============================================================================

/**
 * Project config creation schema - matches Omit<ProjectConfig, 'createdAt' | 'updatedAt'>
 */
export const createProjectConfigSchema = z.object({
  projectPath: filePathSchema,
  defaultTemplateId: z.string().max(100, 'Template ID too long').nullable().optional(),
  settings: z.record(z.string(), z.unknown()).default({}),
  hooks: z.array(z.object({
    id: z.number().int().positive(),
    name: z.string(),
    eventType: z.string(),
    matcher: z.string().nullable().optional(),
    command: z.string(),
    timeout: z.number().int().positive(),
    enabled: z.boolean(),
    scope: z.enum(['user', 'project']),
    projectPath: z.string().nullable().optional(),
    executionCount: z.number().int().nonnegative(),
    lastExecuted: z.string().nullable().optional(),
    lastResult: z.enum(['success', 'failure', 'timeout']).nullable().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    hookType: z.enum(['command', 'prompt']),
    prompt: z.string().nullable().optional(),
  })).default([]),
  mcpServers: z.array(z.string()).default([]),
  claudeMdOverride: z.string().max(500000, 'Claude MD override too long').nullable().optional(),
});

/**
 * Project config update schema
 */
export const updateProjectConfigSchema = z.object({
  projectPath: filePathSchema,
  updates: createProjectConfigSchema.omit({ projectPath: true }).partial(),
});

// ============================================================================
// AGENT REGISTRY SCHEMAS
// ============================================================================

/**
 * Agent status schema - matches AgentStatus type
 */
export const agentStatusSchema = z.enum([
  'spawning',
  'ready',
  'active',
  'idle',
  'completed',
  'error',
  'terminated',
]);

/**
 * Agent registry entry creation schema - matches Omit<AgentRecord, 'spawnedAt' | 'lastActivity' | 'completedAt' | 'exitCode' | 'errorMessage'>
 */
export const createAgentRegistryEntrySchema = z.object({
  id: z.string().min(1, 'ID is required').max(100, 'ID too long'),
  name: z.string().min(1, 'Name is required').max(200, 'Name too long'),
  pid: z.number().int().positive().nullable().optional(),
  cwd: z.string().min(1, 'CWD is required').max(1000, 'CWD too long'),
  parentId: z.string().max(100, 'Parent ID too long').nullable().optional(),
  templateId: z.string().max(100, 'Template ID too long').nullable().optional(),
  status: agentStatusSchema,
  sessionPath: z.string().max(1000, 'Session path too long').nullable().optional(),
  initialPrompt: z.string().max(100000, 'Initial prompt too long').nullable().optional(),
});

/**
 * Agent registry entry update schema
 */
export const updateAgentRegistryEntrySchema = z.object({
  id: z.string().min(1, 'ID is required').max(100, 'ID too long'),
  updates: z.object({
    status: agentStatusSchema.optional(),
    errorMessage: z.string().max(10000, 'Error message too long').optional(),
  }),
});

// ============================================================================
// SKILL SCHEMAS
// ============================================================================

/**
 * Skill creation schema - matches Omit<Skill, 'id' | 'useCount' | 'lastUsed' | 'createdAt' | 'updatedAt'>
 */
export const createSkillSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200, 'Name too long'),
  description: z.string().max(5000, 'Description too long').nullable().optional(),
  content: z.string().min(1, 'Content is required').max(500000, 'Content too long'),
  allowedTools: z.array(z.string().max(200)).nullable().optional(),
  scope: mcpScopeSchema.default('user'),
  projectPath: z.string().max(1000, 'Project path too long').nullable().optional(),
});

/**
 * Skill update schema
 */
export const updateSkillSchema = z.object({
  id: numericIdSchema,
  updates: createSkillSchema.partial(),
});

// ============================================================================
// TASK DEFINITION SCHEMAS
// ============================================================================

/**
 * Task definition creation schema - matches Omit<TaskDefinition, 'id' | 'lastRun' | 'lastResult' | 'runCount' | 'createdAt' | 'updatedAt'>
 */
export const createTaskDefinitionSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200, 'Name too long'),
  description: z.string().max(5000, 'Description too long').nullable().optional(),
  templateId: z.string().max(100, 'Template ID too long').nullable().optional(),
  prompt: z.string().min(1, 'Prompt is required').max(100000, 'Prompt too long'),
  schedule: z.string().max(200, 'Schedule too long').nullable().optional(), // cron expression
  enabled: z.boolean(),
});

/**
 * Task definition update schema
 */
export const updateTaskDefinitionSchema = z.object({
  id: numericIdSchema,
  updates: createTaskDefinitionSchema.partial(),
});

// ============================================================================
// SESSION ANALYTICS SCHEMAS
// ============================================================================

/**
 * Session analytics creation schema - matches Partial<SessionAnalytics> & { sessionId: string }
 */
export const createSessionAnalyticsSchema = z.object({
  sessionId: sessionIdSchema,
  successScore: z.number().min(0).max(1).nullable().optional(),
  iterationCount: z.number().int().nonnegative().optional(),
  toolEfficiency: z.number().min(0).max(1).nullable().optional(),
  contextUsagePeak: z.number().int().nonnegative().nullable().optional(),
  estimatedRoi: z.number().nullable().optional(),
  tagsAuto: z.array(z.string().max(100)).optional(),
  outcomeAnalysis: z.string().max(50000, 'Outcome analysis too long').nullable().optional(),
});

/**
 * Session analytics update schema
 */
export const updateSessionAnalyticsSchema = z.object({
  sessionId: sessionIdSchema,
  updates: createSessionAnalyticsSchema.omit({ sessionId: true }),
});

// ============================================================================
// TOOL USAGE SCHEMAS
// ============================================================================

/**
 * Record tool usage schema - matches Omit<DetailedToolUsage, 'id' | 'timestamp'>
 */
export const recordToolUsageSchema = z.object({
  sessionId: sessionIdSchema.nullable().optional(),
  toolName: z.string().min(1, 'Tool name is required').max(200, 'Tool name too long'),
  toolInput: z.string().max(100000, 'Tool input too long').nullable().optional(),
  toolResultPreview: z.string().max(100000, 'Tool result too long').nullable().optional(),
  success: z.boolean(),
  durationMs: z.number().int().nonnegative().nullable().optional(),
  tokenCost: z.number().int().nonnegative().nullable().optional(),
});
