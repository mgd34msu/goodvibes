// ============================================================================
// PLUGIN MANAGER UTILITIES
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import type { PluginManifest, PluginAuthor } from './types.js';
import { Logger } from '../logger.js';

const logger = new Logger('PluginUtils');

// ============================================================================
// PATH UTILITIES
// ============================================================================

/**
 * Get the user-scope plugins directory
 */
export function getUserPluginsDir(): string {
  const homeDir = app.getPath('home');
  return path.join(homeDir, '.claude', 'plugins');
}

/**
 * Get the project-scope plugins directory
 */
export function getProjectPluginsDir(projectPath: string): string {
  return path.join(projectPath, '.claude', 'plugins');
}

/**
 * Get the plugins directory for a given scope
 */
export function getPluginsDir(scope: 'user' | 'project', projectPath?: string): string {
  if (scope === 'project') {
    if (!projectPath) {
      throw new Error('Project path is required for project-scope plugins');
    }
    return getProjectPluginsDir(projectPath);
  }
  return getUserPluginsDir();
}

/**
 * Ensure a directory exists, creating it if necessary
 */
export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    logger.debug(`Created directory: ${dirPath}`);
  }
}

// ============================================================================
// MANIFEST UTILITIES
// ============================================================================

/**
 * Read and parse a plugin manifest file
 * Supports two locations:
 * - plugin.json (root) - simple plugins
 * - .claude-plugin/plugin.json - Anthropic official plugin format
 */
export function readManifest(pluginDir: string): PluginManifest | null {
  // Check both possible manifest locations
  const manifestPaths = [
    path.join(pluginDir, 'plugin.json'),                    // Simple format
    path.join(pluginDir, '.claude-plugin', 'plugin.json'),  // Anthropic official format
  ];

  let manifestPath: string | null = null;
  for (const p of manifestPaths) {
    if (fs.existsSync(p)) {
      manifestPath = p;
      break;
    }
  }

  if (!manifestPath) {
    logger.warn(`No plugin.json found in ${pluginDir} (checked root and .claude-plugin/)`);
    return null;
  }

  try {
    const content = fs.readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(content) as PluginManifest;

    // Validate required fields (name and description are required, version is optional)
    if (!manifest.name || !manifest.description) {
      logger.error(`Invalid manifest in ${pluginDir}: missing required fields (name or description)`);
      return null;
    }

    // Provide default version if missing (some official Anthropic plugins don't have version)
    if (!manifest.version) {
      manifest.version = '1.0.0';
      logger.debug(`Manifest missing version, using default: 1.0.0`);
    }

    logger.debug(`Found plugin manifest at ${manifestPath}`);
    return manifest;
  } catch (error) {
    logger.error(`Failed to read manifest from ${pluginDir}`, error);
    return null;
  }
}

/**
 * Generate a plugin ID from its name
 */
export function generatePluginId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

/**
 * Normalize author field to a string
 * Handles both string and object formats (Anthropic uses { name, email })
 */
export function normalizeAuthor(author: PluginAuthor | undefined): string | undefined {
  if (!author) {
    return undefined;
  }
  if (typeof author === 'string') {
    return author;
  }
  // Object format: { name: "...", email?: "..." }
  if (author.email) {
    return `${author.name} <${author.email}>`;
  }
  return author.name;
}

/**
 * Validate a plugin name (for directory creation)
 */
export function validatePluginName(name: string): { valid: boolean; error?: string } {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: 'Plugin name must be a non-empty string' };
  }

  if (name.length > 100) {
    return { valid: false, error: 'Plugin name too long (max 100 characters)' };
  }

  // Only allow alphanumeric, dash, underscore
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    return { valid: false, error: 'Plugin name can only contain alphanumeric characters, dashes, and underscores' };
  }

  return { valid: true };
}

// ============================================================================
// DIRECTORY SCANNING
// ============================================================================

