// ============================================================================
// HOOKS SERVICE - Main Entry Point
// ============================================================================
//
// This module provides the unified HooksService that integrates:
// - Hook management (CRUD operations)
// - Hook execution (process spawning, timeout handling)
// - Claude settings integration (settings.json sync)
// - Built-in hooks (GoodVibes tracking hooks)
//
// For backward compatibility, all types and the service are re-exported
// from this index file.
// ============================================================================

import { EventEmitter } from 'events';
import { Logger } from '../logger.js';
import { HookExecutor } from './hook-execution.js';
import { HookManager, type HookCreateInput } from './hook-management.js';
import { ClaudeSettingsManager } from './claude-integration.js';
import { getBuiltInHooks, installBuiltInHookScripts, type BuiltinHookConfig } from './builtin-hooks.js';
import type {
  HookConfig,
  HookEventType,
  HookExecutionContext,
  HookExecutionResult,
  ClaudeSettings,
} from './types.js';

// Re-export all types for backward compatibility
export type {
  HookConfig,
  HookEventType,
  HookExecutionContext,
  HookExecutionResult,
  ClaudeSettings,
  ClaudeSettingsHook,
} from './types.js';

export type { HookCreateInput } from './hook-management.js';
export type { BuiltinHookConfig } from './builtin-hooks.js';

const logger = new Logger('HooksService');

// ============================================================================
// HOOKS SERVICE CLASS
// ============================================================================

/**
 * Main HooksService that orchestrates all hook functionality.
 * Maintains the same public API as the original monolithic implementation.
 */
class HooksService extends EventEmitter {
  private executor: HookExecutor;
  private manager: HookManager;
  private claudeSettings: ClaudeSettingsManager;

  constructor() {
    super();
    this.setMaxListeners(50);

    this.executor = new HookExecutor();
    this.manager = new HookManager();
    this.claudeSettings = new ClaudeSettingsManager();

    // Wire up manager events to service events
    this.manager.setCallbacks({
      onCreated: (hook) => this.emit('hook:created', hook),
      onUpdated: (hook) => this.emit('hook:updated', hook),
      onDeleted: (hook) => this.emit('hook:deleted', hook),
      onToggled: (hook) => this.emit('hook:toggled', hook),
    });
  }

  // ==========================================================================
  // HOOK MANAGEMENT
  // ==========================================================================

  createHook(config: HookCreateInput): HookConfig {
    return this.manager.createHook(config);
  }

  getHook(id: number): HookConfig | null {
    return this.manager.getHook(id);
  }

  getAllHooks(scope?: 'user' | 'project', projectPath?: string): HookConfig[] {
    return this.manager.getAllHooks(scope, projectPath);
  }

  getHooksForEvent(eventType: HookEventType, projectPath?: string): HookConfig[] {
    return this.manager.getHooksForEvent(eventType, projectPath);
  }

  updateHook(id: number, updates: Partial<HookConfig>): void {
    this.manager.updateHook(id, updates);
  }

  deleteHook(id: number): void {
    this.manager.deleteHook(id);
  }

  setHookEnabled(id: number, enabled: boolean): void {
    this.manager.setHookEnabled(id, enabled);
  }

  // ==========================================================================
  // HOOK EXECUTION
  // ==========================================================================

  async executeHooks(context: HookExecutionContext): Promise<HookExecutionResult[]> {
    const hooks = this.getHooksForEvent(context.eventType, context.projectPath);
    return this.executor.executeHooks(hooks, context, (result) => {
      this.emit('hook:executed', result);
    });
  }

  async executeHook(hook: HookConfig, context: HookExecutionContext): Promise<HookExecutionResult> {
    return this.executor.executeHook(hook, context);
  }

  killHook(hookId: number): boolean {
    return this.executor.killHook(hookId);
  }

  killAllHooks(): void {
    this.executor.killAllHooks();
  }

  // ==========================================================================
  // CLAUDE SETTINGS INTEGRATION
  // ==========================================================================

  async readClaudeSettings(projectPath?: string): Promise<ClaudeSettings | null> {
    return this.claudeSettings.readClaudeSettings(projectPath);
  }

  async writeClaudeSettings(
    settings: ClaudeSettings,
    scope: 'user' | 'project' | 'local' = 'user',
    projectPath?: string
  ): Promise<string> {
    return this.claudeSettings.writeClaudeSettings(settings, scope, projectPath);
  }

  async addHookToClaudeSettings(
    eventType: HookEventType,
    matcher: string,
    command: string,
    scope: 'user' | 'project' | 'local' = 'user',
    projectPath?: string
  ): Promise<void> {
    return this.claudeSettings.addHookToClaudeSettings(eventType, matcher, command, scope, projectPath);
  }

  async removeHookFromClaudeSettings(
    eventType: HookEventType,
    matcher: string,
    command: string,
    scope: 'user' | 'project' | 'local' = 'user',
    projectPath?: string
  ): Promise<void> {
    return this.claudeSettings.removeHookFromClaudeSettings(eventType, matcher, command, scope, projectPath);
  }

  async syncHooksToClaudeSettings(projectPath?: string): Promise<void> {
    const hooks = this.getAllHooks();
    return this.claudeSettings.syncHooksToClaudeSettings(hooks, projectPath);
  }

  // ==========================================================================
  // BUILT-IN HOOKS
  // ==========================================================================

  getBuiltInHooks(): BuiltinHookConfig[] {
    return getBuiltInHooks();
  }

  async installBuiltInHookScripts(): Promise<void> {
    return installBuiltInHookScripts();
  }

  // ==========================================================================
  // SHUTDOWN
  // ==========================================================================

  shutdown(): void {
    this.killAllHooks();
    this.removeAllListeners();
    logger.info('Hooks service shut down');
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let hooksService: HooksService | null = null;

export function getHooksService(): HooksService {
  if (!hooksService) {
    hooksService = new HooksService();
  }
  return hooksService;
}

export function shutdownHooksService(): void {
  if (hooksService) {
    hooksService.shutdown();
    hooksService = null;
  }
}

// Export the class for testing
export { HooksService };
