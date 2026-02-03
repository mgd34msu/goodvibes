// ============================================================================
// PLUGIN MANAGER SERVICE
// ============================================================================
//
// Manages Claude Code plugins: installation, uninstallation, and enabling/disabling.
// Plugins are stored in .claude/plugins/ directories (user or project scope).
//
// ============================================================================

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../logger.js';
import type { InstalledPlugin, CLIInstalledPluginsFile } from './types.js';
import {
  getPluginsDir,
  ensureDir,
  readManifest,
  generatePluginId,
  scanPluginDirectory,
  isGitRepository,
  getRepoNameFromUrl,
  removeDirectory,
  parseGitHubTreeUrl,
  normalizeAuthor,
  normalizePathForGit,
  getCLIInstalledPluginsPath,
} from './utils.js';

const logger = new Logger('PluginManager');

// ============================================================================
// PLUGIN DETECTION
// ============================================================================

/**
 * Get all installed plugins for a specific scope
 * @param scope - 'user' or 'project'
 * @param projectPath - Required if scope is 'project'
 * @returns Array of installed plugins
 */
export async function getInstalledPlugins(
  scope?: 'user' | 'project',
  projectPath?: string
): Promise<InstalledPlugin[]> {
  const plugins: InstalledPlugin[] = [];

  // Determine which scopes to scan
  const scopesToScan: Array<'user' | 'project'> = scope ? [scope] : ['user'];

  for (const currentScope of scopesToScan) {
    try {
      const pluginsDir = getPluginsDir(currentScope, projectPath);
      const pluginDirs = scanPluginDirectory(pluginsDir);

      for (const pluginDir of pluginDirs) {
        const manifest = readManifest(pluginDir);
        if (!manifest) {
          logger.warn(`Skipping plugin with invalid manifest: ${pluginDir}`);
          continue;
        }

        const pluginId = generatePluginId(manifest.name);
        const enabled = await isPluginEnabled(pluginId, currentScope, projectPath);

        plugins.push({
          id: pluginId,
          name: manifest.name,
          version: manifest.version,
          description: manifest.description,
          author: normalizeAuthor(manifest.author),
          repository: manifest.repository,
          scope: currentScope,
          projectPath: currentScope === 'project' ? projectPath : undefined,
          path: pluginDir,
          enabled,
          installedAt: getInstallationDate(pluginDir),
          manifest,
        });
      }

      logger.debug(`Found ${pluginDirs.length} plugins in ${currentScope} scope`);
    } catch (error) {
      logger.error(`Failed to scan ${currentScope} scope plugins`, error);
    }
  }

  // Fetch CLI-installed plugins
  const cliPlugins = await getCLIInstalledPlugins();

  // Merge plugins, avoiding duplicates (prefer directory-scanned over CLI if both exist)
  const pluginMap = new Map<string, InstalledPlugin>();

  // Add directory-scanned plugins first
  for (const plugin of plugins) {
    pluginMap.set(plugin.id, plugin);
  }

  // Add CLI plugins if not already present
  for (const cliPlugin of cliPlugins) {
    if (!pluginMap.has(cliPlugin.id)) {
      pluginMap.set(cliPlugin.id, cliPlugin);
    }
  }

  return Array.from(pluginMap.values());
}

// ============================================================================

// ============================================================================
// CLI PLUGIN DETECTION
// ============================================================================

/**
 * Get plugins installed via Claude CLI
 * Reads from ~/.claude/plugins/installed_plugins.json
 * @returns Array of installed plugins from CLI
 */
