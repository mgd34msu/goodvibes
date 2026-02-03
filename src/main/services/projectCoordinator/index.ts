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
import { Logger } from '../logger.js';
import { getProjectRegistry } from '../projectRegistry/index.js';

import type { CoordinationStatus } from './types.js';
import {
  isInitialized,
  setInitialized,
  setEventEmitter,
  ensureEventEmitter,
  getCrossProjectAgentCount,
  getSharedSkillConfigCount,
  getPendingEventCount,
  getAllProjectIds,
} from './state.js';

import {
  registerCrossProjectAgent,
  unregisterCrossProjectAgent,
  getCrossProjectAgent,
  getAllCrossProjectAgents,
  getAgentsForProject,
  transitionAgentToProject,
  updateAgentStatus,
  removeProjectFromAgents,
  cleanupStaleAgents,
} from './agents.js';

import {
  shareSkillAcrossProjects,
  unshareSkillFromProjects,
  getSharedSkillConfig,
  getAllSharedSkillConfigs,
  getSharedSkillsForProject,
  updateSharedSkillSettings,
  setSharedSkillEnabled,
  removeProjectFromSkills,
} from './skills.js';

import {
  getProjectState,
  updateProjectState,
  getAllProjectStates,
  syncProjectStates,
  removeProjectState,
  updateProjectSessionId,
  clearSessionFromStates,
} from './sync.js';

import {
  broadcastToProjects,
  broadcastToAllProjects,
  getPendingEventsForProject,
  markEventHandled,
  cleanupOldEvents,
} from './events.js';

const logger = new Logger('ProjectCoordinator');

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize the project coordinator service
 */
export function initProjectCoordinator(emitter?: EventEmitter): void {
  if (isInitialized()) {
    logger.debug('Project coordinator already initialized');
    return;
  }

  const eventEmitter = emitter || new EventEmitter();
  setEventEmitter(eventEmitter);

  // Subscribe to project registry events
  const registry = getProjectRegistry();
  const registryEmitter = registry.getEventEmitter();

  registryEmitter.on('project:*', handleProjectRegistryEvent);

  setInitialized(true);
  logger.info('Project coordinator service initialized');
}

/**
 * Get the event emitter
 */
export function getCoordinatorEventEmitter(): EventEmitter {
  return ensureEventEmitter();
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
        removeProjectState(data.projectId);
        removeProjectFromAgents(data.projectId);
        removeProjectFromSkills(data.projectId);
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
        updateProjectSessionId(data.projectId, data.sessionId);
      }
      break;

    case 'session:completed':
      if (typeof data.sessionId === 'string') {
        clearSessionFromStates(data.sessionId);
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
    initialized: isInitialized(),
    crossProjectAgentCount: getCrossProjectAgentCount(),
    sharedSkillCount: getSharedSkillConfigCount(),
    pendingEventCount: getPendingEventCount(),
    activeProjects: getAllProjectIds(),
  };
}

/**
 * Clean up stale data
 */
export function cleanup(): void {
  cleanupOldEvents();
  cleanupStaleAgents();
  logger.debug('Project coordinator cleanup completed');
}

// ============================================================================
// SINGLETON ACCESSOR
// ============================================================================

/** Type for the ProjectCoordinator singleton instance */
export type ProjectCoordinatorInstance = {
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
};

let instance: ProjectCoordinatorInstance | null = null;

export function getProjectCoordinator(): ProjectCoordinatorInstance {
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

// ============================================================================
// RE-EXPORTS - Maintain backward compatibility
// ============================================================================

// Re-export types
export type {
  CrossProjectAgent,
  SharedSkillConfig,
  ProjectState,
  ProjectEvent,
  CoordinationStatus,
  AgentStatus,
} from './types.js';

// Re-export agent functions
export {
  registerCrossProjectAgent,
  unregisterCrossProjectAgent,
  getCrossProjectAgent,
  getAllCrossProjectAgents,
  getAgentsForProject,
  transitionAgentToProject,
  updateAgentStatus,
} from './agents.js';

// Re-export skill functions
export {
  shareSkillAcrossProjects,
  unshareSkillFromProjects,
  getSharedSkillConfig,
  getAllSharedSkillConfigs,
  getSharedSkillsForProject,
  updateSharedSkillSettings,
  setSharedSkillEnabled,
} from './skills.js';

// Re-export sync functions
export {
  getProjectState,
  updateProjectState,
  getAllProjectStates,
  syncProjectStates,
} from './sync.js';

// Re-export event functions
export {
  broadcastToProjects,
  broadcastToAllProjects,
  getPendingEventsForProject,
  markEventHandled,
} from './events.js';
