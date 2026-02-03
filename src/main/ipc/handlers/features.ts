// ============================================================================
// FEATURES IPC HANDLERS
// ============================================================================
//
// Handles installation of Claude Code features (agents, skills, commands, hooks)
// to the user's .claude/ directory structure.
//
// All handlers use Zod validation for input sanitization.
// ============================================================================

import { ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ZodError } from 'zod';
import { Logger } from '../../services/logger.js';
import { withContext } from '../utils.js';
import {
  installAgentSchema,
  installSkillSchema,
  installCommandSchema,
  installHookSchema,
  uninstallAgentSchema,
  uninstallSkillSchema,
  uninstallCommandSchema,
  uninstallHookSchema,
  type InstallAgentInput,
  type InstallSkillInput,
  type InstallCommandInput,
  type InstallHookInput,
  type UninstallAgentInput,
  type UninstallSkillInput,
  type UninstallCommandInput,
  type UninstallHookInput,
} from '../schemas/features.js';

const logger = new Logger('IPC:Features');

// Validation helpers are imported from shared utils
import { ValidationErrorResponse, formatValidationError } from '../utils/validation-helpers.js';

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get the base directory for feature installation
 */
function getBaseDir(scope: 'user' | 'project', projectPath?: string): string {
  if (scope === 'user') {
    return path.join(os.homedir(), '.claude');
  } else {
    if (!projectPath) {
      throw new Error('Project path is required for project scope');
    }
    return path.join(projectPath, '.claude');
  }
}

/**
 * Ensure directory exists
 */
function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    logger.debug('Created directory', { dirPath });
  }
}

/**
 * Write a markdown file
 */
function writeMarkdownFile(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf-8');
  logger.info('Wrote markdown file', { filePath });
}

/**
 * Write a hook script file
 */
function writeHookScript(filePath: string, script: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, script, 'utf-8');

  // Make executable on Unix systems
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(filePath, 0o755);
      logger.debug('Made script executable', { filePath });
    } catch (error) {
      logger.warn('Failed to make script executable', { filePath, error });
    }
  }

  logger.info('Wrote hook script', { filePath });
}

/**
 * Update settings.json with hook configuration
 */
function updateSettingsWithHook(
  baseDir: string,
  hookName: string,
  eventType: string,
  matcher?: string,
  fullScriptPath?: string
): void {
  const settingsPath = path.join(baseDir, 'settings.json');

  // Read existing settings or create new
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      const content = fs.readFileSync(settingsPath, 'utf-8');
      settings = JSON.parse(content);
    } catch (error) {
      logger.warn('Failed to parse existing settings.json, creating new', { error });
    }
  }

  // Ensure hooks object exists
  if (!settings.hooks || typeof settings.hooks !== 'object') {
    settings.hooks = {};
  }

  const hooks = settings.hooks as Record<string, unknown[]>;

  // Ensure event type array exists
  if (!Array.isArray(hooks[eventType])) {
    hooks[eventType] = [];
  }

  // Use full path if provided, otherwise construct from baseDir
  // Path is stored as-is - JSON.stringify handles escaping
  const scriptPath = fullScriptPath || path.join(baseDir, 'hooks', `${hookName}.sh`);

  // Add hook configuration
  const hookConfig: Record<string, string> = {
    command: scriptPath,
  };

  if (matcher) {
    hookConfig.matcher = matcher;
  }

  // Check if hook already exists (by command path or hook name)
  const existingIndex = hooks[eventType].findIndex((h) => {
    if (typeof h !== 'object' || h === null || !('command' in h)) return false;
    const cmd = (h as { command: string }).command;
    // Match by exact path or by hook filename for backwards compatibility
    return cmd === scriptPath || cmd.endsWith(`${hookName}.sh`);
  });

  if (existingIndex >= 0) {
    // Update existing hook
    hooks[eventType][existingIndex] = hookConfig;
    logger.debug('Updated existing hook in settings.json', { eventType, hookName });
  } else {
    // Add new hook
    hooks[eventType].push(hookConfig);
    logger.debug('Added new hook to settings.json', { eventType, hookName });
  }

  // Write updated settings
  ensureDir(path.dirname(settingsPath));
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  logger.info('Updated settings.json with hook configuration', { settingsPath });
}

/**
 * Remove hook from settings.json
 */
