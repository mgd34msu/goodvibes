// ============================================================================
// PROJECT COORDINATOR - Cross-project agent management
// ============================================================================
//
// Handles registration, transitions, and status updates for agents
// that work across multiple projects.
//
// ============================================================================

import { Logger } from '../logger.js';
import { formatTimestamp } from '../../../shared/dateUtils.js';
import type { CrossProjectAgent, AgentStatus } from './types.js';
import {
  getCrossProjectAgent as getAgentFromState,
  setCrossProjectAgent,
  deleteCrossProjectAgent,
  getAllCrossProjectAgents as getAllAgentsFromState,
} from './state.js';
import { emitEvent } from './events.js';

const logger = new Logger('ProjectCoordinator:Agents');

// ============================================================================
// AGENT REGISTRATION
// ============================================================================

/**
 * Register an agent to work across multiple projects
 */
export function registerCrossProjectAgent(
  agentId: number,
  agentName: string,
  projectIds: number[]
): CrossProjectAgent {
  const existing = getAgentFromState(agentId);

  const agent: CrossProjectAgent = {
    agentId,
    agentName,
    projectIds: existing ? [...new Set([...existing.projectIds, ...projectIds])] : projectIds,
    currentProjectId: existing?.currentProjectId || null,
    status: existing?.status || 'idle',
    lastActivity: new Date(),
    metadata: existing?.metadata,
  };

  setCrossProjectAgent(agentId, agent);
  emitEvent('coordinator:agent-registered', { agent });
  logger.info(`Registered cross-project agent: ${agentName} for ${projectIds.length} projects`);

  return agent;
}

/**
 * Unregister a cross-project agent
 */
export function unregisterCrossProjectAgent(agentId: number): void {
  const agent = getAgentFromState(agentId);
  if (!agent) return;

  deleteCrossProjectAgent(agentId);
  emitEvent('coordinator:agent-unregistered', { agentId, agentName: agent.agentName });
  logger.info(`Unregistered cross-project agent: ${agent.agentName}`);
}

// ============================================================================
// AGENT QUERIES
// ============================================================================

/**
 * Get a cross-project agent
 */
export function getCrossProjectAgent(agentId: number): CrossProjectAgent | null {
  return getAgentFromState(agentId) || null;
}

/**
 * Get all cross-project agents
 */
export function getAllCrossProjectAgents(): CrossProjectAgent[] {
  return getAllAgentsFromState();
}

/**
 * Get agents working on a specific project
 */
export function getAgentsForProject(projectId: number): CrossProjectAgent[] {
  return getAllAgentsFromState()
    .filter(agent => agent.projectIds.includes(projectId));
}

// ============================================================================
// AGENT TRANSITIONS
// ============================================================================

/**
 * Move an agent to a different project
 */
export function transitionAgentToProject(
  agentId: number,
  targetProjectId: number
): CrossProjectAgent | null {
  const agent = getAgentFromState(agentId);
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
  status: AgentStatus
): void {
  const agent = getAgentFromState(agentId);
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
  const agent = getAgentFromState(agentId);
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
// AGENT CLEANUP
// ============================================================================

/**
 * Remove a project from all agents' project lists
 * Called when a project is removed from the registry
 */
export function removeProjectFromAgents(projectId: number): void {
  for (const agent of getAllAgentsFromState()) {
    agent.projectIds = agent.projectIds.filter(id => id !== projectId);
    if (agent.currentProjectId === projectId) {
      agent.currentProjectId = null;
      agent.status = 'idle';
    }
  }
}

/**
 * Cleanup stale agents that haven't been active
 */
export function cleanupStaleAgents(maxIdleMs: number = 24 * 60 * 60 * 1000): void {
  const cutoff = new Date(Date.now() - maxIdleMs);

  for (const agent of getAllAgentsFromState()) {
    if (agent.status === 'idle' && agent.lastActivity < cutoff) {
      deleteCrossProjectAgent(agent.agentId);
      logger.debug(`Cleaned up stale cross-project agent: ${agent.agentName}`);
    }
  }
}
