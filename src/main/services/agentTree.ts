// ============================================================================
// AGENT TREE SERVICE - Agent hierarchy tracking and orchestration
// ============================================================================
//
// This service manages the agent tree - tracking parent-child relationships,
// budget allocation across the tree, and performance metrics.
//
// ============================================================================

import { EventEmitter } from 'events';
import { Logger } from './logger.js';
import { getMainWindow } from '../window.js';
import {
  createAgentTreeTables,
  registerAgent,
  getAgentBySessionId,
  getAgentChildren,
  getAgentTree,
  getRunningAgents,
  updateAgentStatus,
  updateAgentBudgetSpent,
  incrementAgentToolCalls,
  updateAgentTokensUsed,
  setAgentMetadata,
  allocateBudgetToChild,
  getAgentMetricsByName,
  getAllAgentMetrics,
  getHierarchySummary,
  cleanupOldAgentTrees,
  type AgentTreeNode,
  type AgentMetrics,
  type AgentHierarchySummary,
} from '../database/agentTree.js';

const logger = new Logger('AgentTreeService');

// ============================================================================
// TYPES
// ============================================================================

/**
 * Agent start event from SubagentStart hook
 */
export interface AgentStartEvent {
  sessionId: string;
  agentName: string;
  parentSessionId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Agent stop event from SubagentStop hook
 */
export interface AgentStopEvent {
  sessionId: string;
  success: boolean;
  result?: string;
}

/**
 * Tree visualization node
 */
export interface TreeVisualizationNode {
  id: number;
  sessionId: string;
  agentName: string;
  depth: number;
  status: 'running' | 'completed' | 'failed' | 'terminated';
  duration: number;
  budgetAllocated: number;
  budgetSpent: number;
  budgetRemaining: number;
  toolCalls: number;
  children: TreeVisualizationNode[];
}

// ============================================================================
// AGENT TREE SERVICE
// ============================================================================

class AgentTreeServiceClass extends EventEmitter {
  private initialized: boolean = false;

  constructor() {
    super();
    this.setMaxListeners(50);
  }

  /**
   * Initialize the agent tree service
   */
  initialize(): void {
    if (this.initialized) return;

    // Ensure tables exist
    createAgentTreeTables();
    this.initialized = true;

    logger.info('Agent tree service initialized');
  }

  // ============================================================================
  // AGENT LIFECYCLE
  // ============================================================================

  /**
   * Handle SubagentStart hook event
   */
  handleAgentStart(event: AgentStartEvent): AgentTreeNode {
    this.initialize();

    logger.info(`Agent started: ${event.agentName}`, {
      sessionId: event.sessionId,
      parentSessionId: event.parentSessionId
    });

    // Register the agent in the tree
    const node = registerAgent(
      event.sessionId,
      event.agentName,
      event.parentSessionId,
      0 // Budget will be allocated separately
    );

    // Set metadata if provided
    if (event.metadata) {
      setAgentMetadata(event.sessionId, event.metadata);
    }

    // Emit events
    this.emit('agent:started', node);
    this.notifyRenderer('agent:tree-updated', {
      action: 'add',
      node,
      tree: this.getVisualizationTree(node.rootSessionId),
    });

    return node;
  }

  /**
   * Handle SubagentStop hook event
   */
  handleAgentStop(event: AgentStopEvent): void {
    this.initialize();

    logger.info(`Agent stopped: ${event.sessionId}`, { success: event.success });

    // Update status
    updateAgentStatus(
      event.sessionId,
      event.success ? 'completed' : 'failed'
    );

    const node = getAgentBySessionId(event.sessionId);

    // Emit events
    this.emit('agent:stopped', { sessionId: event.sessionId, success: event.success });

    if (node) {
      this.notifyRenderer('agent:tree-updated', {
        action: 'update',
        node: getAgentBySessionId(event.sessionId),
        tree: this.getVisualizationTree(node.rootSessionId),
      });
    }
  }

  /**
   * Terminate an agent and all its children
   */
  terminateAgent(sessionId: string): void {
    const node = getAgentBySessionId(sessionId);
    if (!node) return;

    // Terminate all children first
    const children = getAgentChildren(node.id);
    for (const child of children) {
      this.terminateAgent(child.sessionId);
    }

    // Terminate this agent
    updateAgentStatus(sessionId, 'terminated');

    this.emit('agent:terminated', { sessionId });
    this.notifyRenderer('agent:tree-updated', {
      action: 'update',
      node: getAgentBySessionId(sessionId),
      tree: this.getVisualizationTree(node.rootSessionId),
    });

    logger.info(`Agent terminated: ${sessionId}`);
  }

  // ============================================================================
  // BUDGET MANAGEMENT
  // ============================================================================

  /**
   * Allocate budget to an agent
   */
  allocateBudget(sessionId: string, amount: number, fromParent: boolean = false): boolean {
    const node = getAgentBySessionId(sessionId);
    if (!node) return false;

    if (fromParent && node.parentSessionId) {
      return allocateBudgetToChild(node.parentSessionId, sessionId, amount);
    }

    // Direct allocation (for root agents)
    const db = require('../database/index.js').getDatabase();
    db.prepare(`
      UPDATE agent_tree_nodes SET
        allocated_budget_usd = ?
      WHERE session_id = ?
    `).run(amount, sessionId);

    this.emit('agent:budget-allocated', { sessionId, amount });
    this.notifyRenderer('agent:budget-updated', { sessionId, amount });

    return true;
  }

