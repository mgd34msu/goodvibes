// ============================================================================
// PLUGIN MANAGER TYPES
// ============================================================================

// ============================================================================
// PLUGIN MANIFEST
// ============================================================================

/**
 * Author can be a string or an object (Anthropic official format)
 */
export type PluginAuthor = string | { name: string; email?: string };

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: PluginAuthor;
  repository?: string;
  commands?: string[]; // paths to command files
  skills?: string[]; // paths to skill files
  hooks?: HookConfig[]; // hook configurations
  mcpServers?: Record<string, MCPServerConfig>;
}

export interface HookConfig {
  name: string;
  eventType: 'PreToolUse' | 'PostToolUse' | 'SessionStart' | 'SessionEnd' | 'Notification' | 'Stop';
  matcher?: string;
  command: string;
  timeout?: number;
}

export interface MCPServerConfig {
  command?: string;
  url?: string;
  args?: string[];
  env?: Record<string, string>;
}

// ============================================================================
// INSTALLED PLUGIN
// ============================================================================

export interface InstalledPlugin {
  id: string; // generated from name
  name: string;
  version: string;
  description: string;
  author?: string;
  repository?: string;
  scope: 'user' | 'project';
  projectPath?: string;
  path: string; // filesystem path to plugin directory
  enabled: boolean;
  installedAt: string;
  manifest: PluginManifest;
}

// ============================================================================
// PLUGIN INSTALLATION OPTIONS
// ============================================================================

export interface InstallPluginOptions {
  scope: 'user' | 'project';
  projectPath?: string;
  enabled?: boolean;
}

// ============================================================================
// CLI INSTALLED PLUGINS FORMAT
// ============================================================================

/**
 * CLI installed_plugins.json format - single plugin entry
 */
export interface CLIInstalledPluginEntry {
  scope: 'user' | 'project';
  installPath: string;
  version: string;
  installedAt: string;
  lastUpdated: string;
  gitCommitSha?: string;
}

/**
 * CLI installed_plugins.json format - root structure
 */
export interface CLIInstalledPluginsFile {
  version: number;
  plugins: Record<string, CLIInstalledPluginEntry[]>;
}
