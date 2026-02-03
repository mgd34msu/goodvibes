// ============================================================================
// HOOK SERVER SERVICE - HTTP Server for Claude Hook Script Communication
// ============================================================================

import http from 'http';
import { EventEmitter } from 'events';
import { Logger } from '../logger.js';
import { formatTimestamp } from '../../../shared/dateUtils.js';
import { getMainWindow } from '../../window.js';
import {
  recordHookEvent,
  type HookEventRecord,
  type ExtendedHookEventType,
} from '../../database/hookEvents.js';
import type { HookPayload, HookResponse, HookHandler } from './types.js';
import { HOOK_SERVER_PORT, getPayloadValue } from './types.js';
import { createDefaultHandlers } from './handlers.js';

const logger = new Logger('HookServer');

// ============================================================================
// HOOK SERVER SERVICE
// ============================================================================

export class HookServerService extends EventEmitter {
  private server: http.Server | null = null;
  private handlers: Map<ExtendedHookEventType, HookHandler[]> = new Map();
  private isRunning = false;

  // Parent-child tracking
  private pendingSubagentParents: Map<string, string> = new Map();
  private sessionStacks: Map<string, string[]> = new Map();
  private readonly MAX_MAP_SIZE = 1000;

  constructor() {
    super();
    this.setMaxListeners(50);
    this.registerDefaultHandlers();
  }

  // ============================================================================
  // PARENT-CHILD TRACKING
  // ============================================================================

  /**
   * Get the current active session for a working directory (the one that would be the parent)
   */
  private getCurrentParentSession(workingDirectory: string | undefined): string | null {
    if (!workingDirectory) return null;
    const stack = this.sessionStacks.get(workingDirectory);
    if (!stack || stack.length === 0) return null;
    return stack[stack.length - 1];
  }

  /**
   * Push a session onto the stack for a working directory
   */
  private pushSession(workingDirectory: string | undefined, sessionId: string): void {
    if (!workingDirectory) return;

    // Enforce size limit before adding new entry
    this.enforceMapSizeLimit(this.sessionStacks, 'sessionStacks');

    if (!this.sessionStacks.has(workingDirectory)) {
      this.sessionStacks.set(workingDirectory, []);
    }
    const stack = this.sessionStacks.get(workingDirectory);
    if (!stack) return;
    if (!stack.includes(sessionId)) {
      stack.push(sessionId);
      logger.debug(`Pushed session onto stack: ${sessionId} (stack depth: ${stack.length})`);
    }
  }

  /**
   * Pop a session from the stack for a working directory
   */
  private popSession(workingDirectory: string | undefined, sessionId: string): void {
    if (!workingDirectory) return;
    const stack = this.sessionStacks.get(workingDirectory);
    if (!stack) return;
    const index = stack.indexOf(sessionId);
    if (index !== -1) {
      stack.splice(index, 1);
      logger.debug(`Popped session from stack: ${sessionId} (stack depth: ${stack.length})`);

      // If stack is now empty, remove the entry entirely to prevent unbounded growth
      if (stack.length === 0) {
        this.sessionStacks.delete(workingDirectory);
        logger.debug(`Removed empty sessionStacks entry for ${workingDirectory}`);
      }
    }
  }

  /**
   * Clean up Map entries when a session ends
   */
  private cleanupSession(sessionId: string): void {
    // Clean up pendingSubagentParents entry
    if (this.pendingSubagentParents.has(sessionId)) {
      this.pendingSubagentParents.delete(sessionId);
      logger.debug('Cleaned up pendingSubagentParents entry', { sessionId });
    }

    // Clean up sessionStacks entries that reference this session
    for (const [workingDir, stack] of this.sessionStacks.entries()) {
      const index = stack.indexOf(sessionId);
      if (index !== -1) {
        stack.splice(index, 1);
        logger.debug('Removed session from sessionStacks', { sessionId, workingDir });

        // Remove empty stacks
        if (stack.length === 0) {
          this.sessionStacks.delete(workingDir);
          logger.debug('Removed empty sessionStacks entry', { workingDir });
        }
      }
    }
  }

  /**
   * Enforce size limits on Maps to prevent unbounded growth
   */
  private enforceMapSizeLimit<K, V>(map: Map<K, V>, mapName: string): void {
    if (map.size >= this.MAX_MAP_SIZE) {
      const firstKey = map.keys().next().value;
      if (firstKey !== undefined) {
        map.delete(firstKey);
        logger.warn(`${mapName} reached max size (${this.MAX_MAP_SIZE}), removed oldest entry`);
      }
    }
  }

  // ============================================================================
  // SERVER LIFECYCLE
  // ============================================================================

  /**
   * Start the HTTP server
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Hook server already running');
      return;
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          logger.error(`Port ${HOOK_SERVER_PORT} is already in use`);
          reject(new Error(`Port ${HOOK_SERVER_PORT} is already in use`));
        } else {
          logger.error('Hook server error', error);
          reject(error);
        }
      });

      this.server.listen(HOOK_SERVER_PORT, '127.0.0.1', () => {
        this.isRunning = true;
        logger.info(`Hook server listening on http://127.0.0.1:${HOOK_SERVER_PORT}`);
        resolve();
      });
    });
  }

  /**
   * Stop the HTTP server
   */
  async stop(): Promise<void> {
    if (!this.server || !this.isRunning) {
      return;
    }

    const serverToClose = this.server;
    return new Promise((resolve) => {
      serverToClose.close(() => {
        this.isRunning = false;
        this.server = null;
        logger.info('Hook server stopped');
        resolve();
      });
    });
  }

