// ============================================================================
// HOOKS SERVICE - Claude Code Hooks Integration
// ============================================================================

import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { EventEmitter } from 'events';
import { Logger } from './logger.js';
import {
  createHook,
  getHook,
  getAllHooks,
  getHooksByEventType,
  updateHook,
  recordHookExecution,
  deleteHook,
  type HookConfig,
  type HookEventType,
} from '../database/primitives.js';

const logger = new Logger('HooksService');

// ============================================================================
// TYPES
// ============================================================================

export interface HookExecutionContext {
  eventType: HookEventType;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  sessionId?: string;
  projectPath?: string;
  timestamp: number;
}

export interface HookExecutionResult {
  hookId: number;
  hookName: string;
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  shouldBlock: boolean; // exit code 2 means block the action
}

export interface ClaudeSettingsHook {
  matcher: string;
  hooks: Array<{
    type: 'command';
    command: string;
    timeout?: number;
  }>;
}

export interface ClaudeSettings {
  hooks?: {
    PreToolUse?: ClaudeSettingsHook[];
    PostToolUse?: ClaudeSettingsHook[];
    SessionStart?: ClaudeSettingsHook[];
    SessionEnd?: ClaudeSettingsHook[];
    Notification?: ClaudeSettingsHook[];
    Stop?: ClaudeSettingsHook[];
  };
  permissions?: {
    allow?: string[];
    deny?: string[];
  };
  env?: Record<string, string>;
  [key: string]: unknown;
}

// ============================================================================
// HOOKS SERVICE
// ============================================================================

class HooksService extends EventEmitter {
  private runningProcesses: Map<number, ChildProcess> = new Map();
  private readonly DEFAULT_TIMEOUT_MS = 30000;

  constructor() {
    super();
    this.setMaxListeners(50);
  }

  // ============================================================================
  // HOOK MANAGEMENT
  // ============================================================================

  /**
   * Create a new hook
   */
  createHook(config: Omit<HookConfig, 'id' | 'executionCount' | 'lastExecuted' | 'lastResult' | 'createdAt' | 'updatedAt'>): HookConfig {
    const hook = createHook(config);
    logger.info(`Created hook: ${hook.name} (${hook.eventType})`);
    this.emit('hook:created', hook);
    return hook;
  }

  /**
   * Get a hook by ID
   */
  getHook(id: number): HookConfig | null {
    return getHook(id);
  }

  /**
   * Get all hooks
   */
  getAllHooks(scope?: 'user' | 'project', projectPath?: string): HookConfig[] {
    return getAllHooks(scope, projectPath);
  }

  /**
   * Get hooks for a specific event type
   */
  getHooksForEvent(eventType: HookEventType, projectPath?: string): HookConfig[] {
    return getHooksByEventType(eventType, projectPath);
  }

  /**
   * Update a hook
   */
  updateHook(id: number, updates: Partial<HookConfig>): void {
    updateHook(id, updates);
    const hook = getHook(id);
    if (hook) {
      logger.info(`Updated hook: ${hook.name}`);
      this.emit('hook:updated', hook);
    }
  }

  /**
   * Delete a hook
   */
  deleteHook(id: number): void {
    const hook = getHook(id);
    if (hook) {
      deleteHook(id);
      logger.info(`Deleted hook: ${hook.name}`);
      this.emit('hook:deleted', hook);
    }
  }

  /**
   * Enable/disable a hook
   */
  setHookEnabled(id: number, enabled: boolean): void {
    updateHook(id, { enabled });
    const hook = getHook(id);
    if (hook) {
      logger.info(`${enabled ? 'Enabled' : 'Disabled'} hook: ${hook.name}`);
      this.emit('hook:toggled', hook);
    }
  }

  // ============================================================================
  // HOOK EXECUTION
  // ============================================================================

  /**
   * Execute all hooks for a given event
   */
  async executeHooks(context: HookExecutionContext): Promise<HookExecutionResult[]> {
    const hooks = this.getHooksForEvent(context.eventType, context.projectPath);
    const results: HookExecutionResult[] = [];

    for (const hook of hooks) {
      // Check if hook matches the context
      if (!this.matchesContext(hook, context)) {
        continue;
      }

      const result = await this.executeHook(hook, context);
      results.push(result);

      // Record execution in database
      recordHookExecution(
        hook.id,
        result.success ? 'success' : (result.exitCode === null ? 'timeout' : 'failure')
      );

      this.emit('hook:executed', result);

      // If hook returned exit code 2, it wants to block the action
      if (result.shouldBlock) {
        logger.info(`Hook ${hook.name} requested to block action`);
        break;
      }
    }

    return results;
  }