async function getCLIInstalledPlugins(): Promise<InstalledPlugin[]> {
  const plugins: InstalledPlugin[] = [];

  try {
    const cliPluginsPath = getCLIInstalledPluginsPath();

    if (!fs.existsSync(cliPluginsPath)) {
      logger.debug('CLI installed_plugins.json not found');
      return plugins;
    }

    const content = fs.readFileSync(cliPluginsPath, 'utf-8');
    const cliData = JSON.parse(content) as CLIInstalledPluginsFile;

    for (const [pluginKey, entries] of Object.entries(cliData.plugins)) {
      for (const entry of entries) {
        try {
          // Extract plugin name from key format: "pluginName@marketplace"
          const pluginName = pluginKey.split('@')[0];

          // Read manifest from installPath
          const manifest = readManifest(entry.installPath);

          if (!manifest) {
            // If manifest can't be read, include plugin with basic info
            logger.warn(`Could not read manifest for CLI plugin ${pluginKey} at ${entry.installPath}`);
            const pluginId = generatePluginId(pluginName);
            const enabled = await isPluginEnabled(pluginId, entry.scope);

            plugins.push({
              id: pluginId,
              name: pluginName,
              version: entry.version,
              description: 'CLI-installed plugin (manifest unavailable)',
              scope: entry.scope,
              path: entry.installPath,
              enabled,
              installedAt: entry.installedAt,
              manifest: {
                name: pluginName,
                version: entry.version,
                description: 'CLI-installed plugin (manifest unavailable)',
              },
            });
            continue;
          }

          const pluginId = generatePluginId(manifest.name);
          const enabled = await isPluginEnabled(pluginId, entry.scope);

          plugins.push({
            id: pluginId,
            name: manifest.name,
            version: entry.version, // Use version from CLI JSON
            description: manifest.description,
            author: normalizeAuthor(manifest.author),
            repository: manifest.repository,
            scope: entry.scope,
            path: entry.installPath,
            enabled,
            installedAt: entry.installedAt,
            manifest,
          });

          logger.debug(`Found CLI plugin: ${manifest.name} (${entry.version})`);
        } catch (error) {
          logger.error(`Failed to process CLI plugin ${pluginKey}`, error);
        }
      }
    }

    logger.debug(`Found ${plugins.length} CLI-installed plugins`);
  } catch (error) {
    logger.error('Failed to read CLI installed_plugins.json', error);
  }

  return plugins;
}

// PLUGIN INSTALLATION
// ============================================================================

/**
 * Install a plugin from a git repository
 * Supports both direct repo URLs and GitHub monorepo subdirectories (tree URLs)
 * @param repository - Git repository URL or GitHub tree URL
 * @param scope - 'user' or 'project'
 * @param projectPath - Required if scope is 'project'
 * @returns The installed plugin
 */
