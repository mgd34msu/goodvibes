// ============================================================================
// AGENT SCHEMAS
// ============================================================================

import { z } from 'zod';
import { numericIdSchema, filePathSchema, sessionIdSchema } from './primitives.js';

// ============================================================================
// HELPER - Transform undefined to null for DB compatibility
// ============================================================================

/**
 * Helper to create a nullable field that transforms undefined to null.
 * This ensures Zod output types match DB types (T | null) instead of (T | null | undefined).
 */
function nullableField<T extends z.ZodTypeAny>(schema: T) {
  return schema.nullable().optional().transform((v) => v ?? null);
}

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
  description: nullableField(z.string().max(1000, 'Description too long')),
  transport: mcpTransportSchema,
  command: nullableField(z.string().max(1000, 'Command too long')),
  url: nullableField(z.string().url('Invalid URL format').max(2000, 'URL too long')),
  args: z.array(z.string().max(1000, 'Argument too long')).default([]),
  env: z.record(z.string(), z.string()).default({}),
  scope: mcpScopeSchema.default('user'),
  projectPath: nullableField(filePathSchema),
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
  description: nullableField(z.string().max(5000, 'Description too long')),
  cwd: nullableField(z.string().max(1000, 'CWD too long')),
  initialPrompt: nullableField(z.string().max(100000, 'Initial prompt too long')),
  claudeMdContent: nullableField(z.string().max(500000, 'Claude MD content too long')),
  flags: z.array(z.string().max(200)).default([]),
  model: nullableField(z.string().max(100, 'Model name too long')),
  permissionMode: nullableField(permissionModeSchema),
  allowedTools: nullableField(z.array(z.string().max(200))),
  deniedTools: nullableField(z.array(z.string().max(200))),
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
 * Project hook event type schema - matches HookEventType from primitives/types
 */
export const projectHookEventTypeSchema = z.enum([
  'PreToolUse',
  'PostToolUse',
  'SessionStart',
  'SessionEnd',
  'Notification',
  'Stop',
]);

/**
 * Hook config schema - matches HookConfig
 */
export const hookConfigSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  eventType: projectHookEventTypeSchema,
  matcher: nullableField(z.string()),
  command: z.string(),
  timeout: z.number().int().positive(),
  enabled: z.boolean(),
  scope: z.enum(['user', 'project']),
  projectPath: nullableField(z.string()),
  executionCount: z.number().int().nonnegative(),
  lastExecuted: nullableField(z.string()),
  lastResult: nullableField(z.enum(['success', 'failure', 'timeout'])),
  createdAt: z.string(),
  updatedAt: z.string(),
  hookType: z.enum(['command', 'prompt']),
  prompt: nullableField(z.string()),
});

/**
 * Project config creation schema - matches Omit<ProjectConfig, 'createdAt' | 'updatedAt'>
 */
export const createProjectConfigSchema = z.object({
  projectPath: filePathSchema,
  defaultTemplateId: nullableField(z.string().max(100, 'Template ID too long')),
  settings: z.record(z.string(), z.unknown()).default({}),
  hooks: z.array(hookConfigSchema).default([]),
  mcpServers: z.array(z.string()).default([]),
  claudeMdOverride: nullableField(z.string().max(500000, 'Claude MD override too long')),
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
  pid: nullableField(z.number().int().positive()),
  cwd: z.string().min(1, 'CWD is required').max(1000, 'CWD too long'),
  parentId: nullableField(z.string().max(100, 'Parent ID too long')),
  templateId: nullableField(z.string().max(100, 'Template ID too long')),
  status: agentStatusSchema,
  sessionPath: nullableField(z.string().max(1000, 'Session path too long')),
  initialPrompt: nullableField(z.string().max(100000, 'Initial prompt too long')),
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
  description: nullableField(z.string().max(5000, 'Description too long')),
  content: z.string().min(1, 'Content is required').max(500000, 'Content too long'),
  allowedTools: nullableField(z.array(z.string().max(200))),
  scope: mcpScopeSchema.default('user'),
  projectPath: nullableField(z.string().max(1000, 'Project path too long')),
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
  description: nullableField(z.string().max(5000, 'Description too long')),
  templateId: nullableField(z.string().max(100, 'Template ID too long')),
  prompt: z.string().min(1, 'Prompt is required').max(100000, 'Prompt too long'),
  schedule: nullableField(z.string().max(200, 'Schedule too long')), // cron expression
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
  successScore: nullableField(z.number().min(0).max(1)),
  iterationCount: z.number().int().nonnegative().optional(),
  toolEfficiency: nullableField(z.number().min(0).max(1)),
  contextUsagePeak: nullableField(z.number().int().nonnegative()),
  estimatedRoi: nullableField(z.number()),
  tagsAuto: z.array(z.string().max(100)).optional(),
  outcomeAnalysis: nullableField(z.string().max(50000, 'Outcome analysis too long')),
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
  sessionId: nullableField(sessionIdSchema),
  toolName: z.string().min(1, 'Tool name is required').max(200, 'Tool name too long'),
  toolInput: nullableField(z.string().max(100000, 'Tool input too long')),
  toolResultPreview: nullableField(z.string().max(100000, 'Tool result too long')),
  success: z.boolean(),
  durationMs: nullableField(z.number().int().nonnegative()),
  tokenCost: nullableField(z.number().int().nonnegative()),
});
