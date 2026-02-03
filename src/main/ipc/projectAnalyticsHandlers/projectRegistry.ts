// ============================================================================
// PROJECT REGISTRY IPC HANDLERS
// ============================================================================

import { ipcMain } from 'electron';
import { getProjectRegistry } from '../../services/projectRegistry/index.js';
import { getProjectCoordinator } from '../../services/projectCoordinator/index.js';
import type {
  ProjectSettings,
  ProjectAgentSettings,
} from '../../database/projectRegistry.js';

// ============================================================================
// PROJECT HANDLERS
// ============================================================================

export function registerProjectHandlers(): void {
  const registry = getProjectRegistry();

  // Register a new project
  ipcMain.handle('project:register', async (_event, options: {
    path: string;
    name?: string;
    description?: string;
    settings?: ProjectSettings;
  }) => {
    return registry.addProject(
      options.path,
      options.name,
      options.description,
      options.settings
    );
  });

  // Update project
  ipcMain.handle('project:update', async (_event, projectId: number, updates: {
    name?: string;
    description?: string | null;
    settings?: ProjectSettings;
  }) => {
    return registry.updateProject(projectId, updates);
  });

  // Remove project
  ipcMain.handle('project:remove', async (_event, projectId: number) => {
    registry.removeProject(projectId);
    return true;
  });

  // Get all projects
  ipcMain.handle('project:getAll', async () => {
    return registry.getAllProjects();
  });

  // Get single project
  ipcMain.handle('project:get', async (_event, projectId: number) => {
    return registry.getProject(projectId);
  });

  // Get project by path
  ipcMain.handle('project:getByPath', async (_event, path: string) => {
    return registry.getProjectByPath(path);
  });

  // Search projects
  ipcMain.handle('project:search', async (_event, query: string) => {
    return registry.findProjects(query);
  });

  // Get project settings
  ipcMain.handle('project:getSettings', async (_event, projectId: number) => {
    return registry.getProjectSettings(projectId);
  });

  // Update project settings
  ipcMain.handle('project:updateSettings', async (_event, projectId: number, settings: ProjectSettings) => {
    return registry.updateProjectSettings(projectId, settings);
  });

  // Switch project context
  ipcMain.handle('project:switch', async (_event, projectId: number) => {
    return registry.switchProject(projectId);
  });

  // Get current project
  ipcMain.handle('project:getCurrent', async () => {
    return registry.getCurrentProject();
  });

  // Get project context
  ipcMain.handle('project:getContext', async (_event, projectId: number) => {
    return registry.getProjectContext(projectId);
  });

  // Assign agent to project
  ipcMain.handle('project:assignAgent', async (_event, options: {
    projectId: number;
    agentId: number;
    priority?: number;
    settings?: ProjectAgentSettings;
  }) => {
    return registry.addAgentToProject(
      options.projectId,
      options.agentId,
      options.priority ?? 0,
      options.settings
    );
  });

  // Get project agents
  ipcMain.handle('project:getAgents', async (_event, projectId: number) => {
    return registry.getAgentsForProject(projectId);
  });

  // Update project agent
  ipcMain.handle('project:updateAgent', async (_event, agentAssignmentId: number, updates: {
    priority?: number;
    settings?: ProjectAgentSettings;
  }) => {
    return registry.updateAgentConfig(agentAssignmentId, updates);
  });

  // Remove agent from project
  ipcMain.handle('project:removeAgent', async (_event, projectId: number, agentId: number) => {
    registry.removeAgentFromProjectConfig(projectId, agentId);
    return true;
  });

  // Get auto-activate agents
  ipcMain.handle('project:getAutoActivateAgents', async (_event, projectId: number) => {
    return registry.getAutoActivateAgents(projectId);
  });
}

// ============================================================================
// TEMPLATE HANDLERS
// ============================================================================

export function registerTemplateHandlers(): void {
  const registry = getProjectRegistry();

  // Create template
  ipcMain.handle('template:create', async (_event, options: {
    name: string;
    description?: string;
    settings?: ProjectSettings;
    agents?: Array<{ agentId: number; priority: number; settings?: ProjectAgentSettings }>;
  }) => {
    return registry.createTemplate(
      options.name,
      options.description,
      options.settings,
      options.agents
    );
  });

  // Get template by ID
  ipcMain.handle('template:get', async (_event, templateId: number) => {
    return registry.getTemplate(templateId);
  });

  // Get template by name
  ipcMain.handle('template:getByName', async (_event, name: string) => {
    return registry.getTemplateByName(name);
  });

  // Get all templates
  ipcMain.handle('template:getAll', async () => {
    return registry.getAllTemplates();
  });

  // Update template
  ipcMain.handle('template:update', async (_event, templateId: number, updates: {
    name?: string;
    description?: string | null;
    settings?: ProjectSettings;
    agents?: Array<{ agentId: number; priority: number; settings?: ProjectAgentSettings }>;
  }) => {
    return registry.updateTemplate(templateId, updates);
  });

  // Delete template
  ipcMain.handle('template:delete', async (_event, templateId: number) => {
    registry.removeTemplate(templateId);
    return true;
  });

  // Apply template to project
  ipcMain.handle('template:apply', async (_event, projectId: number, templateId: number) => {
    return registry.applyTemplate(projectId, templateId);
  });

  // Create template from project
  ipcMain.handle('template:createFromProject', async (_event, options: {
    projectId: number;
    templateName: string;
    description?: string;
  }) => {
    return registry.createTemplateFromExistingProject(
      options.projectId,
      options.templateName,
      options.description
    );
  });
}