export async function installPlugin(
  repository: string,
  scope: 'user' | 'project',
  projectPath?: string
): Promise<InstalledPlugin> {
  // Validate scope and project path
  if (scope === 'project' && !projectPath) {
    throw new Error('Project path is required for project-scope installation');
  }

  // Check if this is a GitHub tree URL (monorepo subdirectory)
  const treeInfo = parseGitHubTreeUrl(repository);

  // Validate repository URL (either direct repo or the base repo from tree URL)
  const repoToValidate = treeInfo ? treeInfo.repoUrl : repository;
  if (!isGitRepository(repoToValidate)) {
    throw new Error(`Invalid git repository URL: ${repository}`);
  }

  // Get plugins directory
  const pluginsDir = getPluginsDir(scope, projectPath);
  ensureDir(pluginsDir);

  // Extract plugin name
  const repoName = getRepoNameFromUrl(repository);
  if (!repoName) {
    throw new Error(`Could not extract repository name from: ${repository}`);
  }

  const tempPluginDir = path.join(pluginsDir, repoName);

  // Check if already installed
  if (await isPluginInstalled(repoName, scope, projectPath)) {
    throw new Error(`Plugin ${repoName} is already installed in ${scope} scope`);
  }

  logger.info(`Installing plugin from ${repository}`, { scope, repoName, isMonorepo: !!treeInfo });

  // Temp directory for cloning (only used for monorepo)
  const tempCloneDir = treeInfo ? path.join(pluginsDir, `_temp_clone_${Date.now()}`) : null;

  try {
    if (treeInfo) {
      // MONOREPO INSTALLATION: Clone full repo, extract subdirectory
      logger.info(`Detected GitHub monorepo, cloning from ${treeInfo.repoUrl}`);

      // Clone the full repository to temp location
      const normalizedTempCloneDir = normalizePathForGit(tempCloneDir!);
      logger.debug(`Cloning ${treeInfo.repoUrl} (branch: ${treeInfo.branch}) to ${normalizedTempCloneDir}`);
      
      try {
        execSync(`git clone --depth 1 --branch "${treeInfo.branch}" "${treeInfo.repoUrl}" "${normalizedTempCloneDir}"`, {
          stdio: 'pipe',
          encoding: 'utf-8',
          timeout: 120000, // 2 minute timeout
        });
      } catch (cloneError) {
        const errorMessage = cloneError instanceof Error ? cloneError.message : String(cloneError);
        logger.error(`Git clone failed for ${treeInfo.repoUrl}:`, errorMessage);
        throw new Error(`Failed to clone repository: ${errorMessage}`);
      }

      logger.debug(`Cloned base repo to ${tempCloneDir}`);

      // Check that the subdirectory exists
      const subdirPath = path.join(tempCloneDir!, treeInfo.subdirectory);
      if (!fs.existsSync(subdirPath)) {
        throw new Error(`Subdirectory not found in repository: ${treeInfo.subdirectory}`);
      }

      // Copy the subdirectory to the final location
      fs.cpSync(subdirPath, tempPluginDir, { recursive: true });
      logger.debug(`Extracted subdirectory ${treeInfo.subdirectory} to ${tempPluginDir}`);

      // Clean up the temp clone
      removeDirectory(tempCloneDir!);

    } else {
      // DIRECT REPO INSTALLATION: Clone directly
      const normalizedPluginDir = normalizePathForGit(tempPluginDir);
      logger.debug(`Cloning ${repository} to ${normalizedPluginDir}`);
      
      try {
        execSync(`git clone "${repository}" "${normalizedPluginDir}"`, {
          stdio: 'pipe',
          encoding: 'utf-8',
          timeout: 120000, // 2 minute timeout
        });
        logger.info(`Successfully cloned repository to ${tempPluginDir}`);
      } catch (cloneError) {
        const errorMessage = cloneError instanceof Error ? cloneError.message : String(cloneError);
        logger.error(`Git clone failed for ${repository}:`, errorMessage);
        throw new Error(`Failed to clone repository: ${errorMessage}`);
      }
    }

    // Read and validate manifest
    const manifest = readManifest(tempPluginDir);
    if (!manifest) {
      throw new Error('Plugin manifest (plugin.json) not found or invalid');
    }

    // Generate proper plugin ID from manifest name
    const pluginId = generatePluginId(manifest.name);
    const finalPluginDir = path.join(pluginsDir, pluginId);

    // Rename directory if needed (in case repo name differs from plugin name)
    if (tempPluginDir !== finalPluginDir) {
      if (await isPluginInstalled(pluginId, scope, projectPath)) {
        // Clean up temp directory
        removeDirectory(tempPluginDir);
        throw new Error(`Plugin ${pluginId} (${manifest.name}) is already installed in ${scope} scope`);
      }
      fs.renameSync(tempPluginDir, finalPluginDir);
      logger.debug(`Renamed plugin directory from ${repoName} to ${pluginId}`);
    }

    // Enable plugin by default
    await enablePlugin(pluginId, true, scope, projectPath);

    const plugin: InstalledPlugin = {
      id: pluginId,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: normalizeAuthor(manifest.author),
      repository: manifest.repository || repository,
      scope,
      projectPath: scope === 'project' ? projectPath : undefined,
      path: finalPluginDir,
      enabled: true,
      installedAt: new Date().toISOString(),
      manifest,
    };

    logger.info(`Successfully installed plugin: ${manifest.name} (${pluginId})`);

    return plugin;
  } catch (error) {
    // Clean up on failure
    try {
      removeDirectory(tempPluginDir);
      if (tempCloneDir) {
        removeDirectory(tempCloneDir);
      }
    } catch (cleanupError) {
      logger.warn('Failed to clean up after failed installation', cleanupError);
    }

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`Failed to install plugin from ${repository}`, error);
    throw new Error(`Plugin installation failed: ${errorMessage}`);
  }
}

// ============================================================================
// PLUGIN UNINSTALLATION
// ============================================================================

/**
 * Uninstall a plugin
 * @param pluginId - Plugin identifier
 * @param scope - 'user' or 'project'
 * @param projectPath - Required if scope is 'project'
 */
