// ============================================================================
// MCP SERVER MANAGEMENT - Add/Update/Delete Operations
// ============================================================================

import { EventEmitter } from 'events';
import { Logger } from '../logger.js';
import {
  createMCPServer,
  getMCPServer,
  getAllMCPServers,
  updateMCPServer,
  deleteMCPServer,
  type MCPServer,
} from '../../database/primitives.js';
import type { MCPServerConfig } from './types.js';

const logger = new Logger('MCPManager');

// ============================================================================
// SERVER MANAGEMENT OPERATIONS
// ============================================================================

/**
 * Add a new MCP server
 */
export function addServer(
  config: MCPServerConfig,
  emitter: EventEmitter
): MCPServer {
  const server = createMCPServer({
    name: config.name,
    description: config.description || null,
    transport: config.transport,
    command: config.command || null,
    url: config.url || null,
    args: config.args || [],
    env: config.env || {},
    scope: config.scope || 'user',
    projectPath: config.projectPath || null,
    enabled: true,
  });

  logger.info(`Added MCP server: ${server.name}`);
  emitter.emit('server:added', server);
  return server;
}

/**
 * Get a server by ID
 */
export function getServer(id: number): MCPServer | null {
  return getMCPServer(id);
}

/**
 * Get all servers
 */
export function getServers(
  scope?: 'user' | 'project',
  projectPath?: string
): MCPServer[] {
  return getAllMCPServers(scope, projectPath);
}

/**
 * Update a server
 */
export function updateServer(
  id: number,
  updates: Partial<MCPServer>,
  emitter: EventEmitter
): void {
  updateMCPServer(id, updates);
  const server = getMCPServer(id);
  if (server) {
    logger.info(`Updated MCP server: ${server.name}`);
    emitter.emit('server:updated', server);
  }
}

/**
 * Delete a server
 * @param stopServerFn - Function to stop server before deletion
 */
export function deleteServer(
  id: number,
  emitter: EventEmitter,
  stopServerFn: (id: number) => void
): void {
  const server = getMCPServer(id);
  if (server) {
    // Stop if running
    stopServerFn(id);
    deleteMCPServer(id);
    logger.info(`Deleted MCP server: ${server.name}`);
    emitter.emit('server:deleted', server);
  }
}

/**
 * Enable/disable a server
 * @param stopServerFn - Function to stop server when disabling
 */
export function setServerEnabled(
  id: number,
  enabled: boolean,
  emitter: EventEmitter,
  stopServerFn: (id: number) => void
): void {
  updateMCPServer(id, { enabled });
  if (!enabled) {
    stopServerFn(id);
  }
  const server = getMCPServer(id);
  if (server) {
    logger.info(`${enabled ? 'Enabled' : 'Disabled'} MCP server: ${server.name}`);
    emitter.emit('server:toggled', server);
  }
}

// Re-export logger for other modules
export { logger };
