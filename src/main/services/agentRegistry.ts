// ============================================================================
// AGENT REGISTRY SERVICE (P6) - Agent Lifecycle Tracking
// ============================================================================

import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';
import { Logger } from './logger.js';
import {
  registerAgent,
  getAgent,
  getAgentsByParent,
  getActiveAgents,
  getAllAgents,
  updateAgentStatus,
  updateAgentActivity,
  completeAgent,
  cleanupStaleAgents,
  cleanupGarbageAgents,
  deleteAllAgents,
  findAgentBySession,
  type AgentRecord,
  type AgentStatus,
} from '../database/primitives.js';
import { getHookServer } from './hookServer.js';

const logger = new Logger('AgentRegistry');

// ============================================================================
// TYPES
// ============================================================================

export interface AgentSpawnOptions {
  name: string;
  cwd: string;
  parentId?: string;
  templateId?: string;
  initialPrompt?: string;
  sessionPath?: string;
}

export interface AgentTreeNode {
  agent: AgentRecord;
  children: AgentTreeNode[];
}

export interface AgentRegistryEvents {
  'agent:spawned': (agent: AgentRecord) => void;
  'agent:ready': (agent: AgentRecord) => void;
  'agent:active': (agent: AgentRecord) => void;
  'agent:idle': (agent: AgentRecord) => void;
  'agent:completed': (agent: AgentRecord) => void;
  'agent:error': (agent: AgentRecord, error: string) => void;
  'agent:terminated': (agent: AgentRecord) => void;
  'agent:activity': (agent: AgentRecord) => void;
}

// ============================================================================
// AGENT REGISTRY CLASS
// ============================================================================

class AgentRegistryService extends EventEmitter {
  private cleanupInterval: NodeJS.Timeout | null = null;
  private activityCheckInterval: NodeJS.Timeout | null = null;
  private staleCheckInterval: NodeJS.Timeout | null = null;
  private garbageCleanupInterval: NodeJS.Timeout | null = null;
  private readonly CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  private readonly ACTIVITY_CHECK_INTERVAL_MS = 10 * 1000; // 10 seconds
  private readonly IDLE_THRESHOLD_MS = 30 * 1000; // 30 seconds without activity = idle
  private readonly STALE_CHECK_INTERVAL_MS = 60 * 1000; // Check for stale agents every minute
  private readonly STALE_AGENT_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes idle = auto-terminate
  private readonly GARBAGE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  // Session ID to Agent ID mapping for quick lookup
  private sessionToAgentMap: Map<string, string> = new Map();

  constructor() {
    super();
    this.setMaxListeners(100); // Allow many listeners for agent events
  }

  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  init(): void {
    logger.info('Initializing Agent Registry Service');

    // FIRST: Clean up garbage entries from previous runs
    this.performGarbageCleanup();

    // Start cleanup interval for stale agents
    this.cleanupInterval = setInterval(() => {
      this.performCleanup();
    }, this.CLEANUP_INTERVAL_MS);

    // Start activity check interval
    this.activityCheckInterval = setInterval(() => {
      this.checkAgentActivity();
    }, this.ACTIVITY_CHECK_INTERVAL_MS);

    // Start stale agent auto-termination check interval
    this.staleCheckInterval = setInterval(() => {
      this.terminateStaleAgents();
    }, this.STALE_CHECK_INTERVAL_MS);

    // Start garbage cleanup interval (more frequently)
    this.garbageCleanupInterval = setInterval(() => {
      this.performGarbageCleanup();
    }, this.GARBAGE_CLEANUP_INTERVAL_MS);

    // Initial cleanup of any stale agents from previous sessions
    this.performCleanup();

    // Initial stale agent termination check
    this.terminateStaleAgents();

    // Wire up hook server events for agent lifecycle
    this.wireUpHookEvents();

    logger.info('Agent Registry Service initialized');
  }

