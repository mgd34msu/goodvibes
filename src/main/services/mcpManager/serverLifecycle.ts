// ============================================================================
// MCP SERVER LIFECYCLE - Start/Stop/Restart Operations
// ============================================================================

import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { Logger } from '../logger.js';
import {
  getMCPServer,
  updateMCPServer,
  updateMCPServerStatus,
  type MCPServer,
} from '../../database/primitives.js';
import {
  validateCommandName,
  validateCommandArguments,
  validatePath,
  validateEnvironment,
  logSecurityEvent,
} from '../inputSanitizer.js';
import type { MCPServerInfo } from './types.js';

const logger = new Logger('MCPManager');

// ============================================================================
// STDIO SERVER LIFECYCLE
// ============================================================================

/**
 * Start a stdio-based MCP server
 */
export async function startStdioServer(
  server: MCPServer,
  runningServers: Map<number, MCPServerInfo>,
  emitter: EventEmitter
): Promise<boolean> {
  if (!server.command) {
    logger.error(`No command specified for stdio server: ${server.name}`);
    updateMCPServerStatus(server.id, 'error', 'No command specified');
    return false;
  }

  // Security: Validate command name
  const commandValidation = validateCommandName(server.command);
  if (!commandValidation.valid) {
    logger.error(`Invalid command for MCP server ${server.name}: ${commandValidation.error}`);
    logSecurityEvent('mcp-server-start', server.command, server.args || [], commandValidation.error || 'Invalid command');
    updateMCPServerStatus(server.id, 'error', `Security: ${commandValidation.error}`);
    return false;
  }

  // Security: Validate arguments
  if (server.args && server.args.length > 0) {
    const argsValidation = validateCommandArguments(server.args);
    if (!argsValidation.valid) {
      logger.error(`Invalid arguments for MCP server ${server.name}: ${argsValidation.error}`);
      logSecurityEvent('mcp-server-start', server.command, server.args, argsValidation.error || 'Invalid arguments');
      updateMCPServerStatus(server.id, 'error', `Security: ${argsValidation.error}`);
      return false;
    }
  }

  // Security: Validate cwd path
  const cwd = server.projectPath || process.cwd();
  const cwdValidation = validatePath(cwd);
  if (!cwdValidation.valid) {
    logger.error(`Invalid cwd for MCP server ${server.name}: ${cwdValidation.error}`);
    logSecurityEvent('mcp-server-start', server.command, [cwd], cwdValidation.error || 'Invalid cwd');
    updateMCPServerStatus(server.id, 'error', `Security: ${cwdValidation.error}`);
    return false;
  }

  // Security: Validate custom environment variables
  if (server.env && Object.keys(server.env).length > 0) {
    const envValidation = validateEnvironment(server.env);
    if (!envValidation.valid) {
      logger.error(`Invalid environment for MCP server ${server.name}: ${envValidation.error}`);
      logSecurityEvent('mcp-server-start', server.command, [], envValidation.error || 'Invalid environment');
      updateMCPServerStatus(server.id, 'error', `Security: ${envValidation.error}`);
      return false;
    }
  }

  try {
    const env = {
      ...process.env,
      ...server.env,
    };

    // Use validated values
    const safeCommand = commandValidation.sanitized || server.command;
    const safeCwd = cwdValidation.sanitized || cwd;

    const child = spawn(safeCommand, server.args || [], {
      env,
      cwd: safeCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const serverInfo: MCPServerInfo = {
      server,
      tools: [],
      process: child,
      connected: false,
    };

    runningServers.set(server.id, serverInfo);

    // Wait for server to be ready
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (!serverInfo.connected) {
          updateMCPServerStatus(server.id, 'error', 'Connection timeout');
          stopServer(server.id, runningServers, emitter);
          resolve(false);
        }
      }, 10000);

      child.stdout?.on('data', (data) => {
        const output = data.toString();
        logger.debug(`MCP ${server.name} stdout: ${output}`);

        // Try to parse as JSON to detect tools
        // Note: MCP servers emit both JSON and non-JSON output, so parse errors
        // are expected and intentionally silenced - this is NOT an error condition
        try {
          const json = JSON.parse(output);
          if (json.tools) {
            serverInfo.tools = json.tools;
            updateMCPServer(server.id, { toolCount: json.tools.length });
            logger.debug(`MCP ${server.name} registered ${json.tools.length} tools`);
          }
        } catch {
          // Expected: Not JSON output (e.g., status messages, logs). MCP servers
          // commonly emit non-JSON output alongside JSON tool registrations.
          // This is normal operation, not an error condition.
        }

        // Mark as connected on first output
        if (!serverInfo.connected) {
          serverInfo.connected = true;
          clearTimeout(timeout);
          updateMCPServerStatus(server.id, 'connected');
          emitter.emit('server:connected', server);
          resolve(true);
        }
      });

      child.stderr?.on('data', (data) => {
        logger.warn(`MCP ${server.name} stderr: ${data.toString()}`);
      });

      child.on('error', (error) => {
        clearTimeout(timeout);
        logger.error(`MCP ${server.name} error:`, error);
        updateMCPServerStatus(server.id, 'error', error.message);
        runningServers.delete(server.id);
        emitter.emit('server:error', server, error);
        resolve(false);
      });

      child.on('close', (code) => {
        clearTimeout(timeout);
        logger.info(`MCP ${server.name} exited with code: ${code}`);
        updateMCPServerStatus(server.id, 'disconnected');
        runningServers.delete(server.id);
        emitter.emit('server:disconnected', server);
      });
    });
  } catch (error) {
    logger.error(`Failed to start MCP server: ${server.name}`, error);
    updateMCPServerStatus(server.id, 'error', (error as Error).message);
    return false;
  }
}

