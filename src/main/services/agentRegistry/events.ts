// ============================================================================
// AGENT REGISTRY - Event handling and background tasks
// ============================================================================

import { Logger } from '../logger.js';
import {
  getAgent,
  getActiveAgents,
  findAgentBySession,
  cleanupStaleAgents,
  cleanupGarbageAgents,
} from '../../database/primitives.js';
import { getHookServer } from '../hookServer.js';
import {
  CLEANUP_INTERVAL_MS,
  ACTIVITY_CHECK_INTERVAL_MS,
  IDLE_THRESHOLD_MS,
  STALE_CHECK_INTERVAL_MS,
  STALE_AGENT_THRESHOLD_MS,
  GARBAGE_CLEANUP_INTERVAL_MS,
  SESSION_MAP_VALIDATION_INTERVAL_MS,
} from './types.js';
import type { HookServerListenerRef } from './types.js';
import type { AgentRecord } from '../../database/primitives.js';

const logger = new Logger('AgentRegistry:Events');

// ============================================================================
// SESSION MAP MANAGEMENT
// ============================================================================

/**
 * Session ID to Agent ID mapping for quick lookup
 */
const sessionToAgentMap: Map<string, string> = new Map();

/**
 * Get agent ID from session ID via cache
 */
export function getAgentIdFromSession(sessionId: string): string | undefined {
  return sessionToAgentMap.get(sessionId);
}

/**
 * Set session to agent mapping
 */
export function setSessionMapping(sessionId: string, agentId: string): void {
  sessionToAgentMap.set(sessionId, agentId);
  logger.debug(`Mapped session ${sessionId} to agent ${agentId}`);
}

/**
 * Remove session mapping
 */
export function removeSessionMapping(sessionId: string): void {
  sessionToAgentMap.delete(sessionId);
  logger.debug(`Removed session mapping for ${sessionId}`);
}

/**
 * Clear all session mappings for a specific agent (CRIT-003)
 */
export function clearSessionMappingsForAgent(agentId: string): void {
  for (const [sessionId, mappedAgentId] of sessionToAgentMap.entries()) {
    if (mappedAgentId === agentId) {
      sessionToAgentMap.delete(sessionId);
      logger.debug(`Cleared session mapping ${sessionId} for terminated agent ${agentId}`);
    }
  }
}

/**
 * Clear all session mappings
 */
export function clearAllSessionMappings(): void {
  sessionToAgentMap.clear();
}

/**
 * Get current session map size (for testing/debugging)
 */
export function getSessionMapSize(): number {
  return sessionToAgentMap.size;
}

// ============================================================================
// SESSION MAP VALIDATION (CRIT-003)
// ============================================================================

/**
 * Validate sessionToAgentMap entries by cross-referencing with active sessions
 * Removes orphaned entries where:
 * - The mapped agent no longer exists
 * - The mapped agent is in a terminal state (completed, terminated, error)
 * This prevents memory leaks from sessions that terminated abnormally.
 */
export function validateSessionMap(): number {
  if (sessionToAgentMap.size === 0) {
    return 0;
  }

  const activeAgentIds = new Set(
    getActiveAgents().map(agent => agent.id)
  );

  let cleanedCount = 0;
  const entriesToRemove: string[] = [];

  for (const [sessionId, agentId] of sessionToAgentMap.entries()) {
    const agent = getAgent(agentId);

    // Remove if agent doesn't exist or is in a terminal state
    if (!agent) {
      entriesToRemove.push(sessionId);
      cleanedCount++;
      logger.debug(`Removing orphaned session mapping ${sessionId} - agent ${agentId} no longer exists`);
    } else if (!activeAgentIds.has(agentId)) {
      // Agent exists but is not active (completed, terminated, or error)
      entriesToRemove.push(sessionId);
      cleanedCount++;
      logger.debug(`Removing stale session mapping ${sessionId} - agent ${agentId} is in terminal state (${agent.status})`);
    }
  }

  // Remove entries outside of iteration to avoid modifying map while iterating
  for (const sessionId of entriesToRemove) {
    sessionToAgentMap.delete(sessionId);
  }

  if (cleanedCount > 0) {
    logger.info(`Session map validation: cleaned up ${cleanedCount} orphaned entries, ${sessionToAgentMap.size} remaining`);
  }

  return cleanedCount;
}