export async function uninstallPlugin(
  pluginId: string,
  scope: 'user' | 'project',
  projectPath?: string
): Promise<void> {
  if (scope === 'project' && !projectPath) {
    throw new Error('Project path is required for project-scope uninstallation');
  }

  const pluginsDir = getPluginsDir(scope, projectPath);
  const pluginDir = `${pluginsDir}/${pluginId}`;

  // Check if plugin exists
  if (!(await isPluginInstalled(pluginId, scope, projectPath))) {
    throw new Error(`Plugin ${pluginId} is not installed in ${scope} scope`);
  }

  logger.info(`Uninstalling plugin: ${pluginId}`, { scope });

  try {
    // Remove plugin directory
    removeDirectory(pluginDir);

    // Remove from enabled plugins config
    await removeFromConfig(pluginId, scope, projectPath);

    logger.info(`Successfully uninstalled plugin: ${pluginId}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`Failed to uninstall plugin: ${pluginId}`, error);
    throw new Error(`Plugin uninstallation failed: ${errorMessage}`);
  }
}

// ============================================================================
// PLUGIN ENABLE/DISABLE
// ============================================================================

/**
 * Enable or disable a plugin
 * @param pluginId - Plugin identifier
 * @param enabled - Whether to enable or disable
 * @param scope - Optional scope to specify (defaults to searching both)
 * @param projectPath - Required if scope is 'project'
 */
export async function enablePlugin(
  pluginId: string,
  enabled: boolean,
  scope?: 'user' | 'project',
  projectPath?: string
): Promise<void> {
  // If scope not specified, try to find the plugin in either scope
  if (!scope) {
    const userPlugins = await getInstalledPlugins('user');
    const userPlugin = userPlugins.find(p => p.id === pluginId);

    if (userPlugin) {
      scope = 'user';
    } else if (projectPath) {
      const projectPlugins = await getInstalledPlugins('project', projectPath);
      const projectPlugin = projectPlugins.find(p => p.id === pluginId);
      if (projectPlugin) {
        scope = 'project';
      }
    }

    if (!scope) {
      throw new Error(`Plugin ${pluginId} not found in any scope`);
    }
  }

  if (scope === 'project' && !projectPath) {
    throw new Error('Project path is required for project-scope operations');
  }

  // Verify plugin exists
  if (!(await isPluginInstalled(pluginId, scope, projectPath))) {
    throw new Error(`Plugin ${pluginId} is not installed in ${scope} scope`);
  }

  // Update enabled state in config
  await setPluginEnabledState(pluginId, enabled, scope, projectPath);

  logger.info(`${enabled ? 'Enabled' : 'Disabled'} plugin: ${pluginId}`, { scope });
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Check if a plugin is installed
 */
async function isPluginInstalled(
  pluginId: string,
  scope: 'user' | 'project',
  projectPath?: string
): Promise<boolean> {
  const plugins = await getInstalledPlugins(scope, projectPath);
  return plugins.some(p => p.id === pluginId);
}

/**
 * Get installation date of a plugin
 */
function getInstallationDate(pluginDir: string): string {
  try {
    const stats = fs.statSync(pluginDir);
    return stats.birthtime.toISOString();
  } catch (error) {
    logger.warn(`Could not get installation date for ${pluginDir}`, error);
    return new Date().toISOString();
  }
}

/**
 * Check if a plugin is enabled
 */
async function isPluginEnabled(
  pluginId: string,
  scope: 'user' | 'project',
  projectPath?: string
): Promise<boolean> {
  const config = await readPluginConfig(scope, projectPath);

  // Default to enabled if not specified in config
  if (!config[pluginId]) {
    return true;
  }

  return config[pluginId].enabled !== false;
}

/**
 * Set plugin enabled state
 */
async function setPluginEnabledState(
  pluginId: string,
  enabled: boolean,
  scope: 'user' | 'project',
  projectPath?: string
): Promise<void> {
  const config = await readPluginConfig(scope, projectPath);

  config[pluginId] = {
    enabled,
    updatedAt: new Date().toISOString(),
  };

  await writePluginConfig(config, scope, projectPath);
}

/**
 * Remove plugin from config
 */
async function removeFromConfig(
  pluginId: string,
  scope: 'user' | 'project',
  projectPath?: string
): Promise<void> {
  const config = await readPluginConfig(scope, projectPath);
  delete config[pluginId];
  await writePluginConfig(config, scope, projectPath);
}

/**
 * Read plugin configuration file
 */
async function readPluginConfig(
  scope: 'user' | 'project',
  projectPath?: string
): Promise<Record<string, { enabled: boolean; updatedAt?: string }>> {
  const pluginsDir = getPluginsDir(scope, projectPath);
  const configPath = path.join(path.dirname(pluginsDir), 'plugins.json');

  if (!fs.existsSync(configPath)) {
    return {};
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    logger.error(`Failed to read plugin config at ${configPath}`, error);
    return {};
  }
}

/**
 * Write plugin configuration file
 */
async function writePluginConfig(
  config: Record<string, { enabled: boolean; updatedAt?: string }>,
  scope: 'user' | 'project',
  projectPath?: string
): Promise<void> {
  const pluginsDir = getPluginsDir(scope, projectPath);
  const configDir = path.dirname(pluginsDir);
  const configPath = path.join(configDir, 'plugins.json');

  ensureDir(configDir);

  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    logger.debug(`Updated plugin config at ${configPath}`);
  } catch (error) {
    logger.error(`Failed to write plugin config at ${configPath}`, error);
    throw new Error('Failed to save plugin configuration');
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export * from './types.js';
export * from './utils.js';
