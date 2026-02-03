// ============================================================================
// AGENT REGISTRY SERVICE - Main exports and singleton
// ============================================================================
//
// This module provides agent lifecycle tracking for the application.
// It manages spawning, status transitions, queries, and cleanup of agents.
//
// ============================================================================

import { EventEmitter } from 'events';
import { Logger } from '../logger.js';

// Import from sub-modules
import type {
  AgentSpawnOptions,
  AgentTreeNode,
  AgentStats,
} from './types.js';

import {
  spawnAgent,
  setAgentPid,
  markAgentReady,
  markAgentActive,
  markAgentIdle,
  completeAgentTask,
  markAgentError,
  terminateAgentById,
  recordAgentActivity,
} from './lifecycle.js';

import {
  getAgentById,
  agentExists,
  getAgentBySessionId,
  listActiveAgents,
  listAllAgents,
  getAgentChildren,
  getRootAgents,
  getAgentsByStatus,
  findAgentsByName,
  buildAgentTree,
  getAgentSubtree,
  getAgentAncestors,
  getAgentDescendants,
  getAgentStats,
  clearAllAgentsFromRegistry,
  runGarbageCleanup,
} from './queries.js';

import {
  getAgentIdFromSession,
  clearSessionMappingsForAgent,
  clearAllSessionMappings,
  wireUpHookEvents,
  removeHookServerListeners,
  performCleanup,
  performGarbageCleanup,
  checkAgentActivity,
  findStaleAgentsToTerminate,
  validateSessionMap,
  startIntervals,
  stopIntervals,
  type IntervalHandles,
} from './events.js';

import type { AgentRecord, AgentStatus } from '../../database/primitives.js';

const logger = new Logger('AgentRegistry');

// ============================================================================
// AGENT REGISTRY SERVICE CLASS
// ============================================================================

class AgentRegistryService extends EventEmitter {
  private intervalHandles: IntervalHandles = {
    cleanupInterval: null,
    activityCheckInterval: null,
    staleCheckInterval: null,
    garbageCleanupInterval: null,
    sessionMapValidationInterval: null,
  };

  constructor() {
    super();
    this.setMaxListeners(100); // Allow many listeners for agent events
  }

  // ==========================================================================
  // INITIALIZATION
  // ==========================================================================

  init(): void {
    logger.info('Initializing Agent Registry Service');

    // FIRST: Clean up garbage entries from previous runs
    performGarbageCleanup();

    // Start all background intervals
    this.intervalHandles = startIntervals({
      onCleanup: () => performCleanup(),
      onActivityCheck: () => this.checkAgentActivity(),
      onStaleCheck: () => this.terminateStaleAgents(),
      onGarbageCleanup: () => performGarbageCleanup(),
      onSessionMapValidation: () => validateSessionMap(),
    });

    // Initial cleanup of any stale agents from previous sessions
    performCleanup();

    // Initial stale agent termination check
    this.terminateStaleAgents();

    // Wire up hook server events for agent lifecycle
    wireUpHookEvents({
      onAgentSpawned: (agent) => this.emit('agent:spawned', agent),
      onAgentCompleted: (agent) => this.emit('agent:completed', agent),
    });

    logger.info('Agent Registry Service initialized');
  }

  shutdown(): void {
    logger.info('Shutting down Agent Registry Service');

    // Stop all intervals
    stopIntervals(this.intervalHandles);
    this.intervalHandles = {
      cleanupInterval: null,
      activityCheckInterval: null,
      staleCheckInterval: null,
      garbageCleanupInterval: null,
      sessionMapValidationInterval: null,
    };

    // Remove hookServer listeners before clearing session map (HIGH-003)
    removeHookServerListeners();

    // Clear session map
    clearAllSessionMappings();

    // Mark all active agents as terminated
    const activeAgents = this.getActiveAgents();
    for (const agent of activeAgents) {
      this.terminateAgent(agent.id);
    }

    this.removeAllListeners();
    logger.info('Agent Registry Service shut down');
  }

  // ==========================================================================
  // AGENT LIFECYCLE
  // ==========================================================================

  /**
   * Register a new agent that is being spawned
   */
  spawn(options: AgentSpawnOptions): AgentRecord {
    const agent = spawnAgent(options);
    this.emit('agent:spawned', agent);
    return agent;
  }

  /**
   * Update agent with PID after PTY is created
   */
  setPid(agentId: string, pid: number): void {
    setAgentPid(agentId, pid);
  }

  /**
   * Mark agent as ready to receive input
   */
  markReady(agentId: string): void {
    const agent = markAgentReady(agentId);
    if (agent) {
      this.emit('agent:ready', agent);
    }
  }

  /**
   * Mark agent as actively processing
   */
  markActive(agentId: string): void {
    const { agent, statusChanged } = markAgentActive(agentId);
    if (agent && statusChanged) {
      this.emit('agent:active', agent);
    }
  }

  /**
   * Mark agent as idle (waiting for input)
   */
  markIdle(agentId: string): void {
    const agent = markAgentIdle(agentId);
    if (agent) {
      this.emit('agent:idle', agent);
    }
  }

