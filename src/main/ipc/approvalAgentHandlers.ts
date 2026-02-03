// ============================================================================
// APPROVAL & AGENT IPC HANDLERS
// ============================================================================
//
// This module registers IPC handlers for:
// - Approval Queue
// - Agent Orchestration
//
// ============================================================================

import { ipcMain } from 'electron';
import { Logger } from '../services/logger.js';
import { getPolicyEngine } from '../services/policyEngine.js';
import { getAgentTreeService } from '../services/agentTree.js';

const logger = new Logger('ApprovalAgentIPC');

// ============================================================================
// REGISTRATION
// ============================================================================

export function registerApprovalAgentHandlers(): void {
  // Approval Handlers
  registerApprovalHandlers();

  // Agent Tree Handlers
  registerAgentTreeHandlers();

  logger.info('Approval & Agent IPC handlers registered');
}

// ============================================================================
// APPROVAL HANDLERS
// ============================================================================

function registerApprovalHandlers(): void {
  const policyEngine = getPolicyEngine();

  // Get pending approvals
  ipcMain.handle('approval:getPending', async (_event, sessionId?: string) => {
    return policyEngine.getPendingApprovals(sessionId);
  });

  // Approve item
  ipcMain.handle('approval:approve', async (_event, itemId: number) => {
    policyEngine.approveItem(itemId, true);
    return true;
  });

  // Deny item
  ipcMain.handle('approval:deny', async (_event, itemId: number) => {
    policyEngine.denyItem(itemId, true);
    return true;
  });

  // Batch approve
  ipcMain.handle('approval:batchApprove', async (_event, itemIds: number[]) => {
    policyEngine.batchApprove(itemIds);
    return true;
  });

  // Batch deny
  ipcMain.handle('approval:batchDeny', async (_event, itemIds: number[]) => {
    policyEngine.batchDeny(itemIds);
    return true;
  });

  // Get all policies
  ipcMain.handle('policy:getAll', async () => {
    return policyEngine.getAllPolicies();
  });

  // Get enabled policies
  ipcMain.handle('policy:getEnabled', async () => {
    return policyEngine.getEnabledPolicies();
  });

  // Create policy
  ipcMain.handle('policy:create', async (_event, policy: {
    name: string;
    matcher: string;
    action: 'auto-approve' | 'auto-deny' | 'queue';
    priority?: number;
    enabled?: boolean;
  }) => {
    return policyEngine.createPolicy(policy);
  });

  // Update policy
  ipcMain.handle('policy:update', async (_event, id: number, updates: {
    name?: string;
    matcher?: string;
    action?: 'auto-approve' | 'auto-deny' | 'queue';
    priority?: number;
    enabled?: boolean;
  }) => {
    policyEngine.updatePolicy(id, updates);
    return policyEngine.getPolicy(id);
  });

  // Delete policy
  ipcMain.handle('policy:delete', async (_event, id: number) => {
    policyEngine.deletePolicy(id);
    return true;
  });
}

// ============================================================================
// AGENT TREE HANDLERS
// ============================================================================

function registerAgentTreeHandlers(): void {
  const agentTreeService = getAgentTreeService();

  // Get agent by session ID
  ipcMain.handle('agentTree:getAgent', async (_event, sessionId: string) => {
    return agentTreeService.getAgent(sessionId);
  });

  // Get full tree
  ipcMain.handle('agentTree:getTree', async (_event, rootSessionId: string) => {
    return agentTreeService.getTree(rootSessionId);
  });

  // Get running agents
  ipcMain.handle('agentTree:getRunning', async (_event, rootSessionId?: string) => {
    return agentTreeService.getRunningAgents(rootSessionId);
  });

  // Get children
  ipcMain.handle('agentTree:getChildren', async (_event, sessionId: string) => {
    return agentTreeService.getChildren(sessionId);
  });

  // Get summary
  ipcMain.handle('agentTree:getSummary', async (_event, rootSessionId: string) => {
    return agentTreeService.getSummary(rootSessionId);
  });

  // Get visualization tree
  ipcMain.handle('agentTree:getVisualizationTree', async (_event, rootSessionId: string) => {
    return agentTreeService.getVisualizationTree(rootSessionId);
  });

  // Get flat tree list
  ipcMain.handle('agentTree:getFlatList', async (_event, rootSessionId: string) => {
    return agentTreeService.getFlatTreeList(rootSessionId);
  });

  // Get agent metrics
  ipcMain.handle('agentTree:getMetrics', async (_event, agentName: string) => {
    return agentTreeService.getAgentMetrics(agentName);
  });

  // Get all metrics
  ipcMain.handle('agentTree:getAllMetrics', async () => {
    return agentTreeService.getAllMetrics();
  });

  // Terminate agent
  ipcMain.handle('agentTree:terminate', async (_event, sessionId: string) => {
    agentTreeService.terminateAgent(sessionId);
    return true;
  });

  // Allocate budget
  ipcMain.handle('agentTree:allocateBudget', async (_event, sessionId: string, amount: number) => {
    return agentTreeService.allocateBudget(sessionId, amount, false);
  });
}
