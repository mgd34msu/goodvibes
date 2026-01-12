// ============================================================================
// PRIMITIVES IPC HANDLERS
// ============================================================================
//
// Handles IPC for MCP servers, agent templates, project configs,
// agent registry, skills, task definitions, session analytics, and tool usage.
// ============================================================================

import { ipcMain } from 'electron';
import { Logger } from '../../services/logger.js';
import { withContext } from '../utils.js';
import * as primitives from '../../database/primitives.js';

const logger = new Logger('IPC:Primitives');

export function registerPrimitivesHandlers(): void {
  // ============================================================================
  // MCP SERVER HANDLERS
  // ============================================================================

  ipcMain.handle('get-mcp-servers', withContext('get-mcp-servers', async () => {
    return primitives.getAllMCPServers();
  }));

  ipcMain.handle('get-mcp-server', withContext('get-mcp-server', async (_, id: number) => {
    return primitives.getMCPServer(id);
  }));

  ipcMain.handle('create-mcp-server', withContext('create-mcp-server', async (_, server: Omit<primitives.MCPServer, 'id' | 'status' | 'lastConnected' | 'errorMessage' | 'toolCount' | 'createdAt' | 'updatedAt'>) => {
    return primitives.createMCPServer(server);
  }));

  ipcMain.handle('update-mcp-server', withContext('update-mcp-server', async (_, { id, updates }: { id: number; updates: Partial<primitives.MCPServer> }) => {
    primitives.updateMCPServer(id, updates);
    return true;
  }));

  ipcMain.handle('delete-mcp-server', withContext('delete-mcp-server', async (_, id: number) => {
    primitives.deleteMCPServer(id);
    return true;
  }));

  ipcMain.handle('set-mcp-server-status', withContext('set-mcp-server-status', async (_, { id, status, errorMessage }: { id: number; status: primitives.MCPServer['status']; errorMessage?: string }) => {
    primitives.updateMCPServerStatus(id, status, errorMessage);
    return true;
  }));

  // ============================================================================
  // AGENT TEMPLATE HANDLERS
  // ============================================================================

  ipcMain.handle('get-agent-templates', withContext('get-agent-templates', async () => {
    return primitives.getAllAgentTemplates();
  }));

  ipcMain.handle('get-agent-template', withContext('get-agent-template', async (_, id: string) => {
    return primitives.getAgentTemplate(id);
  }));

  ipcMain.handle('create-agent-template', withContext('create-agent-template', async (_, template: Omit<primitives.AgentTemplate, 'id' | 'createdAt' | 'updatedAt'>) => {
    // Generate a unique ID for the agent template
    const id = `agent-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    return primitives.createAgentTemplate({ ...template, id });
  }));

  ipcMain.handle('update-agent-template', withContext('update-agent-template', async (_, { id, updates }: { id: string; updates: Partial<primitives.AgentTemplate> }) => {
    primitives.updateAgentTemplate(id, updates);
    return true;
  }));

  ipcMain.handle('delete-agent-template', withContext('delete-agent-template', async (_, id: string) => {
    primitives.deleteAgentTemplate(id);
    return true;
  }));

  // ============================================================================
  // PROJECT CONFIG HANDLERS
  // ============================================================================

  ipcMain.handle('get-project-configs', withContext('get-project-configs', async () => {
    return primitives.getAllProjectConfigs();
  }));

  ipcMain.handle('get-project-config', withContext('get-project-config', async (_, projectPath: string) => {
    return primitives.getProjectConfig(projectPath);
  }));

  ipcMain.handle('get-project-config-by-path', withContext('get-project-config-by-path', async (_, projectPath: string) => {
    return primitives.getProjectConfig(projectPath);
  }));

  ipcMain.handle('create-project-config', withContext('create-project-config', async (_, config: Omit<primitives.ProjectConfig, 'createdAt' | 'updatedAt'>) => {
    return primitives.createProjectConfig(config);
  }));

  ipcMain.handle('update-project-config', withContext('update-project-config', async (_, { projectPath, updates }: { projectPath: string; updates: Partial<primitives.ProjectConfig> }) => {
    primitives.updateProjectConfig(projectPath, updates);
    return true;
  }));

  ipcMain.handle('delete-project-config', withContext('delete-project-config', async (_, projectPath: string) => {
    primitives.deleteProjectConfig(projectPath);
    return true;
  }));

  // ============================================================================
  // AGENT REGISTRY HANDLERS
  // ============================================================================

  ipcMain.handle('get-agent-registry-entries', withContext('get-agent-registry-entries', async () => {
    const agents = primitives.getAllAgents();
    logger.info('[DEBUG] get-agent-registry-entries called, returning:', {
      count: agents.length,
      agents: agents.map(a => ({ id: a.id, name: a.name, status: a.status })),
    });
    return agents;
  }));

  ipcMain.handle('get-agent-registry-entry', withContext('get-agent-registry-entry', async (_, id: string) => {
    return primitives.getAgent(id);
  }));

  ipcMain.handle('get-active-agents', withContext('get-active-agents', async () => {
    return primitives.getActiveAgents();
  }));

  ipcMain.handle('get-agent-children', withContext('get-agent-children', async (_, parentId: string) => {
    return primitives.getAgentsByParent(parentId);
  }));

  ipcMain.handle('create-agent-registry-entry', withContext('create-agent-registry-entry', async (_, entry: Omit<primitives.AgentRecord, 'spawnedAt' | 'lastActivity' | 'completedAt' | 'exitCode' | 'errorMessage'>) => {
    return primitives.registerAgent(entry);
  }));

  ipcMain.handle('update-agent-registry-entry', withContext('update-agent-registry-entry', async (_, { id, updates }: { id: string; updates: { status?: primitives.AgentStatus; errorMessage?: string } }) => {
    if (updates.status) {
      primitives.updateAgentStatus(id, updates.status, updates.errorMessage);
    }
    return true;
  }));

  ipcMain.handle('delete-agent-registry-entry', withContext('delete-agent-registry-entry', async (_, id: string) => {
    primitives.deleteAgent(id);
    return true;
  }));

  // ============================================================================
  // SKILLS HANDLERS
  // ============================================================================

  ipcMain.handle('get-skills', withContext('get-skills', async () => {
    return primitives.getAllSkills();
  }));

  ipcMain.handle('get-skill', withContext('get-skill', async (_, id: number) => {
    return primitives.getSkill(id);
  }));

  ipcMain.handle('create-skill', withContext('create-skill', async (_, skill: Omit<primitives.Skill, 'id' | 'useCount' | 'lastUsed' | 'createdAt' | 'updatedAt'>) => {
    return primitives.createSkill(skill);
  }));

  ipcMain.handle('update-skill', withContext('update-skill', async (_, { id, updates }: { id: number; updates: Partial<primitives.Skill> }) => {
    primitives.updateSkill(id, updates);
    return true;
  }));

  ipcMain.handle('delete-skill', withContext('delete-skill', async (_, id: number) => {
    primitives.deleteSkill(id);
    return true;
  }));

  ipcMain.handle('increment-skill-usage', withContext('increment-skill-usage', async (_, id: number) => {
    primitives.recordSkillUsage(id);
    return true;
  }));

  // ============================================================================
  // TASK DEFINITION HANDLERS
  // ============================================================================

  ipcMain.handle('get-task-definitions', withContext('get-task-definitions', async () => {
    return primitives.getAllTaskDefinitions();
  }));

  ipcMain.handle('get-task-definition', withContext('get-task-definition', async (_, id: number) => {
    return primitives.getTaskDefinition(id);
  }));

  ipcMain.handle('create-task-definition', withContext('create-task-definition', async (_, task: Omit<primitives.TaskDefinition, 'id' | 'lastRun' | 'lastResult' | 'runCount' | 'createdAt' | 'updatedAt'>) => {
    return primitives.createTaskDefinition(task);
  }));

  ipcMain.handle('update-task-definition', withContext('update-task-definition', async (_, { id, updates }: { id: number; updates: Partial<primitives.TaskDefinition> }) => {
    primitives.updateTaskDefinition(id, updates);
    return true;
  }));

  ipcMain.handle('delete-task-definition', withContext('delete-task-definition', async (_, id: number) => {
    primitives.deleteTaskDefinition(id);
    return true;
  }));

  // ============================================================================
  // SESSION ANALYTICS HANDLERS
  // ============================================================================

  ipcMain.handle('get-session-analytics', withContext('get-session-analytics', async (_, sessionId: string) => {
    return primitives.getSessionAnalytics(sessionId);
  }));

  ipcMain.handle('create-session-analytics', withContext('create-session-analytics', async (_, analytics: Partial<primitives.SessionAnalytics> & { sessionId: string }) => {
    primitives.upsertSessionAnalytics(analytics);
    return true;
  }));

  ipcMain.handle('update-session-analytics', withContext('update-session-analytics', async (_, { sessionId, updates }: { sessionId: string; updates: Partial<primitives.SessionAnalytics> }) => {
    primitives.upsertSessionAnalytics({ sessionId, ...updates });
    return true;
  }));

  // ============================================================================
  // TOOL USAGE DETAILED HANDLERS
  // ============================================================================

  ipcMain.handle('get-tool-usage-detailed', withContext('get-tool-usage-detailed', async (_, sessionId: string) => {
    return primitives.getDetailedToolUsageBySession(sessionId);
  }));

  ipcMain.handle('record-tool-usage', withContext('record-tool-usage', async (_, usage: Omit<primitives.DetailedToolUsage, 'id' | 'timestamp'>) => {
    primitives.recordDetailedToolUsage(usage);
    return true;
  }));

  ipcMain.handle('get-tool-usage-summary', withContext('get-tool-usage-summary', async () => {
    return primitives.getToolEfficiencyStats();
  }));

  logger.info('Primitives handlers registered');
}
