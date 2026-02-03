// ============================================================================
// HOOKS SERVICE - Claude Settings Integration
// ============================================================================

import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { Logger } from '../logger.js';
import type { HookConfig, HookEventType, ClaudeSettings } from './types.js';

const logger = new Logger('ClaudeIntegration');

/**
 * Manages integration with Claude's settings.json files
 * for hook synchronization and configuration.
 */
export class ClaudeSettingsManager {
  /**
   * Read Claude settings.json from the appropriate location
   * Priority: project local > project > user global
   */
  async readClaudeSettings(projectPath?: string): Promise<ClaudeSettings | null> {
    const paths = [
      projectPath ? path.join(projectPath, '.claude', 'settings.local.json') : null,
      projectPath ? path.join(projectPath, '.claude', 'settings.json') : null,
      path.join(os.homedir(), '.claude', 'settings.json'),
    ].filter(Boolean) as string[];

    for (const settingsPath of paths) {
      if (existsSync(settingsPath)) {
        try {
          const content = await fs.readFile(settingsPath, 'utf-8');
          return JSON.parse(content);
        } catch (error) {
          logger.warn(`Failed to read settings: ${settingsPath}`, error);
        }
      }
    }

    return null;
  }

  /**
   * Write Claude settings.json to the specified scope
   */
  async writeClaudeSettings(
    settings: ClaudeSettings,
    scope: 'user' | 'project' | 'local' = 'user',
    projectPath?: string
  ): Promise<string> {
    let settingsPath: string;

    if (scope === 'user') {
      settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    } else if (scope === 'project' && projectPath) {
      settingsPath = path.join(projectPath, '.claude', 'settings.json');
    } else if (scope === 'local' && projectPath) {
      settingsPath = path.join(projectPath, '.claude', 'settings.local.json');
    } else {
      throw new Error('Project path required for project/local scope');
    }

    // Ensure directory exists
    const dir = path.dirname(settingsPath);
    if (!existsSync(dir)) {
      await fs.mkdir(dir, { recursive: true });
    }

    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    logger.info(`Wrote Claude settings: ${settingsPath}`);

    return settingsPath;
  }

  /**
   * Add a hook to Claude settings.json
   */
  async addHookToClaudeSettings(
    eventType: HookEventType,
    matcher: string,
    command: string,
    scope: 'user' | 'project' | 'local' = 'user',
    projectPath?: string
  ): Promise<void> {
    const settings = await this.readClaudeSettings(projectPath) || {};

    if (!settings.hooks) {
      settings.hooks = {};
    }

    if (!settings.hooks[eventType]) {
      settings.hooks[eventType] = [];
    }

    // Check if hook already exists
    const eventHooks = settings.hooks[eventType];
    if (!eventHooks) return;

    const existing = eventHooks.find(
      h => h.matcher === matcher && h.hooks.some(hook => hook.command === command)
    );

    if (!existing) {
      eventHooks.push({
        matcher,
        hooks: [{ type: 'command', command }],
      });
    }

    await this.writeClaudeSettings(settings, scope, projectPath);
  }

  /**
   * Remove a hook from Claude settings.json
   */
  async removeHookFromClaudeSettings(
    eventType: HookEventType,
    matcher: string,
    command: string,
    scope: 'user' | 'project' | 'local' = 'user',
    projectPath?: string
  ): Promise<void> {
    const settings = await this.readClaudeSettings(projectPath);
    if (!settings?.hooks?.[eventType]) return;

    const eventHooksToFilter = settings.hooks[eventType];
    if (eventHooksToFilter) {
      settings.hooks[eventType] = eventHooksToFilter.filter(
        h => !(h.matcher === matcher && h.hooks.some(hook => hook.command === command))
      );
    }

    await this.writeClaudeSettings(settings, scope, projectPath);
  }

  /**
   * Sync database hooks to Claude settings.json files
   */
  async syncHooksToClaudeSettings(
    hooks: HookConfig[],
    projectPath?: string
  ): Promise<void> {
    const userSettings: ClaudeSettings = await this.readClaudeSettings() || {};
    const projectSettings: ClaudeSettings = projectPath
      ? await this.readClaudeSettings(projectPath) || {}
      : {};

    // Clear existing hooks from settings
    if (userSettings.hooks) {
      userSettings.hooks = {};
    }
    if (projectSettings.hooks) {
      projectSettings.hooks = {};
    }

    // Add hooks from database
    for (const hook of hooks) {
      if (!hook.enabled) continue;

      const settings = hook.scope === 'user' ? userSettings : projectSettings;

      if (!settings.hooks) {
        settings.hooks = {};
      }

      if (!settings.hooks[hook.eventType]) {
        settings.hooks[hook.eventType] = [];
      }

      const targetHooks = settings.hooks[hook.eventType];
      if (targetHooks) {
        targetHooks.push({
          matcher: hook.matcher || '*',
          hooks: [{
            type: 'command',
            command: hook.command,
            timeout: hook.timeout,
          }],
        });
      }
    }

    // Write settings
    await this.writeClaudeSettings(userSettings, 'user');
    if (projectPath && Object.keys(projectSettings.hooks || {}).length > 0) {
      await this.writeClaudeSettings(projectSettings, 'project', projectPath);
    }

    logger.info('Synced hooks to Claude settings');
  }
}