  /**
   * Wire up hook server events to update agent state
   */
  private wireUpHookEvents(): void {
    try {
      const hookServer = getHookServer();

      // Listen for session start/end events
      hookServer.on('session:start', ({ sessionId }) => {
        if (sessionId) {
          // Record session-to-agent mapping
          const agent = findAgentBySession(sessionId);
          if (agent) {
            this.sessionToAgentMap.set(sessionId, agent.id);
            logger.debug(`Mapped session ${sessionId} to agent ${agent.id}`);
          }
        }
      });

      hookServer.on('session:end', ({ sessionId }) => {
        if (sessionId) {
          this.sessionToAgentMap.delete(sessionId);
          logger.debug(`Removed session mapping for ${sessionId}`);
        }
      });

      // Listen for agent start/stop events
      hookServer.on('agent:start', ({ agentName, sessionId }) => {
        if (sessionId) {
          const agent = findAgentBySession(sessionId);
          if (agent) {
            this.sessionToAgentMap.set(sessionId, agent.id);
            this.emit('agent:spawned', agent);
            logger.debug(`Agent started: ${agentName} (${agent.id})`);
          }
        }
      });

      hookServer.on('agent:stop', ({ sessionId }) => {
        if (sessionId) {
          const agent = findAgentBySession(sessionId);
          if (agent) {
            this.emit('agent:completed', agent);
          }
          this.sessionToAgentMap.delete(sessionId);
        }
      });

      logger.info('Hook events wired up successfully');
    } catch (error) {
      logger.warn('Could not wire up hook events (hook server may not be initialized yet):', error);
    }
  }

  shutdown(): void {
    logger.info('Shutting down Agent Registry Service');

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    if (this.activityCheckInterval) {
      clearInterval(this.activityCheckInterval);
      this.activityCheckInterval = null;
    }

    if (this.staleCheckInterval) {
      clearInterval(this.staleCheckInterval);
      this.staleCheckInterval = null;
    }

    if (this.garbageCleanupInterval) {
      clearInterval(this.garbageCleanupInterval);
      this.garbageCleanupInterval = null;
    }

    // Clear session map
    this.sessionToAgentMap.clear();

    // Mark all active agents as terminated
    const activeAgents = this.getActiveAgents();
    for (const agent of activeAgents) {
      this.terminateAgent(agent.id);
    }

    this.removeAllListeners();
    logger.info('Agent Registry Service shut down');
  }

  // ============================================================================
  // AGENT LIFECYCLE
  // ============================================================================

  /**
   * Register a new agent that is being spawned
   */
  spawn(options: AgentSpawnOptions): AgentRecord {
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

    this.emit('agent:spawned', agent);
    return agent;
  }

  /**
   * Update agent with PID after PTY is created
   */
  setPid(agentId: string, pid: number): void {
    const agent = getAgent(agentId);
    if (!agent) {
      logger.warn(`Cannot set PID - agent not found: ${agentId}`);
      return;
    }

    // Update in database (we'll need to add this method)
    const db = require('../database/index.js').getDatabase();
    db.prepare('UPDATE agent_registry SET pid = ? WHERE id = ?').run(pid, agentId);

    logger.debug(`Agent ${agentId} PID set to ${pid}`);
  }

  /**
   * Mark agent as ready to receive input
   */
  markReady(agentId: string): void {
    this.updateStatus(agentId, 'ready');
    const agent = getAgent(agentId);
    if (agent) {
      this.emit('agent:ready', agent);
    }
  }

  /**
   * Mark agent as actively processing
   */
  markActive(agentId: string): void {
    const agent = getAgent(agentId);
    if (agent && agent.status !== 'active') {
      this.updateStatus(agentId, 'active');
      const updatedAgent = getAgent(agentId);
      if (updatedAgent) {
        this.emit('agent:active', updatedAgent);
      }
    } else if (agent) {
      // Just update activity timestamp
      updateAgentActivity(agentId);
    }
  }