// ============================================================================
// HTTP SERVER LIFECYCLE
// ============================================================================

/**
 * Test connection to HTTP-based MCP server
 */
export async function testHttpServer(
  server: MCPServer,
  runningServers: Map<number, MCPServerInfo>,
  emitter: EventEmitter
): Promise<boolean> {
  if (!server.url) {
    logger.error(`No URL specified for HTTP server: ${server.name}`);
    updateMCPServerStatus(server.id, 'error', 'No URL specified');
    return false;
  }

  try {
    const response = await fetch(server.url, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });

    if (response.ok) {
      updateMCPServerStatus(server.id, 'connected');

      const serverInfo: MCPServerInfo = {
        server,
        tools: [],
        connected: true,
      };

      runningServers.set(server.id, serverInfo);
      emitter.emit('server:connected', server);
      return true;
    } else {
      updateMCPServerStatus(server.id, 'error', `HTTP ${response.status}`);
      return false;
    }
  } catch (error) {
    logger.error(`Failed to connect to HTTP MCP server: ${server.name}`, error);
    updateMCPServerStatus(server.id, 'error', (error as Error).message);
    return false;
  }
}

// ============================================================================
// COMMON LIFECYCLE OPERATIONS
// ============================================================================

/**
 * Start an MCP server
 */
export async function startServer(
  id: number,
  runningServers: Map<number, MCPServerInfo>,
  emitter: EventEmitter
): Promise<boolean> {
  const server = getMCPServer(id);
  if (!server) {
    logger.error(`MCP server not found: ${id}`);
    return false;
  }

  if (!server.enabled) {
    logger.warn(`MCP server is disabled: ${server.name}`);
    return false;
  }

  // Check if already running
  if (runningServers.has(id)) {
    logger.debug(`MCP server already running: ${server.name}`);
    return true;
  }

  logger.info(`Starting MCP server: ${server.name}`);

  if (server.transport === 'stdio') {
    return startStdioServer(server, runningServers, emitter);
  } else if (server.transport === 'http') {
    return testHttpServer(server, runningServers, emitter);
  }

  return false;
}

/**
 * Stop an MCP server
 */
export function stopServer(
  id: number,
  runningServers: Map<number, MCPServerInfo>,
  emitter: EventEmitter
): void {
  const serverInfo = runningServers.get(id);
  if (serverInfo) {
    if (serverInfo.process) {
      serverInfo.process.kill('SIGTERM');
    }
    runningServers.delete(id);
    updateMCPServerStatus(id, 'disconnected');
    emitter.emit('server:disconnected', serverInfo.server);
    logger.info(`Stopped MCP server: ${serverInfo.server.name}`);
  }
}

/**
 * Stop all running servers
 */
export function stopAllServers(
  runningServers: Map<number, MCPServerInfo>,
  emitter: EventEmitter
): void {
  for (const [id] of runningServers) {
    stopServer(id, runningServers, emitter);
  }
}

/**
 * Restart an MCP server
 */
export async function restartServer(
  id: number,
  runningServers: Map<number, MCPServerInfo>,
  emitter: EventEmitter
): Promise<boolean> {
  stopServer(id, runningServers, emitter);
  await new Promise(resolve => setTimeout(resolve, 500));
  return startServer(id, runningServers, emitter);
}