  /**
   * Mark agent as completed successfully
   */
  complete(agentId: string, exitCode: number = 0): void {
    const { agent, success } = completeAgentTask(agentId, exitCode);
    if (agent) {
      if (success) {
        this.emit('agent:completed', agent);
      } else {
        this.emit('agent:error', agent, `Exited with code ${exitCode}`);
      }
    }
  }

  /**
   * Mark agent as errored
   */
  error(agentId: string, errorMessage: string): void {
    const agent = markAgentError(agentId, errorMessage);
    if (agent) {
      this.emit('agent:error', agent, errorMessage);
    }
  }

  /**
   * Terminate an agent
   * Also cleans up sessionToAgentMap entries for this agent (CRIT-003)
   */
  terminateAgent(agentId: string): void {
    // Clean up session mappings first
    clearSessionMappingsForAgent(agentId);

    const agent = terminateAgentById(agentId);
    if (agent) {
      this.emit('agent:terminated', agent);
    }
  }

  /**
   * Record activity for an agent
   */
  recordActivity(agentId: string): void {
    const agent = recordAgentActivity(agentId);
    if (agent) {
      this.emit('agent:activity', agent);
    }
  }

  // ==========================================================================
  // QUERIES
  // ==========================================================================

  /**
   * Get a single agent by ID
   */
  getAgent(agentId: string): AgentRecord | null {
    return getAgentById(agentId);
  }

  /**
   * Get all active agents
   */
  getActiveAgents(): AgentRecord[] {
    return listActiveAgents();
  }

  /**
   * Get all agents
   */
  getAllAgents(): AgentRecord[] {
    return listAllAgents();
  }

  /**
   * Get children of an agent
   */
  getChildren(parentId: string): AgentRecord[] {
    return getAgentChildren(parentId);
  }

  /**
   * Get root agents (no parent)
   */
  getRootAgents(): AgentRecord[] {
    return getRootAgents();
  }

  /**
   * Build agent tree starting from root agents
   */
  getAgentTree(): AgentTreeNode[] {
    return buildAgentTree();
  }

  /**
   * Get agent tree for a specific agent
   */
  getSubtree(agentId: string): AgentTreeNode | null {
    return getAgentSubtree(agentId);
  }

  /**
   * Get all ancestors of an agent
   */
  getAncestors(agentId: string): AgentRecord[] {
    return getAgentAncestors(agentId);
  }

  /**
   * Get all descendants of an agent
   */
  getDescendants(agentId: string): AgentRecord[] {
    return getAgentDescendants(agentId);
  }

  /**
   * Find agents by status
   */
  getAgentsByStatus(status: AgentStatus): AgentRecord[] {
    return getAgentsByStatus(status);
  }

  /**
   * Find agents by name pattern
   */
  findAgentsByName(pattern: string): AgentRecord[] {
    return findAgentsByName(pattern);
  }

  /**
   * Check if an agent exists
   */
  exists(agentId: string): boolean {
    return agentExists(agentId);
  }

  /**
   * Get agent by session ID
   */
  getAgentBySession(sessionId: string): AgentRecord | null {
    // First check local cache
    const agentId = getAgentIdFromSession(sessionId);
    if (agentId) {
      return getAgentById(agentId);
    }
    // Fall back to database lookup
    return getAgentBySessionId(sessionId);
  }

  /**
   * Clear all agents from the registry (manual cleanup)
   */
  clearAllAgents(): number {
    clearAllSessionMappings();
    return clearAllAgentsFromRegistry();
  }

  /**
   * Run garbage cleanup immediately
   */
  runGarbageCleanup(): number {
    return runGarbageCleanup();
  }

  // ==========================================================================
  // STATISTICS
  // ==========================================================================

  /**
   * Get agent statistics
   */
  getStats(): AgentStats {
    return getAgentStats();
  }

  // ==========================================================================
  // PRIVATE METHODS
  // ==========================================================================

  private checkAgentActivity(): void {
    const agentsToMarkIdle = checkAgentActivity();
    for (const agent of agentsToMarkIdle) {
      this.markIdle(agent.id);
    }
  }

  /**
   * Auto-terminate agents that have been idle for too long (30 minutes).
   * This prevents orphaned agents from accumulating in the registry.
   */
  private terminateStaleAgents(): void {
    const agentsToTerminate = findStaleAgentsToTerminate();
    for (const agent of agentsToTerminate) {
      this.terminateAgent(agent.id);
    }

    if (agentsToTerminate.length > 0) {
      logger.info(`Auto-terminated ${agentsToTerminate.length} stale agents`);
    }
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let agentRegistry: AgentRegistryService | null = null;

export function initAgentRegistry(): AgentRegistryService {
  if (!agentRegistry) {
    agentRegistry = new AgentRegistryService();
    agentRegistry.init();
  }
  return agentRegistry;
}

export function getAgentRegistry(): AgentRegistryService | null {
  return agentRegistry;
}

export function shutdownAgentRegistry(): void {
  if (agentRegistry) {
    agentRegistry.shutdown();
    agentRegistry = null;
  }
}

// ============================================================================
// RE-EXPORTS - Maintain backward compatibility
// ============================================================================

// Re-export types
export type { AgentRecord, AgentStatus } from '../../database/primitives.js';
export type {
  AgentSpawnOptions,
  AgentTreeNode,
  AgentRegistryEvents,
  AgentStats,
} from './types.js';

// Re-export the service class for direct use if needed
export { AgentRegistryService };
