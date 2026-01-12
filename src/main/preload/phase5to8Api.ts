// ============================================================================
// PHASE 5-8 PRELOAD API - Exposed to renderer for budget, approval, agents
// ============================================================================
//
// This module defines the preload API methods for Phase 5-8 features.
// These are merged into the main goodvibes API in preload.ts.
//
// ============================================================================

import { ipcRenderer } from 'electron';

// ============================================================================
// TYPES
// ============================================================================

export interface BudgetRecord {
  id: number;
  projectPath: string | null;
  sessionId: string | null;
  limitUsd: number;
  spentUsd: number;
  warningThreshold: number;
  hardStopEnabled: boolean;
  resetPeriod: 'session' | 'daily' | 'weekly' | 'monthly';
  lastReset: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalQueueItem {
  id: number;
  sessionId: string;
  requestType: string;
  requestDetails: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  policyId: number | null;
  decidedAt: string | null;
  decidedBy: 'user' | 'policy' | null;
  createdAt: string;
}

export interface ApprovalPolicy {
  id: number;
  name: string;
  matcher: string;
  action: 'auto-approve' | 'auto-deny' | 'queue';
  priority: number;
  conditions: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentTreeNode {
  id: number;
  sessionId: string;
  agentName: string;
  parentId: number | null;
  parentSessionId: string | null;
  rootSessionId: string;
  depth: number;
  status: 'running' | 'completed' | 'failed' | 'terminated';
  startedAt: string;
  completedAt: string | null;
  allocatedBudgetUsd: number;
  spentBudgetUsd: number;
  toolCalls: number;
  tokensUsed: number;
  metadata: string | null;
}

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

export interface AgentMetrics {
  agentName: string;
  totalSessions: number;
  successCount: number;
  failureCount: number;
  avgDurationMs: number;
  avgToolCalls: number;
  avgTokensUsed: number;
  avgCostUsd: number;
  successRate: number;
}

export interface AgentHierarchySummary {
  rootSessionId: string;
  totalAgents: number;
  maxDepth: number;
  totalBudgetAllocated: number;
  totalBudgetSpent: number;
  runningAgents: number;
  completedAgents: number;
  failedAgents: number;
}

export interface SessionSummary {
  id: number;
  sessionId: string;
  projectPath: string;
  title: string;
  description: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number;
  status: 'completed' | 'aborted' | 'error';
  toolCalls: number;
  filesModified: number;
  filesCreated: number;
  testsRun: number;
  testsPassed: number;
  testsFailed: number;
  tokensUsed: number;
  costUsd: number;
  activeAgentIds: string;
  injectedSkillIds: string;
  keyTopics: string;
  fileChanges: string;
  lastPrompt: string | null;
  contextSnapshot: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionComparison {
  session1: SessionSummary;
  session2: SessionSummary;
  commonFiles: string[];
  session1OnlyFiles: string[];
  session2OnlyFiles: string[];
  durationDiff: number;
  costDiff: number;
  toolCallsDiff: number;
}

export interface ResumptionContext {
  previousSessionId: string;
  previousSummary: SessionSummary;
  contextToInject: string;
  lastPrompt: string | null;
  suggestedStartingPrompt: string;
}

export interface SessionCheckpoint {
  id: number;
  sessionId: string;
  checkpointName: string;
  context: string;
  createdAt: string;
}

// ============================================================================
// API METHODS
// ============================================================================

export const phase5to8Api = {
  // =====================
  // BUDGET API (Phase 5)
  // =====================

  getAllBudgets: (): Promise<BudgetRecord[]> =>
    ipcRenderer.invoke('budget:getAll'),

  getBudgetForScope: (projectPath?: string, sessionId?: string): Promise<BudgetRecord | null> =>
    ipcRenderer.invoke('budget:getForScope', projectPath, sessionId),

  createBudget: (options: {
    limitUsd: number;
    warningThreshold?: number;
    hardStopEnabled?: boolean;
    resetPeriod?: 'session' | 'daily' | 'weekly' | 'monthly';
    projectPath?: string;
    sessionId?: string;
  }): Promise<BudgetRecord> =>
    ipcRenderer.invoke('budget:create', options),

  updateBudget: (budgetId: number, updates: {
    limitUsd?: number;
    warningThreshold?: number;
    hardStopEnabled?: boolean;
    resetPeriod?: 'session' | 'daily' | 'weekly' | 'monthly';
  }): Promise<BudgetRecord | null> =>
    ipcRenderer.invoke('budget:update', budgetId, updates),

  resetBudget: (budgetId: number): Promise<boolean> =>
    ipcRenderer.invoke('budget:reset', budgetId),

  getCostBreakdown: (sessionId?: string): Promise<{
    byTool: Record<string, number>;
    bySession: Record<string, number>;
    byAgent: Record<string, number>;
    total: number;
  }> =>
    ipcRenderer.invoke('budget:getCostBreakdown', sessionId),

  projectSessionCost: (sessionId: string, remainingMinutes: number): Promise<number> =>
    ipcRenderer.invoke('budget:projectCost', sessionId, remainingMinutes),

  // =====================
  // APPROVAL API (Phase 6)
  // =====================

  getPendingApprovals: (sessionId?: string): Promise<ApprovalQueueItem[]> =>
    ipcRenderer.invoke('approval:getPending', sessionId),

  approveItem: (itemId: number): Promise<boolean> =>
    ipcRenderer.invoke('approval:approve', itemId),

  denyItem: (itemId: number): Promise<boolean> =>
    ipcRenderer.invoke('approval:deny', itemId),

  batchApprove: (itemIds: number[]): Promise<boolean> =>
    ipcRenderer.invoke('approval:batchApprove', itemIds),

  batchDeny: (itemIds: number[]): Promise<boolean> =>
    ipcRenderer.invoke('approval:batchDeny', itemIds),

  getAllPolicies: (): Promise<ApprovalPolicy[]> =>
    ipcRenderer.invoke('policy:getAll'),

  getEnabledPolicies: (): Promise<ApprovalPolicy[]> =>
    ipcRenderer.invoke('policy:getEnabled'),

  createPolicy: (policy: {
    name: string;
    matcher: string;
    action: 'auto-approve' | 'auto-deny' | 'queue';
    priority?: number;
    enabled?: boolean;
  }): Promise<ApprovalPolicy> =>
    ipcRenderer.invoke('policy:create', policy),

  updatePolicy: (id: number, updates: {
    name?: string;
    matcher?: string;
    action?: 'auto-approve' | 'auto-deny' | 'queue';
    priority?: number;
    enabled?: boolean;
  }): Promise<ApprovalPolicy | null> =>
    ipcRenderer.invoke('policy:update', id, updates),

  deletePolicy: (id: number): Promise<boolean> =>
    ipcRenderer.invoke('policy:delete', id),

  // =====================
  // AGENT TREE API (Phase 7)
  // =====================

  getAgent: (sessionId: string): Promise<AgentTreeNode | null> =>
    ipcRenderer.invoke('agentTree:getAgent', sessionId),

  getAgentTree: (rootSessionId: string): Promise<AgentTreeNode[]> =>
    ipcRenderer.invoke('agentTree:getTree', rootSessionId),

  getRunningAgents: (rootSessionId?: string): Promise<AgentTreeNode[]> =>
    ipcRenderer.invoke('agentTree:getRunning', rootSessionId),

  getAgentChildren: (sessionId: string): Promise<AgentTreeNode[]> =>
    ipcRenderer.invoke('agentTree:getChildren', sessionId),

  getTreeSummary: (rootSessionId: string): Promise<AgentHierarchySummary> =>
    ipcRenderer.invoke('agentTree:getSummary', rootSessionId),

  getVisualizationTree: (rootSessionId: string): Promise<TreeVisualizationNode | null> =>
    ipcRenderer.invoke('agentTree:getVisualizationTree', rootSessionId),

  getFlatTreeList: (rootSessionId: string): Promise<Array<TreeVisualizationNode & { indent: number }>> =>
    ipcRenderer.invoke('agentTree:getFlatList', rootSessionId),

  getAgentMetrics: (agentName: string): Promise<AgentMetrics | null> =>
    ipcRenderer.invoke('agentTree:getMetrics', agentName),

  getAllAgentMetrics: (): Promise<AgentMetrics[]> =>
    ipcRenderer.invoke('agentTree:getAllMetrics'),

  terminateAgent: (sessionId: string): Promise<boolean> =>
    ipcRenderer.invoke('agentTree:terminate', sessionId),

  allocateAgentBudget: (sessionId: string, amount: number): Promise<boolean> =>
    ipcRenderer.invoke('agentTree:allocateBudget', sessionId, amount),

  // =====================
  // SESSION INTELLIGENCE API (Phase 8)
  // =====================

  getSession: (sessionId: string): Promise<SessionSummary | null> =>
    ipcRenderer.invoke('session:get', sessionId),

  getRecentSessions: (limit?: number): Promise<SessionSummary[]> =>
    ipcRenderer.invoke('session:getRecent', limit),

  getProjectSessions: (projectPath: string, limit?: number): Promise<SessionSummary[]> =>
    ipcRenderer.invoke('session:getForProject', projectPath, limit),

  searchSessions: (query: string, projectPath?: string, limit?: number): Promise<SessionSummary[]> =>
    ipcRenderer.invoke('session:search', query, projectPath, limit),

  findSessionsByFile: (filePath: string, projectPath?: string, limit?: number): Promise<SessionSummary[]> =>
    ipcRenderer.invoke('session:findByFile', filePath, projectPath, limit),

  compareSessions: (sessionId1: string, sessionId2: string): Promise<SessionComparison | null> =>
    ipcRenderer.invoke('session:compare', sessionId1, sessionId2),

  prepareResumption: (sessionId: string): Promise<ResumptionContext | null> =>
    ipcRenderer.invoke('session:prepareResumption', sessionId),

  createSessionCheckpoint: (sessionId: string, name: string): Promise<SessionCheckpoint | null> =>
    ipcRenderer.invoke('session:createCheckpoint', sessionId, name),

  getSessionCheckpoints: (sessionId: string): Promise<SessionCheckpoint[]> =>
    ipcRenderer.invoke('session:getCheckpoints', sessionId),

  deleteSessionCheckpoint: (checkpointId: number): Promise<boolean> =>
    ipcRenderer.invoke('session:deleteCheckpoint', checkpointId),

  // =====================
  // EVENT LISTENERS
  // =====================

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on: (channel: string, callback: (...args: any[]) => void): void => {
    ipcRenderer.on(channel, callback);
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off: (channel: string, callback: (...args: any[]) => void): void => {
    ipcRenderer.removeListener(channel, callback);
  },
};
