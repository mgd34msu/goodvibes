// ============================================================================
// AGENT REGISTRY - Lifecycle operations (spawn, terminate, status)
// ============================================================================

import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../logger.js';
import {
  registerAgent,
  getAgent,
  updateAgentStatus,
  updateAgentActivity,
  completeAgent,
} from '../../database/primitives.js';
import type { AgentSpawnOptions } from './types.js';
import type { AgentRecord, AgentStatus } from '../../database/primitives.js';

const logger = new Logger('AgentRegistry:Lifecycle');

// ============================================================================
// SPAWN OPERATIONS
// ============================================================================

/**
 * Register a new agent that is being spawned
 */
export function spawnAgent(options: AgentSpawnOptions): AgentRecord {
  const id = uuidv4();

  const agent = registerAgent({
    id,
    name: options.name,
    cwd: options.cwd,
    pid: null, // Will be set when PTY is created
    parentId: options.parentId || null,
    templateId: options.templateId || null,
    initialPrompt: options.initialPrompt || null,
    sessionPath: options.sessionPath || null,
    status: 'spawning',
  });

  logger.info(`Agent spawned: ${agent.name} (${agent.id})`, {
    parentId: agent.parentId,
    templateId: agent.templateId,
  });

  return agent;
}

/**
 * Update agent with PID after PTY is created
 */
export function setAgentPid(agentId: string, pid: number): void {
  const agent = getAgent(agentId);
  if (!agent) {
    logger.warn(`Cannot set PID - agent not found: ${agentId}`);
    return;
  }

  // Update in database
  const db = require('../../database/index.js').getDatabase();
  db.prepare('UPDATE agent_registry SET pid = ? WHERE id = ?').run(pid, agentId);

  logger.debug(`Agent ${agentId} PID set to ${pid}`);
}

// ============================================================================
// STATUS TRANSITIONS
// ============================================================================

/**
 * Update agent status in database
 */
export function updateStatus(agentId: string, status: AgentStatus): void {
  updateAgentStatus(agentId, status);
  logger.debug(`Agent ${agentId} status updated to ${status}`);
}

/**
 * Mark agent as ready to receive input
 * Returns the updated agent or null if not found
 */
export function markAgentReady(agentId: string): AgentRecord | null {
  updateStatus(agentId, 'ready');
  return getAgent(agentId);
}

/**
 * Mark agent as actively processing
 * Returns { agent, statusChanged } indicating if status actually changed
 */
export function markAgentActive(agentId: string): { agent: AgentRecord | null; statusChanged: boolean } {
  const agent = getAgent(agentId);
  if (!agent) {
    return { agent: null, statusChanged: false };
  }

  if (agent.status !== 'active') {
    updateStatus(agentId, 'active');
    return { agent: getAgent(agentId), statusChanged: true };
  }

  // Just update activity timestamp
  updateAgentActivity(agentId);
  return { agent, statusChanged: false };
}

/**
 * Mark agent as idle (waiting for input)
 * Returns the updated agent or null if not found
 */
export function markAgentIdle(agentId: string): AgentRecord | null {
  updateStatus(agentId, 'idle');
  return getAgent(agentId);
}

/**
 * Mark agent as completed successfully
 * Returns the agent and whether it completed with success or error
 */
export function completeAgentTask(
  agentId: string,
  exitCode: number = 0
): { agent: AgentRecord | null; success: boolean } {
  completeAgent(agentId, exitCode);
  const agent = getAgent(agentId);

  if (agent) {
    logger.info(`Agent completed: ${agent.name} (${agent.id}) with exit code ${exitCode}`);
  }

  return { agent, success: exitCode === 0 };
}

/**
 * Mark agent as errored
 * Returns the updated agent or null if not found
 */
export function markAgentError(agentId: string, errorMessage: string): AgentRecord | null {
  updateAgentStatus(agentId, 'error', errorMessage);
  const agent = getAgent(agentId);

  if (agent) {
    logger.error(`Agent error: ${agent.name} (${agent.id})`, { error: errorMessage });
  }

  return agent;
}

/**
 * Terminate an agent
 * Returns the agent record for event emission
 */
export function terminateAgentById(agentId: string): AgentRecord | null {
  updateAgentStatus(agentId, 'terminated');
  const agent = getAgent(agentId);

  if (agent) {
    logger.info(`Agent terminated: ${agent.name} (${agent.id})`);
  }

  return agent;
}

/**
 * Record activity for an agent (updates lastActivity timestamp)
 * Returns the updated agent or null if not found
 */
export function recordAgentActivity(agentId: string): AgentRecord | null {
  updateAgentActivity(agentId);
  return getAgent(agentId);
}
