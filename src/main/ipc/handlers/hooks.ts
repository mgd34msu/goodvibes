// ============================================================================
// HOOKS IPC HANDLERS
// ============================================================================

import { ipcMain } from 'electron';
import { Logger } from '../../services/logger.js';
import { withContext } from '../utils.js';
import * as primitives from '../../database/primitives.js';
import * as hookEvents from '../../database/hookEvents.js';
import { getHookServerStatus, startHookServer, stopHookServer } from '../../services/hookServer.js';
import {
  installAllHookScripts,
  areHookScriptsInstalled,
  getInstalledHookScripts,
  validateAllHookScripts,
  generateClaudeHooksConfig,
  HOOKS_DIR,
} from '../../services/hookScripts.js';

const logger = new Logger('IPC:Hooks');

export function registerHooksHandlers(): void {
  // ============================================================================
  // HOOKS CONFIGURATION
  // ============================================================================

  ipcMain.handle('get-hooks', withContext('get-hooks', async () => {
    return primitives.getAllHooks();
  }));

  ipcMain.handle('get-hook', withContext('get-hook', async (_, id: number) => {
    return primitives.getHook(id);
  }));

  ipcMain.handle('create-hook', withContext('create-hook', async (_, hook: Omit<primitives.HookConfig, 'id' | 'executionCount' | 'lastExecuted' | 'lastResult' | 'createdAt' | 'updatedAt'>) => {
    return primitives.createHook(hook);
  }));

  ipcMain.handle('update-hook', withContext('update-hook', async (_, { id, updates }: { id: number; updates: Partial<primitives.HookConfig> }) => {
    primitives.updateHook(id, updates);
    return true;
  }));

  ipcMain.handle('delete-hook', withContext('delete-hook', async (_, id: number) => {
    primitives.deleteHook(id);
    return true;
  }));

  ipcMain.handle('get-hooks-by-event', withContext('get-hooks-by-event', async (_, { eventType, projectPath }: { eventType: primitives.HookEventType; projectPath?: string }) => {
    return primitives.getHooksByEventType(eventType, projectPath);
  }));

  // ============================================================================
  // HOOK SERVER CONTROL
  // ============================================================================

  ipcMain.handle('hook-server-status', withContext('hook-server-status', async () => {
    return getHookServerStatus();
  }));

  ipcMain.handle('hook-server-start', withContext('hook-server-start', async () => {
    await startHookServer();
    return getHookServerStatus();
  }));

  ipcMain.handle('hook-server-stop', withContext('hook-server-stop', async () => {
    await stopHookServer();
    return getHookServerStatus();
  }));

  // ============================================================================
  // HOOK SCRIPTS MANAGEMENT
  // ============================================================================

  ipcMain.handle('hook-scripts-status', withContext('hook-scripts-status', async () => {
    const installed = await areHookScriptsInstalled();
    const scripts = await getInstalledHookScripts();
    const validation = await validateAllHookScripts();
    return {
      installed,
      scriptsCount: scripts.length,
      scriptsPath: HOOKS_DIR,
      validation,
    };
  }));

  ipcMain.handle('hook-scripts-install', withContext('hook-scripts-install', async () => {
    await installAllHookScripts();
    return { success: true, scriptsPath: HOOKS_DIR };
  }));

  ipcMain.handle('hook-scripts-validate', withContext('hook-scripts-validate', async () => {
    return validateAllHookScripts();
  }));

  ipcMain.handle('hook-claude-config', withContext('hook-claude-config', async () => {
    return generateClaudeHooksConfig();
  }));

  // ============================================================================
  // HOOK EVENT QUERIES
  // ============================================================================

  ipcMain.handle('get-hook-events', withContext('get-hook-events', async (_, { limit }: { limit?: number }) => {
    return hookEvents.getRecentHookEvents(limit);
  }));

  ipcMain.handle('get-hook-events-by-session', withContext('get-hook-events-by-session', async (_, { sessionId, limit }: { sessionId: string; limit?: number }) => {
    return hookEvents.getHookEventsBySession(sessionId, limit);
  }));

  ipcMain.handle('get-hook-events-by-type', withContext('get-hook-events-by-type', async (_, { eventType, limit }: { eventType: hookEvents.ExtendedHookEventType; limit?: number }) => {
    return hookEvents.getHookEventsByType(eventType, limit);
  }));

  ipcMain.handle('get-hook-event-stats', withContext('get-hook-event-stats', async () => {
    return hookEvents.getHookEventStats();
  }));

  ipcMain.handle('cleanup-hook-events', withContext('cleanup-hook-events', async (_, { maxAgeHours }: { maxAgeHours?: number }) => {
    return hookEvents.cleanupOldHookEvents(maxAgeHours);
  }));

  // ============================================================================
  // BUDGET MANAGEMENT
  // ============================================================================

  ipcMain.handle('get-budgets', withContext('get-budgets', async () => {
    return hookEvents.getAllBudgets();
  }));

  ipcMain.handle('get-budget', withContext('get-budget', async (_, { projectPath, sessionId }: { projectPath?: string; sessionId?: string }) => {
    return hookEvents.getBudgetForScope(projectPath, sessionId);
  }));

  ipcMain.handle('upsert-budget', withContext('upsert-budget', async (_, budget: Omit<hookEvents.BudgetRecord, 'id' | 'createdAt' | 'updatedAt'>) => {
    return hookEvents.upsertBudget(budget);
  }));

  ipcMain.handle('update-budget-spent', withContext('update-budget-spent', async (_, { id, additionalCost }: { id: number; additionalCost: number }) => {
    hookEvents.updateBudgetSpent(id, additionalCost);
    return true;
  }));

  // ============================================================================
  // APPROVAL POLICIES
  // ============================================================================

  ipcMain.handle('get-approval-policies', withContext('get-approval-policies', async () => {
    return hookEvents.getAllApprovalPolicies();
  }));

  ipcMain.handle('get-enabled-approval-policies', withContext('get-enabled-approval-policies', async () => {
    return hookEvents.getEnabledApprovalPolicies();
  }));

  ipcMain.handle('create-approval-policy', withContext('create-approval-policy', async (_, policy: Omit<hookEvents.ApprovalPolicy, 'id' | 'createdAt' | 'updatedAt'>) => {
    return hookEvents.createApprovalPolicy(policy);
  }));

  ipcMain.handle('update-approval-policy', withContext('update-approval-policy', async (_, { id, updates }: { id: number; updates: Partial<hookEvents.ApprovalPolicy> }) => {
    hookEvents.updateApprovalPolicy(id, updates);
    return true;
  }));

  ipcMain.handle('delete-approval-policy', withContext('delete-approval-policy', async (_, id: number) => {
    hookEvents.deleteApprovalPolicy(id);
    return true;
  }));

  logger.info('Hooks handlers registered');
}
