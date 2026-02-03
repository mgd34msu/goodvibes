// ============================================================================
// HOOKS SERVICE - Hook Management (CRUD Operations)
// ============================================================================

import { Logger } from '../logger.js';
import {
  createHook as dbCreateHook,
  getHook as dbGetHook,
  getAllHooks as dbGetAllHooks,
  getHooksByEventType,
  updateHook as dbUpdateHook,
  deleteHook as dbDeleteHook,
} from '../../database/primitives.js';
import type { HookConfig, HookEventType } from './types.js';

const logger = new Logger('HookManagement');

/**
 * Hook creation input type - excludes auto-generated fields
 */
export type HookCreateInput = Omit<
  HookConfig,
  'id' | 'executionCount' | 'lastExecuted' | 'lastResult' | 'createdAt' | 'updatedAt'
>;

/**
 * Manages hook CRUD operations and provides event callbacks
 */
export class HookManager {
  private onCreated?: (hook: HookConfig) => void;
  private onUpdated?: (hook: HookConfig) => void;
  private onDeleted?: (hook: HookConfig) => void;
  private onToggled?: (hook: HookConfig) => void;

  /**
   * Set callbacks for hook lifecycle events
   */
  setCallbacks(callbacks: {
    onCreated?: (hook: HookConfig) => void;
    onUpdated?: (hook: HookConfig) => void;
    onDeleted?: (hook: HookConfig) => void;
    onToggled?: (hook: HookConfig) => void;
  }): void {
    this.onCreated = callbacks.onCreated;
    this.onUpdated = callbacks.onUpdated;
    this.onDeleted = callbacks.onDeleted;
    this.onToggled = callbacks.onToggled;
  }

  /**
   * Create a new hook
   */
  createHook(config: HookCreateInput): HookConfig {
    const hook = dbCreateHook(config);
    logger.info(`Created hook: ${hook.name} (${hook.eventType})`);
    this.onCreated?.(hook);
    return hook;
  }

  /**
   * Get a hook by ID
   */
  getHook(id: number): HookConfig | null {
    return dbGetHook(id);
  }

  /**
   * Get all hooks, optionally filtered by scope and project path
   */
  getAllHooks(scope?: 'user' | 'project', projectPath?: string): HookConfig[] {
    return dbGetAllHooks(scope, projectPath);
  }

  /**
   * Get hooks for a specific event type
   */
  getHooksForEvent(eventType: HookEventType, projectPath?: string): HookConfig[] {
    return getHooksByEventType(eventType, projectPath);
  }

  /**
   * Update a hook's configuration
   */
  updateHook(id: number, updates: Partial<HookConfig>): void {
    dbUpdateHook(id, updates);
    const hook = dbGetHook(id);
    if (hook) {
      logger.info(`Updated hook: ${hook.name}`);
      this.onUpdated?.(hook);
    }
  }

  /**
   * Delete a hook by ID
   */
  deleteHook(id: number): void {
    const hook = dbGetHook(id);
    if (hook) {
      dbDeleteHook(id);
      logger.info(`Deleted hook: ${hook.name}`);
      this.onDeleted?.(hook);
    }
  }

  /**
   * Enable or disable a hook
   */
  setHookEnabled(id: number, enabled: boolean): void {
    dbUpdateHook(id, { enabled });
    const hook = dbGetHook(id);
    if (hook) {
      logger.info(`${enabled ? 'Enabled' : 'Disabled'} hook: ${hook.name}`);
      this.onToggled?.(hook);
    }
  }
}