  /**
   * Check if the server is running
   */
  getStatus(): { running: boolean; port: number } {
    return {
      running: this.isRunning,
      port: HOOK_SERVER_PORT,
    };
  }

  // ============================================================================
  // REQUEST HANDLING
  // ============================================================================

  /**
   * Handle incoming HTTP requests
   */
  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const payload = JSON.parse(body) as HookPayload;
        const response = await this.processHookEvent(req.url || '/', payload);

        res.writeHead(200);
        res.end(JSON.stringify(response));
      } catch (error) {
        logger.error('Error processing hook request', error);
        res.writeHead(500);
        res.end(JSON.stringify({
          error: 'Internal server error',
          decision: 'allow'
        }));
      }
    });

    req.on('error', (error) => {
      logger.error('Request error', error);
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Bad request' }));
    });
  }

  /**
   * Process a hook event and route to appropriate handlers
   */
  private async processHookEvent(
    path: string,
    payload: HookPayload
  ): Promise<HookResponse> {
    const startTime = Date.now();
    const eventType = payload.hook_event_name;

    logger.info(`[HOOK RECEIVED] ${eventType}`, {
      sessionId: payload.session_id || payload.sessionId,
      workingDir: payload.working_directory || payload.workingDirectory,
      toolName: payload.tool_name || payload.toolName,
      agentName: payload.agent_name || payload.agentName,
      parentSessionId: payload.parent_session_id || payload.parentSessionId,
    });

    logger.info(`[HOOK PAYLOAD] ${eventType}:`, JSON.stringify(payload, null, 2));

    const eventRecord = this.recordEvent(payload);
    this.notifyRenderer('hook:event', eventRecord);

    const handlers = this.handlers.get(eventType) || [];
    let response: HookResponse = { decision: 'allow' };

    for (const handler of handlers) {
      try {
        const result = await handler(payload);

        if (result.decision === 'block' || result.decision === 'deny') {
          response = result;
          break;
        }

        if (result.inject_context) {
          response.inject_context = (response.inject_context || '') + result.inject_context;
        }
        if (result.modified_input) {
          response.modified_input = { ...response.modified_input, ...result.modified_input };
        }
        if (result.message) {
          response.message = result.message;
        }
      } catch (error) {
        logger.error(`Handler error for ${eventType}`, error, {
          sessionId: payload.session_id || payload.sessionId,
          toolName: payload.tool_name || payload.toolName,
          workingDirectory: payload.working_directory || payload.workingDirectory,
        });
        // Continue to next handler - one failing handler shouldn't block others
      }
    }

    const durationMs = Date.now() - startTime;
    logger.debug(`Hook event processed in ${durationMs}ms`, {
      eventType,
      decision: response.decision
    });

    this.emit('hook:processed', { payload, response, durationMs });

    return response;
  }

  /**
   * Record a hook event in the database
   */
  private recordEvent(payload: HookPayload): HookEventRecord {
    const sessionId = getPayloadValue<string>(payload, 'session_id', 'sessionId');
    const workingDirectory = getPayloadValue<string>(payload, 'working_directory', 'workingDirectory');
    const toolName = getPayloadValue<string>(payload, 'tool_name', 'toolName');
    const toolInput = getPayloadValue<Record<string, unknown>>(payload, 'tool_input', 'toolInput');
    const toolResponse = getPayloadValue<{ success: boolean; content: string }>(payload, 'tool_response', 'toolResponse');

    const event: Omit<HookEventRecord, 'id'> = {
      eventType: payload.hook_event_name,
      sessionId: sessionId || null,
      projectPath: workingDirectory || null,
      toolName: toolName || null,
      toolInput: toolInput ? JSON.stringify(toolInput) : null,
      toolResult: toolResponse ? JSON.stringify(toolResponse) : null,
      blocked: false,
      blockReason: null,
      durationMs: 0,
      timestamp: formatTimestamp(),
    };

    return recordHookEvent(event);
  }

  /**
   * Notify the renderer process of an event
   */
  private notifyRenderer(channel: string, data: unknown): void {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, data);
    }
  }

  // ============================================================================
  // HANDLER REGISTRATION
  // ============================================================================

  /**
   * Register a handler for a specific hook event type
   */
  registerHandler(eventType: ExtendedHookEventType, handler: HookHandler): void {
    const handlers = this.handlers.get(eventType) || [];
    handlers.push(handler);
    this.handlers.set(eventType, handlers);
    logger.debug(`Registered handler for ${eventType}`);
  }

  /**
   * Remove all handlers for a specific event type
   */
  clearHandlers(eventType: ExtendedHookEventType): void {
    this.handlers.delete(eventType);
  }

  /**
   * Register the default handlers for all event types
   */
  private registerDefaultHandlers(): void {
    const context = {
      pushSession: this.pushSession.bind(this),
      popSession: this.popSession.bind(this),
      getCurrentParentSession: this.getCurrentParentSession.bind(this),
      cleanupSession: this.cleanupSession.bind(this),
      emit: this.emit.bind(this),
    };

    const defaultHandlers = createDefaultHandlers(context);

    for (const [eventType, handler] of defaultHandlers) {
      this.registerHandler(eventType as ExtendedHookEventType, handler);
    }
  }
}
