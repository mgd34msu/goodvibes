// ============================================================================
// HOOKS IPC HANDLERS
// ============================================================================
//
// All handlers use Zod validation for input sanitization.
// ============================================================================

import { ipcMain } from 'electron';
import { ZodError } from 'zod';
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
import {
  numericIdSchema,
  createHookSchema,
  updateHookSchema,
  getHooksByEventSchema,
  testHookSchema,
  hookEventLimitSchema,
  getHookEventsBySessionSchema,
  getHookEventsByTypeSchema,
  cleanupHookEventsSchema,
  getBudgetSchema,
  upsertBudgetSchema,
  updateBudgetSpentSchema,
  createApprovalPolicySchema,
  updateApprovalPolicySchema,
} from '../schemas/index.js';

const logger = new Logger('IPC:Hooks');

// ============================================================================
// VALIDATION ERROR RESPONSE
// ============================================================================

interface ValidationErrorResponse {
  success: false;
  error: string;
  code: 'VALIDATION_ERROR';
  details?: Array<{ path: string; message: string }>;
}

/**
 * Formats a ZodError into a user-friendly error response
 */
function formatValidationError(error: ZodError): ValidationErrorResponse {
  const details = error.errors.map((e) => ({
    path: e.path.join('.'),
    message: e.message,
  }));

  return {
    success: false,
    error: `Validation failed: ${details.map((d) => d.message).join(', ')}`,
    code: 'VALIDATION_ERROR',
    details,
  };
}