// ============================================================================
// COORDINATION HANDLERS
// ============================================================================

export function registerCoordinationHandlers(): void {
  const coordinator = getProjectCoordinator();

  // Register cross-project agent
  ipcMain.handle('coordinator:registerAgent', async (_event, options: {
    agentId: number;
    agentName: string;
    projectIds: number[];
  }) => {
    return coordinator.registerCrossProjectAgent(
      options.agentId,
      options.agentName,
      options.projectIds
    );
  });

  // Unregister cross-project agent
  ipcMain.handle('coordinator:unregisterAgent', async (_event, agentId: number) => {
    coordinator.unregisterCrossProjectAgent(agentId);
    return true;
  });

  // Get cross-project agent
  ipcMain.handle('coordinator:getAgent', async (_event, agentId: number) => {
    return coordinator.getCrossProjectAgent(agentId);
  });

  // Get all cross-project agents
  ipcMain.handle('coordinator:getAllAgents', async () => {
    return coordinator.getAllCrossProjectAgents();
  });

  // Get agents for project
  ipcMain.handle('coordinator:getAgentsForProject', async (_event, projectId: number) => {
    return coordinator.getAgentsForProject(projectId);
  });

  // Transition agent to project
  ipcMain.handle('coordinator:transitionAgent', async (_event, agentId: number, targetProjectId: number) => {
    return coordinator.transitionAgentToProject(agentId, targetProjectId);
  });

  // Update agent status
  ipcMain.handle('coordinator:updateAgentStatus', async (_event, agentId: number, status: 'idle' | 'active' | 'transitioning') => {
    coordinator.updateAgentStatus(agentId, status);
    return true;
  });

  // Share skill across projects
  ipcMain.handle('coordinator:shareSkill', async (_event, options: {
    skillId: number;
    skillName: string;
    projectIds: number[];
    settings?: Record<string, unknown>;
  }) => {
    return coordinator.shareSkillAcrossProjects(
      options.skillId,
      options.skillName,
      options.projectIds,
      options.settings
    );
  });

  // Unshare skill from projects
  ipcMain.handle('coordinator:unshareSkill', async (_event, skillId: number, projectIds: number[]) => {
    coordinator.unshareSkillFromProjects(skillId, projectIds);
    return true;
  });

  // Get shared skill config
  ipcMain.handle('coordinator:getSharedSkill', async (_event, skillId: number) => {
    return coordinator.getSharedSkillConfig(skillId);
  });

  // Get all shared skills
  ipcMain.handle('coordinator:getAllSharedSkills', async () => {
    return coordinator.getAllSharedSkillConfigs();
  });

  // Get shared skills for project
  ipcMain.handle('coordinator:getSharedSkillsForProject', async (_event, projectId: number) => {
    return coordinator.getSharedSkillsForProject(projectId);
  });

  // Update shared skill settings
  ipcMain.handle('coordinator:updateSharedSkillSettings', async (_event, skillId: number, settings: Record<string, unknown>) => {
    return coordinator.updateSharedSkillSettings(skillId, settings);
  });

  // Toggle shared skill
  ipcMain.handle('coordinator:toggleSharedSkill', async (_event, skillId: number, enabled: boolean) => {
    coordinator.setSharedSkillEnabled(skillId, enabled);
    return true;
  });

  // Get project state
  ipcMain.handle('coordinator:getProjectState', async (_event, projectId: number) => {
    return coordinator.getProjectState(projectId);
  });

  // Update project state
  ipcMain.handle('coordinator:updateProjectState', async (_event, projectId: number, updates: {
    activeAgents?: number[];
    pendingSkills?: number[];
    sessionId?: string | null;
  }) => {
    return coordinator.updateProjectState(projectId, updates);
  });

  // Sync project states
  ipcMain.handle('coordinator:syncStates', async (_event, sourceProjectId: number, targetProjectIds: number[]) => {
    coordinator.syncProjectStates(sourceProjectId, targetProjectIds);
    return true;
  });

  // Get all project states
  ipcMain.handle('coordinator:getAllStates', async () => {
    return coordinator.getAllProjectStates();
  });

  // Broadcast to projects
  ipcMain.handle('coordinator:broadcast', async (_event, options: {
    type: string;
    data: Record<string, unknown>;
    targetProjectIds: number[];
    sourceProjectId?: number;
  }) => {
    return coordinator.broadcastToProjects(
      options.type,
      options.data,
      options.targetProjectIds,
      options.sourceProjectId
    );
  });

  // Broadcast to all projects
  ipcMain.handle('coordinator:broadcastAll', async (_event, options: {
    type: string;
    data: Record<string, unknown>;
    sourceProjectId?: number;
  }) => {
    return coordinator.broadcastToAllProjects(
      options.type,
      options.data,
      options.sourceProjectId
    );
  });

  // Get pending events for project
  ipcMain.handle('coordinator:getPendingEvents', async (_event, projectId: number) => {
    return coordinator.getPendingEventsForProject(projectId);
  });

  // Mark event handled
  ipcMain.handle('coordinator:markEventHandled', async (_event, eventId: string) => {
    coordinator.markEventHandled(eventId);
    return true;
  });

  // Get coordination status
  ipcMain.handle('coordinator:getStatus', async () => {
    return coordinator.getStatus();
  });
}
