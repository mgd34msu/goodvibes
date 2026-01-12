// ============================================================================
// PROJECT COORDINATOR SERVICE - Cross-project coordination
// ============================================================================
//
// This service manages agents working across multiple projects,
// shares skill configurations, synchronizes project state,
// and broadcasts project events.
//
// ============================================================================

import { EventEmitter } from 'events';
import { Logger } from './logger.js';
import { getProjectRegistry } from './projectRegistry.js';
import { formatTimestamp } from '../../shared/dateUtils.js';

const logger = new Logger('ProjectCoordinator');

// ============================================================================
// TYPES
// ============================================================================

/**
 * Agent working across projects
 */
export interface CrossProjectAgent {
  agentId: number;
  agentName: string;
  projectIds: number[];
  currentProjectId: number | null;
  status: 'idle' | 'active' | 'transitioning';
  lastActivity: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Shared skill configuration
 */
export interface SharedSkillConfig {
  skillId: number;
  skillName: string;
  sharedAcross: number[]; // project IDs
  settings: Record<string, unknown>;
  enabled: boolean;
  lastModified: Date;
}

/**
 * Project state for synchronization
 */
export interface ProjectState {
  projectId: number;
  projectPath: string;
  activeAgents: number[];
  pendingSkills: number[];
  sessionId: string | null;
  lastSync: Date;
  version: number;
}

/**
 * Project event
 */
export interface ProjectEvent {
  id: string;
  type: string;
  sourceProjectId: number | null;
  targetProjectIds: number[];
  data: Record<string, unknown>;
  timestamp: Date;
  handled: boolean;
}

/**
 * Coordination status
 */
export interface CoordinationStatus {
  initialized: boolean;
  crossProjectAgentCount: number;
  sharedSkillCount: number;
  pendingEventCount: number;
  activeProjects: number[];
}

// ============================================================================
// SERVICE STATE
// ============================================================================

let crossProjectAgents: Map<number, CrossProjectAgent> = new Map();
let sharedSkillConfigs: Map<number, SharedSkillConfig> = new Map();
let projectStates: Map<number, ProjectState> = new Map();
let eventQueue: ProjectEvent[] = [];
let eventEmitter: EventEmitter | null = null;
let initialized = false;

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize the project coordinator service
 */
export function initProjectCoordinator(emitter?: EventEmitter): void {
  if (initialized) {
    logger.debug('Project coordinator already initialized');
    return;
  }

  eventEmitter = emitter || new EventEmitter();

  // Subscribe to project registry events
  const registry = getProjectRegistry();
  const registryEmitter = registry.getEventEmitter();

  registryEmitter.on('project:*', handleProjectRegistryEvent);

  initialized = true;
  logger.info('Project coordinator service initialized');
}

/**
 * Get the event emitter
 */
export function getCoordinatorEventEmitter(): EventEmitter {
  if (!eventEmitter) {
    eventEmitter = new EventEmitter();
  }
  return eventEmitter;
}

// ============================================================================
// CROSS-PROJECT AGENT MANAGEMENT
// ============================================================================

/**
 * Register an agent to work across multiple projects
 */
export function registerCrossProjectAgent(
  agentId: number,
  agentName: string,
  projectIds: number[]
): CrossProjectAgent {
  const existing = crossProjectAgents.get(agentId);

  const agent: CrossProjectAgent = {
    agentId,
    agentName,
    projectIds: existing ? [...new Set([...existing.projectIds, ...projectIds])] : projectIds,
    currentProjectId: existing?.currentProjectId || null,
    status: existing?.status || 'idle',
    lastActivity: new Date(),
    metadata: existing?.metadata,
  };

  crossProjectAgents.set(agentId, agent);
  emitEvent('coordinator:agent-registered', { agent });
  logger.info(`Registered cross-project agent: ${agentName} for ${projectIds.length} projects`);

  return agent;
}

/**
 * Unregister a cross-project agent
 */
export function unregisterCrossProjectAgent(agentId: number): void {
  const agent = crossProjectAgents.get(agentId);
  if (!agent) return;

  crossProjectAgents.delete(agentId);
  emitEvent('coordinator:agent-unregistered', { agentId, agentName: agent.agentName });
  logger.info(`Unregistered cross-project agent: ${agent.agentName}`);
}

/**
 * Get a cross-project agent
 */
export function getCrossProjectAgent(agentId: number): CrossProjectAgent | null {
  return crossProjectAgents.get(agentId) || null;
}

/**
 * Get all cross-project agents
 */
export function getAllCrossProjectAgents(): CrossProjectAgent[] {
  return Array.from(crossProjectAgents.values());
}

/**
 * Get agents working on a specific project
 */
export function getAgentsForProject(projectId: number): CrossProjectAgent[] {
  return Array.from(crossProjectAgents.values())
    .filter(agent => agent.projectIds.includes(projectId));
}

/**
 * Move an agent to a different project
 */
export function transitionAgentToProject(
  agentId: number,
  targetProjectId: number
): CrossProjectAgent | null {
  const agent = crossProjectAgents.get(agentId);
  if (!agent) {
    logger.warn(`Cannot transition unknown agent: ${agentId}`);
    return null;
  }

  if (!agent.projectIds.includes(targetProjectId)) {
    logger.warn(`Agent ${agentId} not registered for project ${targetProjectId}`);
    return null;
  }

  const previousProjectId = agent.currentProjectId;
  agent.status = 'transitioning';
  agent.lastActivity = new Date();

  // Save state for previous project
  if (previousProjectId !== null) {
    preserveAgentState(agentId, previousProjectId);
  }

  // Update agent
  agent.currentProjectId = targetProjectId;
  agent.status = 'active';

  emitEvent('coordinator:agent-transitioned', {
    agentId,
    agentName: agent.agentName,
    from: previousProjectId,
    to: targetProjectId,
  });

  logger.info(`Transitioned agent ${agent.agentName} to project ${targetProjectId}`);
  return agent;
}

/**
 * Update agent status
 */
export function updateAgentStatus(
  agentId: number,
  status: 'idle' | 'active' | 'transitioning'
): void {
  const agent = crossProjectAgents.get(agentId);
  if (agent) {
    agent.status = status;
    agent.lastActivity = new Date();
    emitEvent('coordinator:agent-status-changed', { agentId, status });
  }
}

/**
 * Preserve agent state before transition
 */
function preserveAgentState(agentId: number, projectId: number): void {
  const agent = crossProjectAgents.get(agentId);
  if (!agent) return;

  // Store metadata for resumption
  if (!agent.metadata) {
    agent.metadata = {};
  }
  agent.metadata[`project_${projectId}_state`] = {
    timestamp: formatTimestamp(),
    // Additional state could be preserved here
  };
}

// ============================================================================
// SHARED SKILL CONFIGURATION
// ============================================================================

/**
 * Share a skill configuration across projects
 */
export function shareSkillAcrossProjects(
  skillId: number,
  skillName: string,
  projectIds: number[],
  settings: Record<string, unknown> = {}
): SharedSkillConfig {
  const existing = sharedSkillConfigs.get(skillId);

  const config: SharedSkillConfig = {
    skillId,
    skillName,
    sharedAcross: existing
      ? [...new Set([...existing.sharedAcross, ...projectIds])]
      : projectIds,
    settings: { ...existing?.settings, ...settings },
    enabled: existing?.enabled ?? true,
    lastModified: new Date(),
  };

  sharedSkillConfigs.set(skillId, config);
  emitEvent('coordinator:skill-shared', { config });
  logger.info(`Shared skill ${skillName} across ${config.sharedAcross.length} projects`);

  return config;
}

/**
 * Unshare a skill from projects
 */
export function unshareSkillFromProjects(skillId: number, projectIds: number[]): void {
  const config = sharedSkillConfigs.get(skillId);
  if (!config) return;

  config.sharedAcross = config.sharedAcross.filter(id => !projectIds.includes(id));
  config.lastModified = new Date();

  if (config.sharedAcross.length === 0) {
    sharedSkillConfigs.delete(skillId);
  }

  emitEvent('coordinator:skill-unshared', { skillId, removedFrom: projectIds });
}

/**
 * Get shared skill configuration
 */
export function getSharedSkillConfig(skillId: number): SharedSkillConfig | null {
  return sharedSkillConfigs.get(skillId) || null;
}

/**
 * Get all shared skill configurations
 */
export function getAllSharedSkillConfigs(): SharedSkillConfig[] {
  return Array.from(sharedSkillConfigs.values());
}

/**
 * Get shared skills for a project
 */
export function getSharedSkillsForProject(projectId: number): SharedSkillConfig[] {
  return Array.from(sharedSkillConfigs.values())
    .filter(config => config.sharedAcross.includes(projectId));
}

/**
 * Update shared skill settings
 */
export function updateSharedSkillSettings(
  skillId: number,
  settings: Record<string, unknown>
): SharedSkillConfig | null {
  const config = sharedSkillConfigs.get(skillId);
  if (!config) return null;

  config.settings = { ...config.settings, ...settings };
  config.lastModified = new Date();

  emitEvent('coordinator:skill-updated', { config });
  return config;
}

/**
 * Enable/disable a shared skill
 */
export function setSharedSkillEnabled(skillId: number, enabled: boolean): void {
  const config = sharedSkillConfigs.get(skillId);
  if (config) {
    config.enabled = enabled;
    config.lastModified = new Date();
    emitEvent('coordinator:skill-toggled', { skillId, enabled });
  }
}

// ============================================================================
// PROJECT STATE SYNCHRONIZATION
// ============================================================================

/**
 * Get or create project state
 */
export function getProjectState(projectId: number): ProjectState | null {
  let state = projectStates.get(projectId);

  if (!state) {
    const registry = getProjectRegistry();
    const project = registry.getProject(projectId);
    if (!project) return null;

    state = {
      projectId,
      projectPath: project.path,
      activeAgents: [],
      pendingSkills: [],
      sessionId: null,
      lastSync: new Date(),
      version: 0,
    };
    projectStates.set(projectId, state);
  }

  return state;
}

/**
 * Update project state
 */
export function updateProjectState(
  projectId: number,
  updates: Partial<{
    activeAgents: number[];
    pendingSkills: number[];
    sessionId: string | null;
  }>
): ProjectState | null {
  const state = getProjectState(projectId);
  if (!state) return null;

  if (updates.activeAgents !== undefined) {
    state.activeAgents = updates.activeAgents;
  }
  if (updates.pendingSkills !== undefined) {
    state.pendingSkills = updates.pendingSkills;
  }
  if (updates.sessionId !== undefined) {
    state.sessionId = updates.sessionId;
  }

  state.lastSync = new Date();
  state.version += 1;

  emitEvent('coordinator:state-updated', { projectId, version: state.version });
  return state;
}

/**
 * Synchronize state between projects
 */
export function syncProjectStates(sourceProjectId: number, targetProjectIds: number[]): void {
  const sourceState = getProjectState(sourceProjectId);
  if (!sourceState) {
    logger.warn(`Cannot sync from unknown project: ${sourceProjectId}`);
    return;
  }

  for (const targetId of targetProjectIds) {
    const targetState = getProjectState(targetId);
    if (targetState) {
      // Sync shared skills
      const sharedSkills = getSharedSkillsForProject(sourceProjectId)
        .filter(s => s.sharedAcross.includes(targetId))
        .map(s => s.skillId);

      targetState.pendingSkills = [
        ...new Set([...targetState.pendingSkills, ...sharedSkills]),
      ];
      targetState.lastSync = new Date();
      targetState.version += 1;
    }
  }

  emitEvent('coordinator:states-synced', { source: sourceProjectId, targets: targetProjectIds });
  logger.debug(`Synced state from project ${sourceProjectId} to ${targetProjectIds.length} projects`);
}

/**
 * Get all active project states
 */
export function getAllProjectStates(): ProjectState[] {
  return Array.from(projectStates.values());
}

// ============================================================================
// EVENT BROADCASTING
// ============================================================================

/**
 * Broadcast an event to specific projects
 */
export function broadcastToProjects(
  type: string,
  data: Record<string, unknown>,
  targetProjectIds: number[],
  sourceProjectId?: number
): ProjectEvent {
  const event: ProjectEvent = {
    id: generateEventId(),
    type,
    sourceProjectId: sourceProjectId ?? null,
    targetProjectIds,
    data,
    timestamp: new Date(),
    handled: false,
  };

  eventQueue.push(event);
  processEventQueue();

  return event;
}

/**
 * Broadcast an event to all projects
 */
export function broadcastToAllProjects(
  type: string,
  data: Record<string, unknown>,
  sourceProjectId?: number
): ProjectEvent {
  const allProjectIds = Array.from(projectStates.keys());
  return broadcastToProjects(type, data, allProjectIds, sourceProjectId);
}

/**
 * Get pending events for a project
 */
export function getPendingEventsForProject(projectId: number): ProjectEvent[] {
  return eventQueue.filter(
    e => !e.handled && e.targetProjectIds.includes(projectId)
  );
}

/**
 * Mark an event as handled
 */
export function markEventHandled(eventId: string): void {
  const event = eventQueue.find(e => e.id === eventId);
  if (event) {
    event.handled = true;
  }
}

/**
 * Process event queue
 */
function processEventQueue(): void {
  const pendingEvents = eventQueue.filter(e => !e.handled);

  for (const event of pendingEvents) {
    for (const projectId of event.targetProjectIds) {
      emitEvent('coordinator:event-broadcast', {
        eventId: event.id,
        type: event.type,
        projectId,
        data: event.data,
      });
    }
  }

  // Clean up old handled events
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  eventQueue = eventQueue.filter(
    e => !e.handled || e.timestamp > oneHourAgo
  );
}

/**
 * Generate unique event ID
 */
function generateEventId(): string {
  return `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// ============================================================================
// PROJECT REGISTRY EVENT HANDLING
// ============================================================================

function handleProjectRegistryEvent(data: { event: string; [key: string]: unknown }): void {
  switch (data.event) {
    case 'project:registered': {
      // Initialize state for new project
      const project = data.project as { id?: number } | undefined;
      if (project && typeof project.id === 'number') {
        getProjectState(project.id);
      }
      break;
    }

    case 'project:removed':
      // Clean up state
      if (typeof data.projectId === 'number') {
        projectStates.delete(data.projectId);
        // Remove project from all cross-project agents
        for (const agent of crossProjectAgents.values()) {
          agent.projectIds = agent.projectIds.filter(id => id !== data.projectId);
          if (agent.currentProjectId === data.projectId) {
            agent.currentProjectId = null;
            agent.status = 'idle';
          }
        }
        // Remove project from shared skills
        for (const config of sharedSkillConfigs.values()) {
          config.sharedAcross = config.sharedAcross.filter(id => id !== data.projectId);
        }
      }
      break;

    case 'project:switched':
      // Handle project switch
      if (typeof data.projectId === 'number') {
        broadcastToAllProjects('project:focus-changed', {
          newFocus: data.projectId,
        }, data.projectId);
      }
      break;

    case 'session:started':
      if (typeof data.projectId === 'number' && typeof data.sessionId === 'string') {
        const state = getProjectState(data.projectId);
        if (state) {
          state.sessionId = data.sessionId;
          state.version += 1;
        }
      }
      break;

    case 'session:completed':
      if (typeof data.sessionId === 'string') {
        for (const state of projectStates.values()) {
          if (state.sessionId === data.sessionId) {
            state.sessionId = null;
            state.version += 1;
          }
        }
      }
      break;
  }
}

// ============================================================================
// STATUS AND MAINTENANCE
// ============================================================================

/**
 * Get coordination status
 */
export function getCoordinationStatus(): CoordinationStatus {
  return {
    initialized,
    crossProjectAgentCount: crossProjectAgents.size,
    sharedSkillCount: sharedSkillConfigs.size,
    pendingEventCount: eventQueue.filter(e => !e.handled).length,
    activeProjects: Array.from(projectStates.keys()),
  };
}

/**
 * Clean up stale data
 */
export function cleanup(): void {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  // Clean up old events
  eventQueue = eventQueue.filter(e => e.timestamp > oneHourAgo);

  // Clean up idle agents that haven't been active in a while
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  for (const [agentId, agent] of crossProjectAgents.entries()) {
    if (agent.status === 'idle' && agent.lastActivity < oneDayAgo) {
      crossProjectAgents.delete(agentId);
      logger.debug(`Cleaned up stale cross-project agent: ${agent.agentName}`);
    }
  }

  logger.debug('Project coordinator cleanup completed');
}

// ============================================================================
// EVENT HELPERS
// ============================================================================

function emitEvent(event: string, data: Record<string, unknown>): void {
  if (eventEmitter) {
    eventEmitter.emit(event, data);
    eventEmitter.emit('coordinator:*', { event, ...data });
  }
}

// ============================================================================
// SINGLETON ACCESSOR
// ============================================================================

let instance: {
  init: typeof initProjectCoordinator;
  getEventEmitter: typeof getCoordinatorEventEmitter;
  registerCrossProjectAgent: typeof registerCrossProjectAgent;
  unregisterCrossProjectAgent: typeof unregisterCrossProjectAgent;
  getCrossProjectAgent: typeof getCrossProjectAgent;
  getAllCrossProjectAgents: typeof getAllCrossProjectAgents;
  getAgentsForProject: typeof getAgentsForProject;
  transitionAgentToProject: typeof transitionAgentToProject;
  updateAgentStatus: typeof updateAgentStatus;
  shareSkillAcrossProjects: typeof shareSkillAcrossProjects;
  unshareSkillFromProjects: typeof unshareSkillFromProjects;
  getSharedSkillConfig: typeof getSharedSkillConfig;
  getAllSharedSkillConfigs: typeof getAllSharedSkillConfigs;
  getSharedSkillsForProject: typeof getSharedSkillsForProject;
  updateSharedSkillSettings: typeof updateSharedSkillSettings;
  setSharedSkillEnabled: typeof setSharedSkillEnabled;
  getProjectState: typeof getProjectState;
  updateProjectState: typeof updateProjectState;
  syncProjectStates: typeof syncProjectStates;
  getAllProjectStates: typeof getAllProjectStates;
  broadcastToProjects: typeof broadcastToProjects;
  broadcastToAllProjects: typeof broadcastToAllProjects;
  getPendingEventsForProject: typeof getPendingEventsForProject;
  markEventHandled: typeof markEventHandled;
  getStatus: typeof getCoordinationStatus;
  cleanup: typeof cleanup;
} | null = null;

export function getProjectCoordinator() {
  if (!instance) {
    instance = {
      init: initProjectCoordinator,
      getEventEmitter: getCoordinatorEventEmitter,
      registerCrossProjectAgent,
      unregisterCrossProjectAgent,
      getCrossProjectAgent,
      getAllCrossProjectAgents,
      getAgentsForProject,
      transitionAgentToProject,
      updateAgentStatus,
      shareSkillAcrossProjects,
      unshareSkillFromProjects,
      getSharedSkillConfig,
      getAllSharedSkillConfigs,
      getSharedSkillsForProject,
      updateSharedSkillSettings,
      setSharedSkillEnabled,
      getProjectState,
      updateProjectState,
      syncProjectStates,
      getAllProjectStates,
      broadcastToProjects,
      broadcastToAllProjects,
      getPendingEventsForProject,
      markEventHandled,
      getStatus: getCoordinationStatus,
      cleanup,
    };
  }
  return instance;
}

