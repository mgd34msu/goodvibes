// ============================================================================
// AGENT REGISTRY - Query operations (get, list, filter, tree)
// ============================================================================

import {
  getAgent,
  getAgentsByParent,
  getActiveAgents,
  getAllAgents,
  findAgentBySession,
  deleteAllAgents,
  cleanupGarbageAgents,
} from '../../database/primitives.js';
import type { AgentRecord, AgentStatus } from '../../database/primitives.js';
import type { AgentTreeNode, AgentStats } from './types.js';

// ============================================================================
// SINGLE AGENT QUERIES
// ============================================================================

/**
 * Get a single agent by ID
 */
export function getAgentById(agentId: string): AgentRecord | null {
  return getAgent(agentId);
}

/**
 * Check if an agent exists
 */
export function agentExists(agentId: string): boolean {
  return getAgent(agentId) !== null;
}

/**
 * Get agent by session ID from database
 */
export function getAgentBySessionId(sessionId: string): AgentRecord | null {
  return findAgentBySession(sessionId);
}

// ============================================================================
// LIST QUERIES
// ============================================================================

/**
 * Get all active agents
 */
export function listActiveAgents(): AgentRecord[] {
  return getActiveAgents();
}

/**
 * Get all agents (including completed/terminated)
 */
export function listAllAgents(): AgentRecord[] {
  return getAllAgents();
}

/**
 * Get children of an agent
 */
export function getAgentChildren(parentId: string): AgentRecord[] {
  return getAgentsByParent(parentId);
}

/**
 * Get root agents (no parent)
 */
export function getRootAgents(): AgentRecord[] {
  return getAgentsByParent(null);
}

// ============================================================================
// FILTER QUERIES
// ============================================================================

/**
 * Find agents by status
 */
export function getAgentsByStatus(status: AgentStatus): AgentRecord[] {
  return getAllAgents().filter(a => a.status === status);
}

/**
 * Find agents by name pattern
 */
export function findAgentsByName(pattern: string): AgentRecord[] {
  const regex = new RegExp(pattern, 'i');
  return getAllAgents().filter(a => regex.test(a.name));
}

// ============================================================================
// TREE QUERIES
// ============================================================================

/**
 * Build agent tree starting from root agents
 */
export function buildAgentTree(): AgentTreeNode[] {
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
 * Get agent tree for a specific agent (subtree)
 */
export function getAgentSubtree(agentId: string): AgentTreeNode | null {
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
 * Get all ancestors of an agent (parent chain up to root)
 */
export function getAgentAncestors(agentId: string): AgentRecord[] {
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
 * Get all descendants of an agent (children, grandchildren, etc.)
 */
export function getAgentDescendants(agentId: string): AgentRecord[] {
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

// ============================================================================
// STATISTICS
// ============================================================================

/**
 * Get agent statistics
 */
export function getAgentStats(): AgentStats {
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
// CLEANUP OPERATIONS
// ============================================================================

/**
 * Clear all agents from the registry
 */
export function clearAllAgentsFromRegistry(): number {
  return deleteAllAgents();
}

/**
 * Run garbage cleanup for invalid agent entries
 */
export function runGarbageCleanup(): number {
  return cleanupGarbageAgents();
}