  /**
   * Execute a single hook
   */
  async executeHook(hook: HookConfig, context: HookExecutionContext): Promise<HookExecutionResult> {
    const startTime = Date.now();

    logger.debug(`Executing hook: ${hook.name}`, { eventType: hook.eventType });

    return new Promise((resolve) => {
      const timeout = hook.timeout || this.DEFAULT_TIMEOUT_MS;
      let stdout = '';
      let stderr = '';
      let resolved = false;

      // Prepare environment
      const env = {
        ...process.env,
        GOODVIBES_HOOK_EVENT: context.eventType,
        GOODVIBES_HOOK_TOOL: context.toolName || '',
        GOODVIBES_HOOK_INPUT: context.toolInput ? JSON.stringify(context.toolInput) : '',
        GOODVIBES_HOOK_RESULT: context.toolResult || '',
        GOODVIBES_SESSION_ID: context.sessionId || '',
        GOODVIBES_PROJECT_PATH: context.projectPath || '',
        GOODVIBES_TIMESTAMP: context.timestamp.toString(),
      };

      // Spawn the command
      const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
      const shellFlag = process.platform === 'win32' ? '/c' : '-c';

      const child = spawn(shell, [shellFlag, hook.command], {
        env,
        cwd: context.projectPath || process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.runningProcesses.set(hook.id, child);

      // Set up timeout
      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          child.kill('SIGKILL');
          this.runningProcesses.delete(hook.id);

          resolve({
            hookId: hook.id,
            hookName: hook.name,
            success: false,
            exitCode: null,
            stdout,
            stderr: stderr + '\n[Hook timed out]',
            durationMs: Date.now() - startTime,
            shouldBlock: false,
          });
        }
      }, timeout);

      // Collect stdout
      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      // Collect stderr
      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      // Handle completion
      child.on('close', (exitCode) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          this.runningProcesses.delete(hook.id);

          resolve({
            hookId: hook.id,
            hookName: hook.name,
            success: exitCode === 0,
            exitCode,
            stdout,
            stderr,
            durationMs: Date.now() - startTime,
            shouldBlock: exitCode === 2, // Exit code 2 means block the action
          });
        }
      });

