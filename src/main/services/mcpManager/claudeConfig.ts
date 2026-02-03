// ============================================================================
// CLAUDE CONFIG INTEGRATION - .mcp.json and .claude.json management
// ============================================================================

import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { Logger } from '../logger.js';
import { getAllMCPServers } from '../../database/primitives.js';
import type { MCPProjectConfig } from './types.js';

const logger = new Logger('MCPManager');

// ============================================================================
// PROJECT CONFIG (.mcp.json)
// ============================================================================

/**
 * Read .mcp.json from project
 * @returns The parsed config, or null if the file doesn't exist
 * @throws Error if the file exists but cannot be read or parsed
 */
export async function readMCPConfig(projectPath: string): Promise<MCPProjectConfig | null> {
  const configPath = path.join(projectPath, '.mcp.json');

  if (!existsSync(configPath)) {
    // File doesn't exist - this is a normal condition, not an error
    return null;
  }

  try {
    const content = await fs.readFile(configPath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    // File exists but couldn't be read or parsed - this IS an error
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to read .mcp.json: ${configPath}`, error, {
      operation: 'readMCPConfig',
      configPath,
    });
    throw new Error(`Failed to read MCP config at ${configPath}: ${errorMessage}`);
  }
}

/**
 * Write .mcp.json to project
 */
export async function writeMCPConfig(
  projectPath: string,
  config: MCPProjectConfig
): Promise<void> {
  const configPath = path.join(projectPath, '.mcp.json');
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
  logger.info(`Wrote MCP config: ${configPath}`);
}

// ============================================================================
// USER CONFIG (.claude.json)
// ============================================================================

/**
 * Read user's claude.json
 * @returns The parsed config, or null if the file doesn't exist
 * @throws Error if the file exists but cannot be read or parsed
 */
export async function readUserClaudeConfig(): Promise<Record<string, unknown> | null> {
  const configPath = path.join(os.homedir(), '.claude.json');

  if (!existsSync(configPath)) {
    // File doesn't exist - this is a normal condition, not an error
    return null;
  }

  try {
    const content = await fs.readFile(configPath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    // File exists but couldn't be read or parsed - this IS an error
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to read user claude config at ${configPath}`, error, {
      operation: 'readUserClaudeConfig',
      configPath,
    });
    throw new Error(`Failed to read user claude config at ${configPath}: ${errorMessage}`);
  }
}

// ============================================================================
// CONFIG SYNC
// ============================================================================

/**
 * Sync database servers to Claude config files
 * @throws Error if reading or writing config files fails
 */
export async function syncToClaudeConfig(projectPath?: string): Promise<void> {
  const servers = getAllMCPServers();

  // Build user config
  const userServers: Record<string, {
    command?: string;
    url?: string;
    args?: string[];
    env?: Record<string, string>;
  }> = {};

  // Build project config
  const projectServers: Record<string, {
    command?: string;
    url?: string;
    args?: string[];
    env?: Record<string, string>;
  }> = {};

  for (const server of servers) {
    if (!server.enabled) continue;

    const config = {
      ...(server.command && { command: server.command }),
      ...(server.url && { url: server.url }),
      ...(server.args.length > 0 && { args: server.args }),
      ...(Object.keys(server.env).length > 0 && { env: server.env }),
    };

    if (server.scope === 'user') {
      userServers[server.name] = config;
    } else if (server.projectPath === projectPath) {
      projectServers[server.name] = config;
    }
  }

  // Write user config
  if (Object.keys(userServers).length > 0) {
    const userConfigPath = path.join(os.homedir(), '.claude.json');
    try {
      // readUserClaudeConfig returns null if file doesn't exist, throws on errors
      const userConfig = await readUserClaudeConfig() ?? {};
      userConfig.mcpServers = userServers;
      await fs.writeFile(userConfigPath, JSON.stringify(userConfig, null, 2), 'utf-8');
      logger.info('Updated user MCP config');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to sync user MCP config to ${userConfigPath}`, error, {
        operation: 'syncToClaudeConfig',
        configPath: userConfigPath,
        serverCount: Object.keys(userServers).length,
      });
      throw new Error(`Failed to sync user MCP config: ${errorMessage}`);
    }
  }

  // Write project config
  if (projectPath && Object.keys(projectServers).length > 0) {
    try {
      await writeMCPConfig(projectPath, { mcpServers: projectServers });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to sync project MCP config to ${projectPath}`, error, {
        operation: 'syncToClaudeConfig',
        projectPath,
        serverCount: Object.keys(projectServers).length,
      });
      throw new Error(`Failed to sync project MCP config: ${errorMessage}`);
    }
  }
}