  /**
   * Mark agent as idle (waiting for input)
   */
  markIdle(agentId: string): void {
    this.updateStatus(agentId, 'idle');
    const agent = getAgent(agentId);
    if (agent) {
      this.emit('agent:idle', agent);
    }
  }

  /**
   * Mark agent as completed successfully
   */
  complete(agentId: string, exitCode: number = 0): void {
    completeAgent(agentId, exitCode);
    const agent = getAgent(agentId);
    if (agent) {
      logger.info(`Agent completed: ${agent.name} (${agent.id}) with exit code ${exitCode}`);
      if (exitCode === 0) {
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
    updateAgentStatus(agentId, 'error', errorMessage);
    const agent = getAgent(agentId);
    if (agent) {
      logger.error(`Agent error: ${agent.name} (${agent.id})`, { error: errorMessage });
      this.emit('agent:error', agent, errorMessage);
    }
  }

  /**
   * Terminate an agent
   */
  terminateAgent(agentId: string): void {
    updateAgentStatus(agentId, 'terminated');
    const agent = getAgent(agentId);
    if (agent) {
      logger.info(`Agent terminated: ${agent.name} (${agent.id})`);
      this.emit('agent:terminated', agent);
    }
  }

  /**
   * Record activity for an agent
   */
  recordActivity(agentId: string): void {
    updateAgentActivity(agentId);
    const agent = getAgent(agentId);
    if (agent) {
      this.emit('agent:activity', agent);
    }
  }

  // ============================================================================
  // QUERIES
  // ============================================================================

  /**
   * Get a single agent by ID
   */
  getAgent(agentId: string): AgentRecord | null {
    return getAgent(agentId);
  }

  /**
   * Get all active agents
   */
  getActiveAgents(): AgentRecord[] {
    return getActiveAgents();
  }

  /**
   * Get all agents
   */
  getAllAgents(): AgentRecord[] {
    return getAllAgents();
  }

  /**
   * Get children of an agent
   */
  getChildren(parentId: string): AgentRecord[] {
    return getAgentsByParent(parentId);
  }

  /**
   * Get root agents (no parent)
   */
  getRootAgents(): AgentRecord[] {
    return getAgentsByParent(null);
  }

  /**
   * Build agent tree starting from root agents
   */
  getAgentTree(): AgentTreeNode[] {
    const buildTree = (parentId: string | null): AgentTreeNode[] => {
      const agents = getAgentsByParent(parentId);
      return agents.map(agent => ({
        agent,
        children: buildTree(agent.id),
      }));
    };

    return buildTree(null);
  }

  /**
   * Get agent tree for a specific agent
   */
  getSubtree(agentId: string): AgentTreeNode | null {
    const agent = getAgent(agentId);
    if (!agent) return null;

    const buildTree = (parentId: string): AgentTreeNode[] => {
      const children = getAgentsByParent(parentId);
      return children.map(child => ({
        agent: child,
        children: buildTree(child.id),
      }));
    };

    return {
      agent,
      children: buildTree(agentId),
    };
  }

  /**
   * Get all ancestors of an agent
   */
  getAncestors(agentId: string): AgentRecord[] {
    const ancestors: AgentRecord[] = [];
    let current = getAgent(agentId);

    while (current?.parentId) {
      const parent = getAgent(current.parentId);
      if (parent) {
        ancestors.push(parent);
        current = parent;
      } else {
        break;
      }
    }

    return ancestors;
  }

  /**
   * Get all descendants of an agent
   */
  getDescendants(agentId: string): AgentRecord[] {
    const descendants: AgentRecord[] = [];

    const collect = (parentId: string) => {
      const children = getAgentsByParent(parentId);
      for (const child of children) {
        descendants.push(child);
        collect(child.id);
      }
    };

    collect(agentId);
    return descendants;
  }

  /**
   * Find agents by status
   */
  getAgentsByStatus(status: AgentStatus): AgentRecord[] {
    return getAllAgents().filter(a => a.status === status);
  }

  /**
   * Find agents by name pattern
   */
  findAgentsByName(pattern: string): AgentRecord[] {
    const regex = new RegExp(pattern, 'i');
    return getAllAgents().filter(a => regex.test(a.name));
  }

  /**
   * Check if an agent exists
   */
  exists(agentId: string): boolean {
    return getAgent(agentId) !== null;
  }

  /**
   * Get agent by session ID
   */
  getAgentBySession(sessionId: string): AgentRecord | null {
    // First check local cache
    const agentId = this.sessionToAgentMap.get(sessionId);
    if (agentId) {
      return getAgent(agentId);
    }
    // Fall back to database lookup
    return findAgentBySession(sessionId);
  }

  /**
   * Clear all agents from the registry (manual cleanup)
   */
  clearAllAgents(): number {
    this.sessionToAgentMap.clear();
    return deleteAllAgents();
  }

  /**
   * Run garbage cleanup immediately
   */
  runGarbageCleanup(): number {
    return cleanupGarbageAgents();
  }

  // ============================================================================
  // STATISTICS
  // ============================================================================

  /**
   * Get agent statistics
   */
  getStats(): {
    total: number;
    active: number;
    idle: number;
    completed: number;
    error: number;
    byStatus: Record<AgentStatus, number>;
  } {
    const agents = getAllAgents();
    const byStatus: Record<AgentStatus, number> = {
      spawning: 0,
      ready: 0,
      active: 0,
      idle: 0,
      completed: 0,
      error: 0,
      terminated: 0,
    };

    for (const agent of agents) {
      byStatus[agent.status]++;
    }

    return {
      total: agents.length,
      active: byStatus.active + byStatus.spawning + byStatus.ready,
      idle: byStatus.idle,
      completed: byStatus.completed,
      error: byStatus.error,
      byStatus,
    };
  }

  // ============================================================================
  // PRIVATE METHODS
  // ============================================================================

  private updateStatus(agentId: string, status: AgentStatus): void {
    updateAgentStatus(agentId, status);
    logger.debug(`Agent ${agentId} status updated to ${status}`);
  }

  private performCleanup(): void {
    const cleaned = cleanupStaleAgents();
    if (cleaned > 0) {
      logger.info(`Cleaned up ${cleaned} stale agents`);
    }
  }

  /**
   * Clean up garbage agent entries (tools mistakenly registered as agents)
   */
  private performGarbageCleanup(): void {
    const cleaned = cleanupGarbageAgents();
    if (cleaned > 0) {
      logger.info(`Cleaned up ${cleaned} garbage agent entries`);
    }
  }

  private checkAgentActivity(): void {
    const activeAgents = getActiveAgents();
    const now = Date.now();

    for (const agent of activeAgents) {
      if (agent.status === 'active') {
        const lastActivity = new Date(agent.lastActivity).getTime();
        const idleTime = now - lastActivity;

        if (idleTime > this.IDLE_THRESHOLD_MS) {
          this.markIdle(agent.id);
        }
      }
    }
  }

  /**
   * Auto-terminate agents that have been idle for too long (30 minutes).
   * This prevents orphaned agents from accumulating in the registry.
   */
  private terminateStaleAgents(): void {
    const activeAgents = getActiveAgents();
    const now = Date.now();
    let terminatedCount = 0;

    for (const agent of activeAgents) {
      // Only auto-terminate agents in 'idle' status
      if (agent.status === 'idle') {
        const lastActivity = new Date(agent.lastActivity).getTime();
        const idleTime = now - lastActivity;

        if (idleTime > this.STALE_AGENT_THRESHOLD_MS) {
          logger.info(`Auto-terminating stale agent: ${agent.name} (${agent.id}), idle for ${Math.round(idleTime / 60000)} minutes`);
          this.terminateAgent(agent.id);
          terminatedCount++;
        }
      }
    }

    if (terminatedCount > 0) {
      logger.info(`Auto-terminated ${terminatedCount} stale agents`);
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

// Re-export types
export type { AgentRecord, AgentStatus };