function removeHookFromSettings(
  baseDir: string,
  hookName: string,
  eventType: string
): void {
  const settingsPath = path.join(baseDir, 'settings.json');

  // Read existing settings
  if (!fs.existsSync(settingsPath)) {
    logger.debug('settings.json does not exist, nothing to remove', { settingsPath });
    return;
  }

  let settings: Record<string, unknown> = {};
  try {
    const content = fs.readFileSync(settingsPath, 'utf-8');
    settings = JSON.parse(content);
  } catch (error) {
    logger.warn('Failed to parse settings.json, cannot remove hook', { error });
    return;
  }

  // Check if hooks object exists
  if (!settings.hooks || typeof settings.hooks !== 'object') {
    logger.debug('No hooks in settings.json', { settingsPath });
    return;
  }

  const hooks = settings.hooks as Record<string, unknown[]>;

  // Check if event type array exists
  if (!Array.isArray(hooks[eventType])) {
    logger.debug('Event type not found in settings.json', { eventType });
    return;
  }

  // Hook scripts are always bash scripts (.sh)
  // Support both full path and relative path formats for backwards compatibility
  const fullScriptPath = path.join(baseDir, 'hooks', `${hookName}.sh`);
  const relativeScriptPath = `.claude/hooks/${hookName}.sh`;

  // Find and remove the hook (match by full path, relative path, or hook name in path)
  const originalLength = hooks[eventType].length;
  hooks[eventType] = hooks[eventType].filter((h) => {
    if (typeof h !== 'object' || h === null || !('command' in h)) return true;
    const cmd = (h as { command: string }).command;
    // Remove if matches full path, relative path, or ends with the hook filename
    return cmd !== fullScriptPath && cmd !== relativeScriptPath && !cmd.endsWith(`${hookName}.sh`);
  });

  if (hooks[eventType].length === originalLength) {
    logger.debug('Hook not found in settings.json', { hookName, eventType });
    return;
  }

  // If array is now empty, remove the event type key
  if (hooks[eventType].length === 0) {
    delete hooks[eventType];
    logger.debug('Removed empty event type from settings.json', { eventType });
  }

  // If hooks object is now empty, remove it
  if (Object.keys(hooks).length === 0) {
    delete settings.hooks;
    logger.debug('Removed empty hooks object from settings.json');
  }

  // Write updated settings
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  logger.info('Removed hook from settings.json', { hookName, eventType, settingsPath });
}

/**
 * Delete a file safely (doesn't throw if file doesn't exist)
 */
function deleteFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      logger.info('Deleted file', { filePath });
    } else {
      logger.debug('File does not exist, nothing to delete', { filePath });
    }
  } catch (error) {
    logger.warn('Failed to delete file', { filePath, error });
    throw error;
  }
}

// ============================================================================
// HANDLERS
// ============================================================================

