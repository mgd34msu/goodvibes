// ============================================================================
// PROJECT COORDINATOR - Project state synchronization
// ============================================================================
//
// Handles project state management and synchronization between projects.
//
// ============================================================================

import { Logger } from '../logger.js';
import { getProjectRegistry } from '../projectRegistry/index.js';
import type { ProjectState } from './types.js';
import {
  getProjectStateFromMap,
  setProjectState,
  deleteProjectState,
  getAllProjectStatesFromMap,
} from './state.js';
import { emitEvent } from './events.js';
import { getSharedSkillsForProject } from './skills.js';

const logger = new Logger('ProjectCoordinator:Sync');

// ============================================================================
// PROJECT STATE MANAGEMENT
// ============================================================================

/**
 * Get or create project state
 */
export function getProjectState(projectId: number): ProjectState | null {
  let state = getProjectStateFromMap(projectId);

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
    setProjectState(projectId, state);
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
 * Get all active project states
 */
export function getAllProjectStates(): ProjectState[] {
  return getAllProjectStatesFromMap();
}

// ============================================================================
// SYNCHRONIZATION
// ============================================================================

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

// ============================================================================
// PROJECT STATE CLEANUP
// ============================================================================

/**
 * Remove project state
 * Called when a project is removed from the registry
 */
export function removeProjectState(projectId: number): void {
  deleteProjectState(projectId);
}

/**
 * Update session ID for a project state
 */
export function updateProjectSessionId(projectId: number, sessionId: string | null): void {
  const state = getProjectState(projectId);
  if (state) {
    state.sessionId = sessionId;
    state.version += 1;
  }
}

/**
 * Clear session ID from all states matching a session
 */
export function clearSessionFromStates(sessionId: string): void {
  for (const state of getAllProjectStatesFromMap()) {
    if (state.sessionId === sessionId) {
      state.sessionId = null;
      state.version += 1;
    }
  }
}