  /**
   * Record cost for an agent
   */
  recordCost(sessionId: string, cost: number): void {
    updateAgentBudgetSpent(sessionId, cost);

    const node = getAgentBySessionId(sessionId);
    if (node) {
      this.emit('agent:cost-recorded', { sessionId, cost });

      // Check if over budget
      if (node.spentBudgetUsd + cost >= node.allocatedBudgetUsd && node.allocatedBudgetUsd > 0) {
        this.emit('agent:budget-exceeded', { sessionId });
        this.notifyRenderer('agent:budget-exceeded', { sessionId });
      }
    }
  }

  /**
   * Record tool call for an agent
   */
  recordToolCall(sessionId: string): void {
    incrementAgentToolCalls(sessionId, 1);
  }

  /**
   * Record token usage for an agent
   */
  recordTokens(sessionId: string, tokens: number): void {
    updateAgentTokensUsed(sessionId, tokens);
  }

  // ============================================================================
  // TREE QUERIES
  // ============================================================================

  /**
   * Get agent by session ID
   */
  getAgent(sessionId: string): AgentTreeNode | null {
    this.initialize();
    return getAgentBySessionId(sessionId);
  }

  /**
   * Get all agents in a tree
   */
  getTree(rootSessionId: string): AgentTreeNode[] {
    this.initialize();
    return getAgentTree(rootSessionId);
  }

  /**
   * Get children of an agent
   */
  getChildren(sessionId: string): AgentTreeNode[] {
    this.initialize();
    const node = getAgentBySessionId(sessionId);
    if (!node) return [];
    return getAgentChildren(node.id);
  }

  /**
   * Get all currently running agents
   */
  getRunningAgents(rootSessionId?: string): AgentTreeNode[] {
    this.initialize();
    return getRunningAgents(rootSessionId);
  }

  /**
   * Get tree summary
   */
  getSummary(rootSessionId: string): AgentHierarchySummary {
    this.initialize();
    return getHierarchySummary(rootSessionId);
  }

  // ============================================================================
  // METRICS
  // ============================================================================

  /**
   * Get metrics for an agent by name
   */
  getAgentMetrics(agentName: string): AgentMetrics | null {
    this.initialize();
    return getAgentMetricsByName(agentName);
  }

  /**
   * Get all agent metrics
   */
  getAllMetrics(): AgentMetrics[] {
    this.initialize();
    return getAllAgentMetrics();
  }

  // ============================================================================
  // VISUALIZATION
  // ============================================================================

  /**
   * Build a tree structure for visualization
   */
  getVisualizationTree(rootSessionId: string): TreeVisualizationNode | null {
    const nodes = getAgentTree(rootSessionId);
    if (nodes.length === 0) return null;

    // Build a map for quick lookup
    const nodeMap = new Map<string, TreeVisualizationNode>();

    // Create visualization nodes
    for (const node of nodes) {
      const now = Date.now();
      const startTime = new Date(node.startedAt).getTime();
      const endTime = node.completedAt
        ? new Date(node.completedAt).getTime()
        : now;

      nodeMap.set(node.sessionId, {
        id: node.id,
        sessionId: node.sessionId,
        agentName: node.agentName,
        depth: node.depth,
        status: node.status,
        duration: endTime - startTime,
        budgetAllocated: node.allocatedBudgetUsd,
        budgetSpent: node.spentBudgetUsd,
        budgetRemaining: Math.max(0, node.allocatedBudgetUsd - node.spentBudgetUsd),
        toolCalls: node.toolCalls,
        children: [],
      });
    }

    // Build tree structure
    let root: TreeVisualizationNode | null = null;

    for (const node of nodes) {
      const vizNode = nodeMap.get(node.sessionId);
      if (!vizNode) continue;

      if (node.parentSessionId) {
        const parent = nodeMap.get(node.parentSessionId);
        if (parent) {
          parent.children.push(vizNode);
        }
      } else {
        root = vizNode;
      }
    }

    return root;
  }

  /**
   * Get a flat list with indentation levels for UI rendering
   */
  getFlatTreeList(rootSessionId: string): Array<TreeVisualizationNode & { indent: number }> {
    const root = this.getVisualizationTree(rootSessionId);
    if (!root) return [];

    const result: Array<TreeVisualizationNode & { indent: number }> = [];

    function traverse(node: TreeVisualizationNode, indent: number) {
      result.push({ ...node, indent, children: [] });
      for (const child of node.children) {
        traverse(child, indent + 1);
      }
    }

    traverse(root, 0);
    return result;
  }

  // ============================================================================
  // MAINTENANCE
  // ============================================================================

  /**
   * Clean up old completed trees
   */
  cleanup(maxAgeHours: number = 72): number {
    return cleanupOldAgentTrees(maxAgeHours);
  }

  /**
   * Notify the renderer process
   */
  private notifyRenderer(channel: string, data: unknown): void {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, data);
    }
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let agentTreeService: AgentTreeServiceClass | null = null;

export function getAgentTreeService(): AgentTreeServiceClass {
  if (!agentTreeService) {
    agentTreeService = new AgentTreeServiceClass();
  }
  return agentTreeService;
}

export function initializeAgentTreeService(): AgentTreeServiceClass {
  agentTreeService = new AgentTreeServiceClass();
  agentTreeService.initialize();
  return agentTreeService;
}

export { AgentTreeServiceClass };
