// ============================================================================
// PRIMITIVES IPC HANDLERS
// ============================================================================
//
// Handles IPC for MCP servers, agent templates, project configs,
// agent registry, skills, task definitions, session analytics, and tool usage.
//
// All handlers use Zod validation for input sanitization.
// ============================================================================

import { ipcMain } from 'electron';
import { ZodError } from 'zod';
import { Logger } from '../../services/logger.js';
import { withContext } from '../utils.js';
import * as primitives from '../../database/primitives.js';
import {
  numericIdSchema,
  sessionIdSchema,
  filePathSchema,
} from '../schemas/primitives.js';
import {
  createMCPServerSchema,
  updateMCPServerSchema,
  setMCPServerStatusSchema,
  createAgentTemplateSchema,
  updateAgentTemplateSchema,
  createProjectConfigSchema,
  updateProjectConfigSchema,
  createAgentRegistryEntrySchema,
  updateAgentRegistryEntrySchema,
  createSkillSchema,
  updateSkillSchema,
  createTaskDefinitionSchema,
  updateTaskDefinitionSchema,
  createSessionAnalyticsSchema,
  updateSessionAnalyticsSchema,
  recordToolUsageSchema,
} from '../schemas/agents.js';

const logger = new Logger('IPC:Primitives');

// ============================================================================
// VALIDATION ERROR RESPONSE
// ============================================================================

interface ValidationErrorResponse {
  success: false;
  error: string;
  details?: Array<{ path: string; message: string }>;
}

/**
 * Formats a ZodError into a user-friendly error response
 */
function formatValidationError(error: ZodError): ValidationErrorResponse {
  const details = error.errors.map((e) => ({
    path: e.path.join('.'),
    message: e.message,
  }));

  return {
    success: false,
    error: `Validation failed: ${details.map((d) => d.message).join(', ')}`,
    details,
  };
}

/**
 * Validates input using a Zod schema, logging and re-throwing on error
 */
function validateInput<T>(
  schema: { parse: (data: unknown) => T },
  data: unknown,
  operation: string
): T {
  try {
    return schema.parse(data);
  } catch (error) {
    if (error instanceof ZodError) {
      const response = formatValidationError(error);
      logger.warn(`Validation failed for ${operation}`, {
        error: response.error,
        details: response.details,
      });
      throw new Error(response.error);
    }
    throw error;
  }
}