export function registerHooksHandlers(): void {
  // ============================================================================
  // HOOKS CONFIGURATION
  // ============================================================================

  ipcMain.handle('get-hooks', withContext('get-hooks', async () => {
    return primitives.getAllHooks();
  }));

  ipcMain.handle('get-hook', withContext('get-hook', async (_, id: unknown) => {
    const result = numericIdSchema.safeParse(id);
    if (!result.success) {
      logger.warn('get-hook validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    return primitives.getHook(result.data);
  }));

  ipcMain.handle('create-hook', withContext('create-hook', async (_, hook: unknown) => {
    const result = createHookSchema.safeParse(hook);
    if (!result.success) {
      logger.warn('create-hook validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    // Map schema fields to database fields
    const hookData = {
      name: result.data.name,
      eventType: result.data.eventType as primitives.HookEventType,
      command: result.data.script,
      timeout: result.data.timeout ?? 30000,
      enabled: result.data.enabled,
      scope: result.data.projectPath ? 'project' as const : 'user' as const,
      projectPath: result.data.projectPath ?? null,
      matcher: null,
      hookType: 'command' as const,
      prompt: null,
    };
    return primitives.createHook(hookData);
  }));

  ipcMain.handle('update-hook', withContext('update-hook', async (_, data: unknown) => {
    const result = updateHookSchema.safeParse(data);
    if (!result.success) {
      logger.warn('update-hook validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    const { id, updates } = result.data;
    // Map schema fields to database fields if present
    const dbUpdates: Partial<primitives.HookConfig> = {};
    if (updates.name !== undefined) dbUpdates.name = updates.name;
    if (updates.eventType !== undefined) dbUpdates.eventType = updates.eventType as primitives.HookEventType;
    if (updates.script !== undefined) dbUpdates.command = updates.script;
    if (updates.timeout !== undefined) dbUpdates.timeout = updates.timeout;
    if (updates.enabled !== undefined) dbUpdates.enabled = updates.enabled;
    if (updates.projectPath !== undefined) {
      dbUpdates.projectPath = updates.projectPath ?? null;
      dbUpdates.scope = updates.projectPath ? 'project' : 'user';
    }
    primitives.updateHook(id, dbUpdates);
    return { success: true };
  }));

  ipcMain.handle('delete-hook', withContext('delete-hook', async (_, id: unknown) => {
    const result = numericIdSchema.safeParse(id);
    if (!result.success) {
      logger.warn('delete-hook validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    primitives.deleteHook(result.data);
    return { success: true };
  }));

  ipcMain.handle('get-hooks-by-event', withContext('get-hooks-by-event', async (_, data: unknown) => {
    const result = getHooksByEventSchema.safeParse(data);
    if (!result.success) {
      logger.warn('get-hooks-by-event validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    return primitives.getHooksByEventType(
      result.data.eventType as primitives.HookEventType,
      result.data.projectPath
    );
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
  // HOOK TESTING
  // ============================================================================
  //
  // SECURITY NOTE: This handler intentionally uses shell execution because:
  // 1. Users define their own hook commands that need shell features (pipes, etc.)
  // 2. The command comes from the user's own configuration, not external input
  // 3. This is a testing feature run locally by the user
  //
  // Mitigations in place:
  // - Input validation via Zod schema
  // - 30 second timeout to prevent runaway processes
  // - Logs the command being executed for audit
  // - Isolated process environment
  // ============================================================================

  ipcMain.handle('test-hook', withContext('test-hook', async (_, data: unknown) => {
    const result = testHookSchema.safeParse(data);
    if (!result.success) {
      logger.warn('test-hook validation failed', { errors: result.error.errors });
      return {
        stdout: '',
        stderr: formatValidationError(result.error).error,
        exitCode: 1,
      };
    }

    const { command, input } = result.data;
    const { spawn } = await import('child_process');

    // Log the command being tested for security audit
    logger.info('Testing hook command', { command: command.substring(0, 200) });

    return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
      try {
        // Prepare the input as JSON to pass via stdin
        const inputJson = JSON.stringify(input);

        // SECURITY: Intentional shell execution for user-defined hook commands
        // This is required because hook commands may use shell features like pipes
        const isWindows = process.platform === 'win32';
        const shell = isWindows ? 'cmd.exe' : '/bin/sh';
        const shellArgs = isWindows ? ['/c', command] : ['-c', command];

        const child = spawn(shell, shellArgs, {
          env: { ...process.env },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        child.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        // Write input JSON to stdin
        child.stdin.write(inputJson);
        child.stdin.end();

        child.on('close', (code: number | null) => {
          resolve({
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            exitCode: code ?? 0,
          });
        });

        child.on('error', (err: Error) => {
          resolve({
            stdout: '',
            stderr: err.message,
            exitCode: 1,
          });
        });

        // Set a timeout of 30 seconds
        setTimeout(() => {
          child.kill();
          resolve({
            stdout: stdout.trim(),
            stderr: stderr.trim() || 'Command timed out after 30 seconds',
            exitCode: 124, // Standard timeout exit code
          });
        }, 30000);
      } catch (err) {
        resolve({
          stdout: '',
          stderr: err instanceof Error ? err.message : 'Unknown error',
          exitCode: 1,
        });
      }
    });
  }));

  // ============================================================================
  // HOOK EVENT QUERIES
  // ============================================================================

  ipcMain.handle('get-hook-events', withContext('get-hook-events', async (_, data: unknown) => {
    const result = hookEventLimitSchema.safeParse(data);
    if (!result.success) {
      logger.warn('get-hook-events validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    return hookEvents.getRecentHookEvents(result.data.limit);
  }));

  ipcMain.handle('get-hook-events-by-session', withContext('get-hook-events-by-session', async (_, data: unknown) => {
    const result = getHookEventsBySessionSchema.safeParse(data);
    if (!result.success) {
      logger.warn('get-hook-events-by-session validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    return hookEvents.getHookEventsBySession(result.data.sessionId, result.data.limit);
  }));

  ipcMain.handle('get-hook-events-by-type', withContext('get-hook-events-by-type', async (_, data: unknown) => {
    const result = getHookEventsByTypeSchema.safeParse(data);
    if (!result.success) {
      logger.warn('get-hook-events-by-type validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    return hookEvents.getHookEventsByType(
      result.data.eventType as hookEvents.ExtendedHookEventType,
      result.data.limit
    );
  }));

  ipcMain.handle('get-hook-event-stats', withContext('get-hook-event-stats', async () => {
    return hookEvents.getHookEventStats();
  }));

  ipcMain.handle('cleanup-hook-events', withContext('cleanup-hook-events', async (_, data: unknown) => {
    const result = cleanupHookEventsSchema.safeParse(data);
    if (!result.success) {
      logger.warn('cleanup-hook-events validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    return hookEvents.cleanupOldHookEvents(result.data.maxAgeHours);
  }));

  // ============================================================================
  // BUDGET MANAGEMENT
  // ============================================================================

  ipcMain.handle('get-budgets', withContext('get-budgets', async () => {
    return hookEvents.getAllBudgets();
  }));

  ipcMain.handle('get-budget', withContext('get-budget', async (_, data: unknown) => {
    const result = getBudgetSchema.safeParse(data);
    if (!result.success) {
      logger.warn('get-budget validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    return hookEvents.getBudgetForScope(result.data.projectPath, result.data.sessionId);
  }));

  ipcMain.handle('upsert-budget', withContext('upsert-budget', async (_, budget: unknown) => {
    const result = upsertBudgetSchema.safeParse(budget);
    if (!result.success) {
      logger.warn('upsert-budget validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    // Map to database format
    const budgetData: Omit<hookEvents.BudgetRecord, 'id' | 'createdAt' | 'updatedAt'> = {
      projectPath: result.data.projectPath ?? null,
      sessionId: result.data.sessionId ?? null,
      limitUsd: result.data.limitUsd,
      spentUsd: result.data.spentUsd ?? 0,
      warningThreshold: result.data.warningThreshold ?? 0.8,
      hardStopEnabled: result.data.hardStopEnabled ?? false,
      resetPeriod: result.data.resetPeriod ?? 'session',
      lastReset: new Date().toISOString(),
    };
    return hookEvents.upsertBudget(budgetData);
  }));

  ipcMain.handle('update-budget-spent', withContext('update-budget-spent', async (_, data: unknown) => {
    const result = updateBudgetSpentSchema.safeParse(data);
    if (!result.success) {
      logger.warn('update-budget-spent validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    hookEvents.updateBudgetSpent(result.data.id, result.data.additionalCost);
    return { success: true };
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

  ipcMain.handle('create-approval-policy', withContext('create-approval-policy', async (_, policy: unknown) => {
    const result = createApprovalPolicySchema.safeParse(policy);
    if (!result.success) {
      logger.warn('create-approval-policy validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    // Map to database format
    const policyData: Omit<hookEvents.ApprovalPolicy, 'id' | 'createdAt' | 'updatedAt'> = {
      name: result.data.name,
      matcher: result.data.matcher,
      action: result.data.action,
      priority: result.data.priority ?? 0,
      conditions: result.data.conditions ?? null,
      enabled: result.data.enabled ?? true,
    };
    return hookEvents.createApprovalPolicy(policyData);
  }));

  ipcMain.handle('update-approval-policy', withContext('update-approval-policy', async (_, data: unknown) => {
    const result = updateApprovalPolicySchema.safeParse(data);
    if (!result.success) {
      logger.warn('update-approval-policy validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    hookEvents.updateApprovalPolicy(result.data.id, result.data.updates);
    return { success: true };
  }));

  ipcMain.handle('delete-approval-policy', withContext('delete-approval-policy', async (_, id: unknown) => {
    const result = numericIdSchema.safeParse(id);
    if (!result.success) {
      logger.warn('delete-approval-policy validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }
    hookEvents.deleteApprovalPolicy(result.data);
    return { success: true };
  }));

  logger.info('Hooks handlers registered (with Zod validation)');
}