export function registerFeatureHandlers(): void {
  /**
   * Install an agent to .claude/agents/
   */
  ipcMain.handle('feature:installAgent', withContext('feature:installAgent', async (_, data: unknown) => {
    const result = installAgentSchema.safeParse(data);
    if (!result.success) {
      logger.warn('feature:installAgent validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }

    try {
      const { name, content, scope, projectPath } = result.data;
      const baseDir = getBaseDir(scope, projectPath);
      const agentsDir = path.join(baseDir, 'agents');
      const filePath = path.join(agentsDir, `${name}.md`);

      writeMarkdownFile(filePath, content);

      logger.info('Agent installed successfully', { name, scope, filePath });
      return { success: true, filePath };
    } catch (error) {
      logger.error('Failed to install agent', { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }));

  /**
   * Install a skill to .claude/skills/
   */
  ipcMain.handle('feature:installSkill', withContext('feature:installSkill', async (_, data: unknown) => {
    const result = installSkillSchema.safeParse(data);
    if (!result.success) {
      logger.warn('feature:installSkill validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }

    try {
      const { name, content, scope, projectPath } = result.data;
      const baseDir = getBaseDir(scope, projectPath);
      const skillsDir = path.join(baseDir, 'skills');
      const filePath = path.join(skillsDir, `${name}.md`);

      writeMarkdownFile(filePath, content);

      logger.info('Skill installed successfully', { name, scope, filePath });
      return { success: true, filePath };
    } catch (error) {
      logger.error('Failed to install skill', { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }));

  /**
   * Install a command to .claude/commands/
   */
  ipcMain.handle('feature:installCommand', withContext('feature:installCommand', async (_, data: unknown) => {
    const result = installCommandSchema.safeParse(data);
    if (!result.success) {
      logger.warn('feature:installCommand validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }

    try {
      const { name, content, scope, projectPath } = result.data;
      const baseDir = getBaseDir(scope, projectPath);
      const commandsDir = path.join(baseDir, 'commands');
      const filePath = path.join(commandsDir, `${name}.md`);

      writeMarkdownFile(filePath, content);

      logger.info('Command installed successfully', { name, scope, filePath });
      return { success: true, filePath };
    } catch (error) {
      logger.error('Failed to install command', { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }));

  /**
   * Install a hook to .claude/hooks/ and update settings.json
   */
  ipcMain.handle('feature:installHook', withContext('feature:installHook', async (_, data: unknown) => {
    const result = installHookSchema.safeParse(data);
    if (!result.success) {
      logger.warn('feature:installHook validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }

    try {
      const { name, script, eventType, matcher, scope, projectPath } = result.data;
      const baseDir = getBaseDir(scope, projectPath);
      const hooksDir = path.join(baseDir, 'hooks');

      // Hook scripts are always bash scripts (.sh)
      const filePath = path.join(hooksDir, `${name}.sh`);

      // Write hook script
      writeHookScript(filePath, script);

      // Update settings.json with full path to hook script
      updateSettingsWithHook(baseDir, name, eventType, matcher, filePath);

      logger.info('Hook installed successfully', { name, eventType, scope, filePath });
      return { success: true, filePath };
    } catch (error) {
      logger.error('Failed to install hook', { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }));

  /**
   * Uninstall an agent from .claude/agents/
   */
  ipcMain.handle('feature:uninstallAgent', withContext('feature:uninstallAgent', async (_, data: unknown) => {
    const result = uninstallAgentSchema.safeParse(data);
    if (!result.success) {
      logger.warn('feature:uninstallAgent validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }

    try {
      const { name, scope, projectPath } = result.data;
      const baseDir = getBaseDir(scope, projectPath);
      const agentsDir = path.join(baseDir, 'agents');
      const filePath = path.join(agentsDir, `${name}.md`);

      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      logger.info('Agent uninstalled successfully', { name, scope, filePath });
      return { success: true, filePath };
    } catch (error) {
      logger.error('Failed to uninstall agent', { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }));

  /**
   * Uninstall a skill from .claude/skills/
   */
  ipcMain.handle('feature:uninstallSkill', withContext('feature:uninstallSkill', async (_, data: unknown) => {
    const result = uninstallSkillSchema.safeParse(data);
    if (!result.success) {
      logger.warn('feature:uninstallSkill validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }

    try {
      const { name, scope, projectPath } = result.data;
      const baseDir = getBaseDir(scope, projectPath);
      const skillsDir = path.join(baseDir, 'skills');
      const filePath = path.join(skillsDir, `${name}.md`);

      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

      logger.info('Skill uninstalled successfully', { name, scope, filePath });
      return { success: true, filePath };
    } catch (error) {
      logger.error('Failed to uninstall skill', { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }));

  /**
   * Uninstall a command from .claude/commands/
   */
  ipcMain.handle('feature:uninstallCommand', withContext('feature:uninstallCommand', async (_, data: unknown) => {
    const result = uninstallCommandSchema.safeParse(data);
    if (!result.success) {
      logger.warn('feature:uninstallCommand validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }

    try {
      const { name, scope, projectPath } = result.data;
      const baseDir = getBaseDir(scope, projectPath);
      const commandsDir = path.join(baseDir, 'commands');
      const filePath = path.join(commandsDir, `${name}.md`);

      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

      logger.info('Command uninstalled successfully', { name, scope, filePath });
      return { success: true, filePath };
    } catch (error) {
      logger.error('Failed to uninstall command', { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }));

  /**
   * Uninstall a hook from .claude/hooks/ and remove from settings.json
   */
  ipcMain.handle('feature:uninstallHook', withContext('feature:uninstallHook', async (_, data: unknown) => {
    const result = uninstallHookSchema.safeParse(data);
    if (!result.success) {
      logger.warn('feature:uninstallHook validation failed', { errors: result.error.errors });
      return formatValidationError(result.error);
    }

    try {
      const { name, eventType, scope, projectPath } = result.data;
      const baseDir = getBaseDir(scope, projectPath);
      const hooksDir = path.join(baseDir, 'hooks');

      // Hook scripts are always bash scripts (.sh)
      const filePath = path.join(hooksDir, `${name}.sh`);

      // Delete hook script file
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

      // Remove hook from settings.json
      removeHookFromSettings(baseDir, name, eventType);

      logger.info('Hook uninstalled successfully', { name, eventType, scope, filePath });
      return { success: true, filePath };
    } catch (error) {
      logger.error('Failed to uninstall hook', { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }));

  logger.info('Feature handlers registered');
}