/**
 * Scan a directory for plugin subdirectories
 * Detects plugins with either:
 * - plugin.json (root)
 * - .claude-plugin/plugin.json (Anthropic official format)
 */
export function scanPluginDirectory(baseDir: string): string[] {
  if (!fs.existsSync(baseDir)) {
    return [];
  }

  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('_'))  // Exclude temp dirs
      .map(entry => path.join(baseDir, entry.name))
      .filter(pluginDir => {
        // Check for plugin.json in either location
        const rootManifest = path.join(pluginDir, 'plugin.json');
        const officialManifest = path.join(pluginDir, '.claude-plugin', 'plugin.json');
        return fs.existsSync(rootManifest) || fs.existsSync(officialManifest);
      });
  } catch (error) {
    logger.error(`Failed to scan directory ${baseDir}`, error);
    return [];
  }
}

/**
 * Check if a directory is a valid git repository
 */
export function isGitRepository(url: string): boolean {
  // Basic validation for git repository URLs
  const gitPatterns = [
    /^https?:\/\/.+\.git$/,
    /^git@.+:.+\.git$/,
    /^https?:\/\/github\.com\/.+\/.+$/,
    /^https?:\/\/gitlab\.com\/.+\/.+$/,
    /^https?:\/\/bitbucket\.org\/.+\/.+$/,
  ];

  return gitPatterns.some(pattern => pattern.test(url));
}

/**
 * Extract repository name from git URL
 */
export function getRepoNameFromUrl(url: string): string | null {
  try {
    // Check if this is a GitHub tree URL (monorepo subdirectory)
    const treeInfo = parseGitHubTreeUrl(url);
    if (treeInfo) {
      // For monorepo subdirectories, use the subdirectory name as the plugin name
      const subParts = treeInfo.subdirectory.split('/');
      return subParts[subParts.length - 1];
    }

    // Handle various git URL formats
    const patterns = [
      /\/([^/]+?)(?:\.git)?$/,  // Extract last segment, optionally ending in .git
      /:([^/]+?)(?:\.git)?$/,   // Handle git@ format
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }

    return null;
  } catch (error) {
    logger.error('Failed to extract repo name from URL', error);
    return null;
  }
}

/**
 * GitHub tree URL info
 */
export interface GitHubTreeInfo {
  repoUrl: string;      // The base repository URL
  branch: string;       // The branch name
  subdirectory: string; // The subdirectory path
}

/**
 * Parse a GitHub tree URL to extract repo, branch, and subdirectory
 * Example: https://github.com/owner/repo/tree/main/path/to/plugin
 * Returns null if not a tree URL
 */
export function parseGitHubTreeUrl(url: string): GitHubTreeInfo | null {
  // Match: https://github.com/owner/repo/tree/branch/path/to/subdir
  const treePattern = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)$/;
  const match = url.match(treePattern);

  if (!match) {
    return null;
  }

  const [, owner, repo, branch, subdirectory] = match;

  return {
    repoUrl: `https://github.com/${owner}/${repo}`,
    branch,
    subdirectory,
  };
}

/**
 * Check if a URL is a GitHub tree URL (monorepo subdirectory)
 */
export function isGitHubTreeUrl(url: string): boolean {
  return parseGitHubTreeUrl(url) !== null;
}

/**
 * Normalize path for git commands (convert backslashes to forward slashes)
 * Git on Windows accepts forward slashes and they avoid escaping issues
 */
export function normalizePathForGit(filepath: string): string {
  return filepath.replace(/\\/g, '/');
}

/**
 * Remove a directory recursively
 */
export function removeDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    return;
  }

  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
    logger.debug(`Removed directory: ${dirPath}`);
  } catch (error) {
    logger.error(`Failed to remove directory ${dirPath}`, error);
    throw new Error(`Failed to remove directory: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Get the path to CLI's installed_plugins.json
 */
export function getCLIInstalledPluginsPath(): string {
  const homeDir = app.getPath('home');
  return path.join(homeDir, '.claude', 'plugins', 'installed_plugins.json');
}