// ============================================================================
// HOOK SERVER INTEGRATION
// ============================================================================

/**
 * Store hookServer listener references for proper cleanup (HIGH-003)
 */
let hookServerListeners: HookServerListenerRef[] = [];

/**
 * Wire up hook server events to update agent state
 * Returns callbacks for agent lifecycle events
 */
export function wireUpHookEvents(callbacks: {
  onAgentSpawned: (agent: AgentRecord) => void;
  onAgentCompleted: (agent: AgentRecord) => void;
}): void {
  try {
    const hookServer = getHookServer();

    // Clear any existing listeners before adding new ones
    removeHookServerListeners();

    // Define listeners as named functions so we can remove them later
    const onSessionStart = ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        // Record session-to-agent mapping
        const agent = findAgentBySession(sessionId);
        if (agent) {
          setSessionMapping(sessionId, agent.id);
        }
      }
    };

    const onSessionEnd = ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        removeSessionMapping(sessionId);
      }
    };

    const onAgentStart = ({ agentName, sessionId }: { agentName?: string; sessionId?: string }) => {
      if (sessionId) {
        const agent = findAgentBySession(sessionId);
        if (agent) {
          setSessionMapping(sessionId, agent.id);
          callbacks.onAgentSpawned(agent);
          logger.debug(`Agent started: ${agentName} (${agent.id})`);
        }
      }
    };

    const onAgentStop = ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        const agent = findAgentBySession(sessionId);
        if (agent) {
          callbacks.onAgentCompleted(agent);
        }
        removeSessionMapping(sessionId);
      }
    };

    // Register listeners and store references for cleanup
    hookServer.on('session:start', onSessionStart);
    hookServerListeners.push({ event: 'session:start', listener: onSessionStart as (...args: unknown[]) => void });

    hookServer.on('session:end', onSessionEnd);
    hookServerListeners.push({ event: 'session:end', listener: onSessionEnd as (...args: unknown[]) => void });

    hookServer.on('agent:start', onAgentStart);
    hookServerListeners.push({ event: 'agent:start', listener: onAgentStart as (...args: unknown[]) => void });

    hookServer.on('agent:stop', onAgentStop);
    hookServerListeners.push({ event: 'agent:stop', listener: onAgentStop as (...args: unknown[]) => void });

    logger.info('Hook events wired up successfully');
  } catch (error) {
    logger.warn('Could not wire up hook events (hook server may not be initialized yet):', error);
  }
}

/**
 * Remove all hookServer listeners that were registered by this service (HIGH-003)
 */
export function removeHookServerListeners(): void {
  if (hookServerListeners.length === 0) {
    return;
  }

  try {
    const hookServer = getHookServer();
    const count = hookServerListeners.length;
    for (const { event, listener } of hookServerListeners) {
      hookServer.off(event, listener);
      logger.debug(`Removed hookServer listener for ${event}`);
    }
    hookServerListeners = [];
    logger.info(`Removed ${count} hookServer listeners`);
  } catch (error) {
    // Hook server may already be shut down, which is fine
    logger.debug('Could not remove hookServer listeners (server may be shut down):', error);
    hookServerListeners = [];
  }
}

// ============================================================================
// BACKGROUND TASK HANDLERS
// ============================================================================

/**
 * Perform cleanup of stale agents
 */
export function performCleanup(): number {
  const cleaned = cleanupStaleAgents();
  if (cleaned > 0) {
    logger.info(`Cleaned up ${cleaned} stale agents`);
  }
  return cleaned;
}