      // Handle errors
      child.on('error', (error) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          this.runningProcesses.delete(hook.id);

          resolve({
            hookId: hook.id,
            hookName: hook.name,
            success: false,
            exitCode: null,
            stdout,
            stderr: stderr + `\n[Error: ${error.message}]`,
            durationMs: Date.now() - startTime,
            shouldBlock: false,
          });
        }
      });
    });
  }

  /**
   * Check if a hook matches the execution context
   */
  private matchesContext(hook: HookConfig, context: HookExecutionContext): boolean {
    if (!hook.matcher || hook.matcher === '*') {
      return true;
    }

    // For tool events, match against tool name
    if (context.toolName) {
      const pattern = hook.matcher;

      // Handle patterns like "Bash(*)" or "Edit(src/*)"
      const match = pattern.match(/^(\w+)\((.*)\)$/);
      if (match) {
        const [, toolPattern, argPattern] = match;

        // Check tool name
        if (toolPattern !== '*' && toolPattern !== context.toolName) {
          return false;
        }

        // Check argument pattern (simplified glob matching)
        if (argPattern !== '*' && context.toolInput) {
          const inputStr = JSON.stringify(context.toolInput);
          const regex = new RegExp(argPattern.replace(/\*/g, '.*'));
          return regex.test(inputStr);
        }

        return true;
      }

      // Simple tool name match
      return hook.matcher === context.toolName;
    }

    return true;
  }

  /**
   * Kill a running hook
   */
  killHook(hookId: number): boolean {
    const process = this.runningProcesses.get(hookId);
    if (process) {
      process.kill('SIGKILL');
      this.runningProcesses.delete(hookId);
      logger.info(`Killed hook process: ${hookId}`);
      return true;
    }
    return false;
  }

  /**
   * Kill all running hooks
   */
  killAllHooks(): void {
    for (const [hookId, process] of this.runningProcesses) {
      process.kill('SIGKILL');
      logger.debug(`Killed hook process: ${hookId}`);
    }
    this.runningProcesses.clear();
  }

  // ============================================================================
  // CLAUDE SETTINGS INTEGRATION
  // ============================================================================

  /**
   * Read Claude settings.json
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
   * Write Claude settings.json
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
   * Sync database hooks to Claude settings.json
   */
  async syncHooksToClaudeSettings(projectPath?: string): Promise<void> {
    const hooks = this.getAllHooks();
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

  // ============================================================================
  // BUILT-IN HOOKS
  // ============================================================================

  /**
   * Get built-in GoodVibes hooks
   */
  getBuiltInHooks(): Array<Omit<HookConfig, 'id' | 'executionCount' | 'lastExecuted' | 'lastResult' | 'createdAt' | 'updatedAt'>> {
    const goodvibesHooksDir = path.join(os.homedir(), '.goodvibes', 'hooks');

    return [
      {
        name: 'GoodVibes Tool Tracker',
        eventType: 'PostToolUse' as HookEventType,
        matcher: '*',
        command: `node "${path.join(goodvibesHooksDir, 'track-tool.js')}"`,
        timeout: 5000,
        enabled: false,
        scope: 'user' as const,
        projectPath: null,
      },
      {
        name: 'GoodVibes Session Start',
        eventType: 'SessionStart' as HookEventType,
        matcher: '*',
        command: `node "${path.join(goodvibesHooksDir, 'session-start.js')}"`,
        timeout: 5000,
        enabled: false,
        scope: 'user' as const,
        projectPath: null,
      },
      {
        name: 'GoodVibes Session End',
        eventType: 'SessionEnd' as HookEventType,
        matcher: '*',
        command: `node "${path.join(goodvibesHooksDir, 'session-end.js')}"`,
        timeout: 5000,
        enabled: false,
        scope: 'user' as const,
        projectPath: null,
      },
    ];
  }

  /**
   * Install built-in hook scripts
   */
  async installBuiltInHookScripts(): Promise<void> {
    const hooksDir = path.join(os.homedir(), '.goodvibes', 'hooks');

    if (!existsSync(hooksDir)) {
      await fs.mkdir(hooksDir, { recursive: true });
    }

    // Track tool usage script
    const trackToolScript = `#!/usr/bin/env node
// GoodVibes Tool Tracker Hook
// Records tool usage to GoodVibes for analytics

const http = require('http');

const data = {
  event: process.env.GOODVIBES_HOOK_EVENT,
  tool: process.env.GOODVIBES_HOOK_TOOL,
  input: process.env.GOODVIBES_HOOK_INPUT,
  result: process.env.GOODVIBES_HOOK_RESULT,
  sessionId: process.env.GOODVIBES_SESSION_ID,
  projectPath: process.env.GOODVIBES_PROJECT_PATH,
  timestamp: process.env.GOODVIBES_TIMESTAMP,
};

// Log to local GoodVibes server (if running)
const req = http.request({
  hostname: 'localhost',
  port: 23847,
  path: '/api/hooks/tool-usage',
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  timeout: 2000,
}, (res) => {
  process.exit(0);
});

req.on('error', () => process.exit(0));
req.write(JSON.stringify(data));
req.end();
`;

    // Session start script
    const sessionStartScript = `#!/usr/bin/env node
// GoodVibes Session Start Hook
// Notifies GoodVibes when a new session starts

const http = require('http');

const data = {
  event: 'SessionStart',
  sessionId: process.env.GOODVIBES_SESSION_ID,
  projectPath: process.env.GOODVIBES_PROJECT_PATH,
  timestamp: process.env.GOODVIBES_TIMESTAMP,
};

const req = http.request({
  hostname: 'localhost',
  port: 23847,
  path: '/api/hooks/session-start',
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  timeout: 2000,
}, () => process.exit(0));

req.on('error', () => process.exit(0));
req.write(JSON.stringify(data));
req.end();
`;

    // Session end script
    const sessionEndScript = `#!/usr/bin/env node
// GoodVibes Session End Hook
// Notifies GoodVibes when a session ends

const http = require('http');

const data = {
  event: 'SessionEnd',
  sessionId: process.env.GOODVIBES_SESSION_ID,
  projectPath: process.env.GOODVIBES_PROJECT_PATH,
  timestamp: process.env.GOODVIBES_TIMESTAMP,
};

const req = http.request({
  hostname: 'localhost',
  port: 23847,
  path: '/api/hooks/session-end',
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  timeout: 2000,
}, () => process.exit(0));

req.on('error', () => process.exit(0));
req.write(JSON.stringify(data));
req.end();
`;

    await fs.writeFile(path.join(hooksDir, 'track-tool.js'), trackToolScript, 'utf-8');
    await fs.writeFile(path.join(hooksDir, 'session-start.js'), sessionStartScript, 'utf-8');
    await fs.writeFile(path.join(hooksDir, 'session-end.js'), sessionEndScript, 'utf-8');

    logger.info(`Installed built-in hook scripts to: ${hooksDir}`);
  }

  // ============================================================================
  // SHUTDOWN
  // ============================================================================

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