export function registerPrimitivesHandlers(): void {
  // ============================================================================
  // MCP SERVER HANDLERS
  // ============================================================================

  ipcMain.handle('get-mcp-servers', withContext('get-mcp-servers', async () => {
    return primitives.getAllMCPServers();
  }));

  ipcMain.handle('get-mcp-server', withContext('get-mcp-server', async (_, id: unknown) => {
    const validatedId = validateInput(numericIdSchema, id, 'get-mcp-server');
    return primitives.getMCPServer(validatedId);
  }));

  ipcMain.handle('create-mcp-server', withContext('create-mcp-server', async (_, server: unknown) => {
    const validatedServer = validateInput(createMCPServerSchema, server, 'create-mcp-server');
    return primitives.createMCPServer(validatedServer);
  }));

  ipcMain.handle('update-mcp-server', withContext('update-mcp-server', async (_, data: unknown) => {
    const { id, updates } = validateInput(updateMCPServerSchema, data, 'update-mcp-server');
    primitives.updateMCPServer(id, updates);
    return true;
  }));

  ipcMain.handle('delete-mcp-server', withContext('delete-mcp-server', async (_, id: unknown) => {
    const validatedId = validateInput(numericIdSchema, id, 'delete-mcp-server');
    primitives.deleteMCPServer(validatedId);
    return true;
  }));

  ipcMain.handle('set-mcp-server-status', withContext('set-mcp-server-status', async (_, data: unknown) => {
    const { id, status, errorMessage } = validateInput(setMCPServerStatusSchema, data, 'set-mcp-server-status');
    primitives.updateMCPServerStatus(id, status, errorMessage);
    return true;
  }));

  // ============================================================================
  // AGENT TEMPLATE HANDLERS
  // ============================================================================

  /** Schema for agent template ID */
  const agentTemplateIdSchema = { parse: (data: unknown) => {
    if (typeof data !== 'string' || data.length === 0 || data.length > 100) {
      throw new ZodError([{ code: 'custom', path: ['id'], message: 'ID must be a string between 1 and 100 characters' }]);
    }
    return data;
  }};

  ipcMain.handle('get-agent-templates', withContext('get-agent-templates', async () => {
    return primitives.getAllAgentTemplates();
  }));

  ipcMain.handle('get-agent-template', withContext('get-agent-template', async (_, id: unknown) => {
    const validatedId = validateInput(agentTemplateIdSchema, id, 'get-agent-template');
    return primitives.getAgentTemplate(validatedId);
  }));

  ipcMain.handle('create-agent-template', withContext('create-agent-template', async (_, template: unknown) => {
    // Generate a unique ID for the agent template
    const id = `agent-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const templateWithId = { ...(template as object), id };
    const validatedTemplate = validateInput(createAgentTemplateSchema, templateWithId, 'create-agent-template');
    return primitives.createAgentTemplate(validatedTemplate);
  }));

  ipcMain.handle('update-agent-template', withContext('update-agent-template', async (_, data: unknown) => {
    const { id, updates } = validateInput(updateAgentTemplateSchema, data, 'update-agent-template');
    primitives.updateAgentTemplate(id, updates);
    return true;
  }));

  ipcMain.handle('delete-agent-template', withContext('delete-agent-template', async (_, id: unknown) => {
    const validatedId = validateInput(agentTemplateIdSchema, id, 'delete-agent-template');
    primitives.deleteAgentTemplate(validatedId);
    return true;
  }));

  // ============================================================================
  // PROJECT CONFIG HANDLERS
  // ============================================================================

  ipcMain.handle('get-project-configs', withContext('get-project-configs', async () => {
    return primitives.getAllProjectConfigs();
  }));

  ipcMain.handle('get-project-config', withContext('get-project-config', async (_, projectPath: unknown) => {
    const validatedPath = validateInput(filePathSchema, projectPath, 'get-project-config');
    return primitives.getProjectConfig(validatedPath);
  }));

  ipcMain.handle('get-project-config-by-path', withContext('get-project-config-by-path', async (_, projectPath: unknown) => {
    const validatedPath = validateInput(filePathSchema, projectPath, 'get-project-config-by-path');
    return primitives.getProjectConfig(validatedPath);
  }));

  ipcMain.handle('create-project-config', withContext('create-project-config', async (_, config: unknown) => {
    const validatedConfig = validateInput(createProjectConfigSchema, config, 'create-project-config');
    return primitives.createProjectConfig(validatedConfig);
  }));

  ipcMain.handle('update-project-config', withContext('update-project-config', async (_, data: unknown) => {
    const { projectPath, updates } = validateInput(updateProjectConfigSchema, data, 'update-project-config');
    primitives.updateProjectConfig(projectPath, updates);
    return true;
  }));

  ipcMain.handle('delete-project-config', withContext('delete-project-config', async (_, projectPath: unknown) => {
    const validatedPath = validateInput(filePathSchema, projectPath, 'delete-project-config');
    primitives.deleteProjectConfig(validatedPath);
    return true;
  }));

  // ============================================================================
  // AGENT REGISTRY HANDLERS
  // ============================================================================

  ipcMain.handle('get-agent-registry-entries', withContext('get-agent-registry-entries', async () => {
    return primitives.getAllAgents();
  }));

  ipcMain.handle('get-agent-registry-entry', withContext('get-agent-registry-entry', async (_, id: unknown) => {
    const validatedId = validateInput(agentTemplateIdSchema, id, 'get-agent-registry-entry');
    return primitives.getAgent(validatedId);
  }));

  ipcMain.handle('get-active-agents', withContext('get-active-agents', async () => {
    return primitives.getActiveAgents();
  }));

  ipcMain.handle('get-agent-children', withContext('get-agent-children', async (_, parentId: unknown) => {
    const validatedId = validateInput(agentTemplateIdSchema, parentId, 'get-agent-children');
    return primitives.getAgentsByParent(validatedId);
  }));

  ipcMain.handle('create-agent-registry-entry', withContext('create-agent-registry-entry', async (_, entry: unknown) => {
    const validatedEntry = validateInput(createAgentRegistryEntrySchema, entry, 'create-agent-registry-entry');
    return primitives.registerAgent(validatedEntry);
  }));

  ipcMain.handle('update-agent-registry-entry', withContext('update-agent-registry-entry', async (_, data: unknown) => {
    const { id, updates } = validateInput(updateAgentRegistryEntrySchema, data, 'update-agent-registry-entry');
    if (updates.status) {
      primitives.updateAgentStatus(id, updates.status, updates.errorMessage);
    }
    return true;
  }));

  ipcMain.handle('delete-agent-registry-entry', withContext('delete-agent-registry-entry', async (_, id: unknown) => {
    const validatedId = validateInput(agentTemplateIdSchema, id, 'delete-agent-registry-entry');
    primitives.deleteAgent(validatedId);
    return true;
  }));

  // ============================================================================
  // SKILLS HANDLERS
  // ============================================================================

  ipcMain.handle('get-skills', withContext('get-skills', async () => {
    return primitives.getAllSkills();
  }));

  ipcMain.handle('get-skill', withContext('get-skill', async (_, id: unknown) => {
    const validatedId = validateInput(numericIdSchema, id, 'get-skill');
    return primitives.getSkill(validatedId);
  }));

  ipcMain.handle('create-skill', withContext('create-skill', async (_, skill: unknown) => {
    const validatedSkill = validateInput(createSkillSchema, skill, 'create-skill');
    return primitives.createSkill(validatedSkill);
  }));

  ipcMain.handle('update-skill', withContext('update-skill', async (_, data: unknown) => {
    const { id, updates } = validateInput(updateSkillSchema, data, 'update-skill');
    primitives.updateSkill(id, updates);
    return true;
  }));

  ipcMain.handle('delete-skill', withContext('delete-skill', async (_, id: unknown) => {
    const validatedId = validateInput(numericIdSchema, id, 'delete-skill');
    primitives.deleteSkill(validatedId);
    return true;
  }));

  ipcMain.handle('increment-skill-usage', withContext('increment-skill-usage', async (_, id: unknown) => {
    const validatedId = validateInput(numericIdSchema, id, 'increment-skill-usage');
    primitives.recordSkillUsage(validatedId);
    return true;
  }));

  // ============================================================================
  // TASK DEFINITION HANDLERS
  // ============================================================================

  ipcMain.handle('get-task-definitions', withContext('get-task-definitions', async () => {
    return primitives.getAllTaskDefinitions();
  }));

  ipcMain.handle('get-task-definition', withContext('get-task-definition', async (_, id: unknown) => {
    const validatedId = validateInput(numericIdSchema, id, 'get-task-definition');
    return primitives.getTaskDefinition(validatedId);
  }));

  ipcMain.handle('create-task-definition', withContext('create-task-definition', async (_, task: unknown) => {
    const validatedTask = validateInput(createTaskDefinitionSchema, task, 'create-task-definition');
    return primitives.createTaskDefinition(validatedTask);
  }));

  ipcMain.handle('update-task-definition', withContext('update-task-definition', async (_, data: unknown) => {
    const { id, updates } = validateInput(updateTaskDefinitionSchema, data, 'update-task-definition');
    primitives.updateTaskDefinition(id, updates);
    return true;
  }));

  ipcMain.handle('delete-task-definition', withContext('delete-task-definition', async (_, id: unknown) => {
    const validatedId = validateInput(numericIdSchema, id, 'delete-task-definition');
    primitives.deleteTaskDefinition(validatedId);
    return true;
  }));

  // ============================================================================
  // SESSION ANALYTICS HANDLERS
  // ============================================================================

  ipcMain.handle('get-session-analytics', withContext('get-session-analytics', async (_, sessionId: unknown) => {
    const validatedId = validateInput(sessionIdSchema, sessionId, 'get-session-analytics');
    return primitives.getSessionAnalytics(validatedId);
  }));

  ipcMain.handle('create-session-analytics', withContext('create-session-analytics', async (_, analytics: unknown) => {
    const validatedAnalytics = validateInput(createSessionAnalyticsSchema, analytics, 'create-session-analytics');
    primitives.upsertSessionAnalytics(validatedAnalytics);
    return true;
  }));

  ipcMain.handle('update-session-analytics', withContext('update-session-analytics', async (_, data: unknown) => {
    const { sessionId, updates } = validateInput(updateSessionAnalyticsSchema, data, 'update-session-analytics');
    primitives.upsertSessionAnalytics({ sessionId, ...updates });
    return true;
  }));

  // ============================================================================
  // TOOL USAGE DETAILED HANDLERS
  // ============================================================================

  ipcMain.handle('get-tool-usage-detailed', withContext('get-tool-usage-detailed', async (_, sessionId: unknown) => {
    const validatedId = validateInput(sessionIdSchema, sessionId, 'get-tool-usage-detailed');
    return primitives.getDetailedToolUsageBySession(validatedId);
  }));

  ipcMain.handle('record-tool-usage', withContext('record-tool-usage', async (_, usage: unknown) => {
    const validatedUsage = validateInput(recordToolUsageSchema, usage, 'record-tool-usage');
    primitives.recordDetailedToolUsage(validatedUsage);
    return true;
  }));

  ipcMain.handle('get-tool-usage-summary', withContext('get-tool-usage-summary', async () => {
    return primitives.getToolEfficiencyStats();
  }));

  logger.info('Primitives handlers registered (with Zod validation)');
}