/**
 * Clean up garbage agent entries (tools mistakenly registered as agents)
 */
export function performGarbageCleanup(): number {
  const cleaned = cleanupGarbageAgents();
  if (cleaned > 0) {
    logger.info(`Cleaned up ${cleaned} garbage agent entries`);
  }
  return cleaned;
}

/**
 * Check agent activity and return agents that should transition to idle
 */
export function checkAgentActivity(): AgentRecord[] {
  const activeAgents = getActiveAgents();
  const now = Date.now();
  const agentsToMarkIdle: AgentRecord[] = [];

  for (const agent of activeAgents) {
    if (agent.status === 'active') {
      const lastActivity = new Date(agent.lastActivity).getTime();
      const idleTime = now - lastActivity;

      if (idleTime > IDLE_THRESHOLD_MS) {
        agentsToMarkIdle.push(agent);
      }
    }
  }

  return agentsToMarkIdle;
}

/**
 * Find stale agents that should be auto-terminated (30 minutes idle)
 * Returns list of agents to terminate
 */
export function findStaleAgentsToTerminate(): AgentRecord[] {
  const activeAgents = getActiveAgents();
  const now = Date.now();
  const agentsToTerminate: AgentRecord[] = [];

  for (const agent of activeAgents) {
    // Only auto-terminate agents in 'idle' status
    if (agent.status === 'idle') {
      const lastActivity = new Date(agent.lastActivity).getTime();
      const idleTime = now - lastActivity;

      if (idleTime > STALE_AGENT_THRESHOLD_MS) {
        logger.info(`Marking stale agent for termination: ${agent.name} (${agent.id}), idle for ${Math.round(idleTime / 60000)} minutes`);
        agentsToTerminate.push(agent);
      }
    }
  }

  return agentsToTerminate;
}

// ============================================================================
// INTERVAL MANAGEMENT
// ============================================================================

export interface IntervalHandles {
  cleanupInterval: NodeJS.Timeout | null;
  activityCheckInterval: NodeJS.Timeout | null;
  staleCheckInterval: NodeJS.Timeout | null;
  garbageCleanupInterval: NodeJS.Timeout | null;
  sessionMapValidationInterval: NodeJS.Timeout | null;
}

/**
 * Start all background intervals
 */
export function startIntervals(callbacks: {
  onCleanup: () => void;
  onActivityCheck: () => void;
  onStaleCheck: () => void;
  onGarbageCleanup: () => void;
  onSessionMapValidation: () => void;
}): IntervalHandles {
  return {
    cleanupInterval: setInterval(callbacks.onCleanup, CLEANUP_INTERVAL_MS),
    activityCheckInterval: setInterval(callbacks.onActivityCheck, ACTIVITY_CHECK_INTERVAL_MS),
    staleCheckInterval: setInterval(callbacks.onStaleCheck, STALE_CHECK_INTERVAL_MS),
    garbageCleanupInterval: setInterval(callbacks.onGarbageCleanup, GARBAGE_CLEANUP_INTERVAL_MS),
    sessionMapValidationInterval: setInterval(callbacks.onSessionMapValidation, SESSION_MAP_VALIDATION_INTERVAL_MS),
  };
}

/**
 * Stop all background intervals
 */
export function stopIntervals(handles: IntervalHandles): void {
  if (handles.cleanupInterval) {
    clearInterval(handles.cleanupInterval);
  }
  if (handles.activityCheckInterval) {
    clearInterval(handles.activityCheckInterval);
  }
  if (handles.staleCheckInterval) {
    clearInterval(handles.staleCheckInterval);
  }
  if (handles.garbageCleanupInterval) {
    clearInterval(handles.garbageCleanupInterval);
  }
  if (handles.sessionMapValidationInterval) {
    clearInterval(handles.sessionMapValidationInterval);
  }
}
