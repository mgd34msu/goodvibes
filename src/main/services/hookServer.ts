// ============================================================================
// HOOK SERVER - HTTP Server for Claude Hook Script Communication
// ============================================================================
//
// This HTTP server listens on port 23847 for incoming requests from Claude
// hook scripts. Hook scripts POST JSON data to this server, and the server
// routes to appropriate handlers, returning decisions and updates.
//
// Communication Flow:
// 1. Claude spawns hook script as child process
// 2. Hook script reads JSON from stdin (Claude's hook data)
// 3. Hook script POSTs to this server
// 4. Server processes, updates database, notifies renderer via IPC
// 5. Server returns decision (allow/block/modify)
// 6. Hook script writes response to stdout, exits with code
//
// ============================================================================

import http from 'http';
import { EventEmitter } from 'events';
import { Logger } from './logger.js';
import { getMainWindow } from '../window.js';
import {
  recordHookEvent,
  getHookEventsBySession,
  type HookEventRecord,
  type ExtendedHookEventType,
} from '../database/hookEvents.js';
import {
  getActiveAgentsForProject,
  getPendingSkillsForProject,
  getIndexedAgent,
  getIndexedSkill,
  markSkillInjected,
  recordAgentUsage,
  recordSkillUsage,
} from '../database/agencyIndex.js';
import {
  findAgentBySession,
  upsertAgent,
  updateAgentStatus,
  cleanupGarbageAgents,
  getAgent,
  getAllAgents,
  type AgentStatus,
} from '../database/primitives.js';

const logger = new Logger('HookServer');

// ============================================================================
// CONSTANTS
// ============================================================================

export const HOOK_SERVER_PORT = 23847;

// ============================================================================
// TYPES
// ============================================================================

/**
 * Payload received from hook scripts via HTTP POST
 * Claude Code sends both camelCase and snake_case in different contexts.
 * We support both forms for compatibility and robustness.
 */
export interface HookPayload {
  hook_event_name: ExtendedHookEventType;
  // Session identifiers (support both camelCase and snake_case)
  session_id?: string;
  sessionId?: string;
  // Working directory
  working_directory?: string;
  workingDirectory?: string;
  // Tool information
  tool_name?: string;
  toolName?: string;
  tool_input?: Record<string, unknown>;
  toolInput?: Record<string, unknown>;
  tool_response?: {
    success: boolean;
    content: string;
  };
  toolResponse?: {
    success: boolean;
    content: string;
  };
  // User prompt
  user_prompt?: string;
  userPrompt?: string;
  // Permission request
  permission_type?: string;
  permissionType?: string;
  permission_details?: string;
  permissionDetails?: string;
  // Agent hierarchy (critical for SubagentStart/SubagentStop)
  agent_name?: string;
  agentName?: string;
  parent_session_id?: string;
  parentSessionId?: string;
  // Subagent unique identifiers (sent by Claude Code in SubagentStart/SubagentStop)
  agent_id?: string;    // The unique ID of the subagent (e.g., "a7d4f88")
  agentId?: string;
  agent_type?: string;  // The type of subagent (e.g., "Explore", "Plan", "general-purpose")
  agentType?: string;
  // Notifications
  notification_type?: string;
  notificationType?: string;
  notification_message?: string;
  notificationMessage?: string;
  // Timestamp
  timestamp?: number;
}

/**
 * Helper to get a value from payload, supporting both camelCase and snake_case
 */
function getPayloadValue<T>(payload: HookPayload, snakeCase: keyof HookPayload, camelCase: keyof HookPayload): T | undefined {
  return (payload[camelCase] ?? payload[snakeCase]) as T | undefined;
}

/**
 * Response returned to hook scripts
 */
export interface HookResponse {
  decision: 'allow' | 'deny' | 'block' | 'modify';
  message?: string;
  inject_context?: string;
  modified_input?: Record<string, unknown>;
}

/**
 * Handler function for a specific hook event type
 */
export type HookHandler = (
  payload: HookPayload
) => Promise<HookResponse> | HookResponse;

// ============================================================================
// HOOK SERVER SERVICE
// ============================================================================

class HookServerService extends EventEmitter {
  private server: http.Server | null = null;
  private handlers: Map<ExtendedHookEventType, HookHandler[]> = new Map();
  private isRunning = false;

  // ============================================================================
  // PARENT-CHILD TRACKING
  // ============================================================================
  // Claude Code does NOT send parentSessionId in SubagentStart hooks.
  // (See: https://github.com/anthropics/claude-code/issues/6885)
  // We must infer parent-child relationships by tracking Task tool invocations.
  // When PreToolUse fires for the Task tool, we know the current session is about
  // to spawn a subagent. We capture this and associate it with the next SubagentStart.
  // ============================================================================

  // Maps: sessionId -> parentSessionId (the session that spawned it via Task tool)
  private pendingSubagentParents: Map<string, string> = new Map();

  // Stack of active sessions per working directory (to track nesting)
  // Maps: workingDirectory -> stack of sessionIds (most recent at the end)
  private sessionStacks: Map<string, string[]> = new Map();

  constructor() {
    super();
    this.setMaxListeners(50);
    this.registerDefaultHandlers();
  }

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
    if (!this.sessionStacks.has(workingDirectory)) {
      this.sessionStacks.set(workingDirectory, []);
    }
    const stack = this.sessionStacks.get(workingDirectory)!;
    // Avoid duplicates - only push if not already on stack
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
    // Remove this specific session from the stack
    const index = stack.indexOf(sessionId);
    if (index !== -1) {
      stack.splice(index, 1);
      logger.debug(`Popped session from stack: ${sessionId} (stack depth: ${stack.length})`);
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

    return new Promise((resolve) => {
      this.server!.close(() => {
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
    // Set CORS headers for local requests
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // Only accept POST requests
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    // Collect request body
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
          decision: 'allow' // Fail open
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

    // VERBOSE HOOK LOGGING - Always log all hook events at INFO level
    logger.info(`[HOOK RECEIVED] ${eventType}`, {
      sessionId: payload.session_id || payload.sessionId,
      workingDir: payload.working_directory || payload.workingDirectory,
      toolName: payload.tool_name || payload.toolName,
      agentName: payload.agent_name || payload.agentName,
      parentSessionId: payload.parent_session_id || payload.parentSessionId,
    });

    // Log full payload for debugging
    logger.info(`[HOOK PAYLOAD] ${eventType}:`, JSON.stringify(payload, null, 2));

    // Record the event in the database
    const eventRecord = this.recordEvent(payload);

    // Notify renderer of new event
    this.notifyRenderer('hook:event', eventRecord);

    // Get handlers for this event type
    const handlers = this.handlers.get(eventType) || [];

    // Default response is to allow
    let response: HookResponse = { decision: 'allow' };

    // Run all handlers, stopping if any blocks
    for (const handler of handlers) {
      try {
        const result = await handler(payload);

        if (result.decision === 'block' || result.decision === 'deny') {
          response = result;
          break;
        }

        // Merge non-blocking responses
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
        logger.error(`Handler error for ${eventType}`, error);
        // Continue with other handlers
      }
    }

    const durationMs = Date.now() - startTime;
    logger.debug(`Hook event processed in ${durationMs}ms`, {
      eventType,
      decision: response.decision
    });

    // Emit event for internal listeners
    this.emit('hook:processed', { payload, response, durationMs });

    return response;
  }

  /**
   * Record a hook event in the database
   */
  private recordEvent(payload: HookPayload): HookEventRecord {
    // Use helper to get values with fallback between camelCase and snake_case
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
      timestamp: new Date().toISOString(),
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
    // PreToolUse - Check policies before tool execution AND track Task tool for hierarchy
    this.registerHandler('PreToolUse', async (payload) => {
      const toolName = getPayloadValue<string>(payload, 'tool_name', 'toolName');
      const sessionId = getPayloadValue<string>(payload, 'session_id', 'sessionId');
      const workingDirectory = getPayloadValue<string>(payload, 'working_directory', 'workingDirectory');

      // CRITICAL: Track Task tool invocations to infer parent-child relationships
      // When a session uses the Task tool, the NEXT SubagentStart is its child
      if (toolName === 'Task' && sessionId) {
        logger.info(`[HIERARCHY] Task tool detected in session ${sessionId} - marking as pending parent`);
        // Store that this session is about to spawn a subagent
        // The next SubagentStart should be a child of this session
        if (workingDirectory) {
          // Push this session as the current parent context
          this.pushSession(workingDirectory, sessionId);
        }
      }

      // Future: Check budget, apply policies, etc.
      // For now, just allow everything
      return { decision: 'allow' };
    });

    // PostToolUse - Track tool usage after execution
    this.registerHandler('PostToolUse', async (payload) => {
      const toolName = getPayloadValue<string>(payload, 'tool_name', 'toolName');
      const sessionId = getPayloadValue<string>(payload, 'session_id', 'sessionId');
      const toolResponse = getPayloadValue<{ success: boolean; content: string }>(payload, 'tool_response', 'toolResponse');

      // Log tool usage for analytics
      if (toolName) {
        this.emit('tool:used', {
          toolName,
          sessionId,
          success: toolResponse?.success ?? true,
        });
      }
      return { decision: 'allow' };
    });

    // SessionStart - Inject context when session starts AND create/update root agent
    this.registerHandler('SessionStart', async (payload) => {
      const sessionId = getPayloadValue<string>(payload, 'session_id', 'sessionId');
      const workingDirectory = getPayloadValue<string>(payload, 'working_directory', 'workingDirectory');

      logger.info(`[HOOKS] SessionStart received - FULL DEBUG`, {
        sessionId,
        workingDirectory,
        fullPayload: JSON.stringify(payload),
      });

      // Track this session in our stack for hierarchy tracking
      if (sessionId && workingDirectory) {
        this.pushSession(workingDirectory, sessionId);
        logger.info(`[HIERARCHY] Session ${sessionId} pushed to stack for ${workingDirectory}`);
      }

      // Create or update the ROOT agent for this session
      if (sessionId && workingDirectory) {
        try {
          const agent = upsertAgent({
            id: sessionId, // Use sessionId as the agent ID for root
            name: 'Main Session',
            pid: null,
            cwd: workingDirectory,
            parentId: null, // Root agent has no parent
            templateId: null,
            status: 'active' as AgentStatus,
            sessionPath: sessionId,
            initialPrompt: null,
          });
          logger.info(`[HIERARCHY] Root agent created/updated:`, {
            agentId: agent.id,
            name: agent.name,
            sessionPath: agent.sessionPath,
            parentId: agent.parentId,
          });

          // Verify it can be found
          const verifyLookup = findAgentBySession(sessionId);
          if (verifyLookup) {
            logger.info(`[HIERARCHY] Verified: Agent ${sessionId} can be found by session lookup`);
          } else {
            logger.error(`[HIERARCHY] ERROR: Agent ${sessionId} was just created but cannot be found by session lookup!`);
          }
        } catch (error) {
          logger.error('Failed to create root agent for session:', error);
        }
      }

      this.emit('session:start', {
        sessionId,
        projectPath: workingDirectory,
      });

      // Inject active agents and pending skills for this project
      let injectContext = '';

      if (workingDirectory) {
        try {
          // Get active agents for this project
          const activeAgents = getActiveAgentsForProject(workingDirectory);
          for (const activeAgent of activeAgents) {
            const agent = getIndexedAgent(activeAgent.agentId);
            if (agent) {
              injectContext += `\n\n<!-- CLAUSITRON:AGENT:${agent.slug} -->\n`;
              injectContext += `## Agent: ${agent.name}\n\n`;
              if (agent.description) {
                injectContext += `${agent.description}\n\n`;
              }
              injectContext += agent.content;
              injectContext += `\n<!-- /CLAUSITRON:AGENT:${agent.slug} -->\n`;
              recordAgentUsage(agent.id);
            }
          }

          // Get pending skills for this project
          const pendingSkills = getPendingSkillsForProject(workingDirectory);
          for (const queuedSkill of pendingSkills) {
            const skill = getIndexedSkill(queuedSkill.skillId);
            if (skill) {
              injectContext += `\n\n<!-- CLAUSITRON:SKILL:${skill.slug} -->\n`;
              injectContext += `## Skill: ${skill.name}\n\n`;
              if (skill.description) {
                injectContext += `${skill.description}\n\n`;
              }
              injectContext += skill.content;
              injectContext += `\n<!-- /CLAUSITRON:SKILL:${skill.slug} -->\n`;
              markSkillInjected(queuedSkill.id);
              recordSkillUsage(skill.id);
            }
          }

          if (injectContext) {
            logger.info(`Injecting context for session: ${activeAgents.length} agents, ${pendingSkills.length} skills`);
          }
        } catch (error) {
          logger.error('Failed to prepare context injection:', error);
        }
      }

      return {
        decision: 'allow',
        inject_context: injectContext || undefined,
      };
    });

    // SessionEnd - Record session completion AND mark agent as completed
    this.registerHandler('SessionEnd', async (payload) => {
      const sessionId = getPayloadValue<string>(payload, 'session_id', 'sessionId');
      const workingDirectory = getPayloadValue<string>(payload, 'working_directory', 'workingDirectory');

      logger.info(`[HOOKS] SessionEnd received`, { sessionId, workingDirectory });

      // Remove this session from our hierarchy stack
      if (sessionId && workingDirectory) {
        this.popSession(workingDirectory, sessionId);
      }

      // Mark the agent as completed
      if (sessionId) {
        try {
          const agent = findAgentBySession(sessionId);
          if (agent) {
            updateAgentStatus(agent.id, 'completed');
            logger.info(`Agent marked as completed: ${agent.id}`);
          }
        } catch (error) {
          logger.error('Failed to mark agent as completed:', error);
        }
      }

      this.emit('session:end', {
        sessionId,
        projectPath: workingDirectory,
      });
      return { decision: 'allow' };
    });

    // SubagentStart - Track agent hierarchy (CRITICAL for parent-child tracking)
    // ============================================================================
    // UNDERSTANDING CLAUDE CODE'S HOOK DATA:
    //
    // Claude Code sends these fields in SubagentStart:
    // - session_id: The session ID (may be parent OR subagent depending on version)
    // - agent_id: The UNIQUE ID of this subagent (e.g., "a7d4f88")
    // - agent_type: The type of subagent (e.g., "Explore", "Plan", "general-purpose")
    // - parent_session_id: SOMETIMES sent - the parent's session ID
    //
    // To establish hierarchy, we try multiple approaches in order:
    // 1. Use parent_session_id if provided (most reliable)
    // 2. Use session stack (tracks Task tool invocations to infer parents)
    // 3. Use session_id if it matches a known parent session
    // 4. Use ID-based lookup if agent_id contains parent reference
    // ============================================================================
    this.registerHandler('SubagentStart', async (payload) => {
      // Get the subagent's unique ID (this is what makes each subagent unique)
      const subagentId = getPayloadValue<string>(payload, 'agent_id', 'agentId');
      // Get the subagent type (used for naming)
      const subagentType = getPayloadValue<string>(payload, 'agent_type', 'agentType');
      // Get ALL session IDs - we'll try multiple approaches
      const sessionId = getPayloadValue<string>(payload, 'session_id', 'sessionId');
      const explicitParentSessionId = getPayloadValue<string>(payload, 'parent_session_id', 'parentSessionId');
      const workingDirectory = getPayloadValue<string>(payload, 'working_directory', 'workingDirectory');
      // agent_name may be provided (legacy support)
      const agentName = getPayloadValue<string>(payload, 'agent_name', 'agentName');

      logger.info(`[HOOKS] SubagentStart received - FULL DEBUG`, {
        subagentId,
        subagentType,
        sessionId,
        explicitParentSessionId,
        workingDirectory,
        agentName,
        fullPayload: JSON.stringify(payload),
      });

      // Create CHILD agent with parent relationship
      if (subagentId) {
        try {
          // === MULTI-STRATEGY PARENT LOOKUP ===
          let parentId: string | null = null;
          let parentLookupMethod: string = 'none';

          // Strategy 1: Use explicit parent_session_id if provided
          if (!parentId && explicitParentSessionId) {
            const parentAgent = findAgentBySession(explicitParentSessionId);
            if (parentAgent) {
              parentId = parentAgent.id;
              parentLookupMethod = 'explicit_parent_session_id';
              logger.info(`[HIERARCHY] Found parent via parent_session_id: ${explicitParentSessionId} -> agent ${parentId}`);
            } else {
              logger.debug(`[HIERARCHY] parent_session_id ${explicitParentSessionId} not found in registry`);
            }
          }

          // Strategy 2: Use session stack (tracks Task tool invocations)
          if (!parentId && workingDirectory) {
            const stackParentSession = this.getCurrentParentSession(workingDirectory);
            if (stackParentSession) {
              const parentAgent = findAgentBySession(stackParentSession);
              if (parentAgent) {
                parentId = parentAgent.id;
                parentLookupMethod = 'session_stack';
                logger.info(`[HIERARCHY] Found parent via session stack: ${stackParentSession} -> agent ${parentId}`);
              } else {
                // Try direct ID lookup in case the stack has the agent ID not session
                const directAgent = getAgent(stackParentSession);
                if (directAgent) {
                  parentId = directAgent.id;
                  parentLookupMethod = 'session_stack_direct_id';
                  logger.info(`[HIERARCHY] Found parent via session stack (direct ID): ${stackParentSession}`);
                }
              }
            }
          }

          // Strategy 3: Use session_id if it matches a known parent
          if (!parentId && sessionId) {
            const parentAgent = findAgentBySession(sessionId);
            if (parentAgent) {
              parentId = parentAgent.id;
              parentLookupMethod = 'session_id_as_parent';
              logger.info(`[HIERARCHY] Found parent via session_id: ${sessionId} -> agent ${parentId}`);
            } else {
              // Try direct ID lookup
              const directAgent = getAgent(sessionId);
              if (directAgent) {
                parentId = directAgent.id;
                parentLookupMethod = 'session_id_direct_lookup';
                logger.info(`[HIERARCHY] Found parent via session_id (direct ID): ${sessionId}`);
              }
            }
          }

          // Strategy 4: If subagent ID looks like it contains parent reference (e.g., "parent-child")
          // This is a fallback heuristic
          if (!parentId && subagentId && subagentId.includes('-')) {
            const possibleParentId = subagentId.split('-')[0];
            const parentAgent = getAgent(possibleParentId);
            if (parentAgent) {
              parentId = parentAgent.id;
              parentLookupMethod = 'id_parsing_heuristic';
              logger.info(`[HIERARCHY] Found parent via ID parsing: ${possibleParentId}`);
            }
          }

          // Log final result
          if (parentId) {
            logger.info(`[HIERARCHY] SUCCESS - Subagent ${subagentId} linked to parent ${parentId} via ${parentLookupMethod}`);
          } else {
            logger.warn(`[HIERARCHY] FAILED - Could not find parent for subagent ${subagentId}. Tried: parent_session_id=${explicitParentSessionId}, stack, session_id=${sessionId}`);

            // Debug: Log all known agents to help diagnose
            const allAgents = getAllAgents();
            logger.warn(`[HIERARCHY DEBUG] Known agents in registry (${allAgents.length}):`,
              allAgents.map(a => ({ id: a.id, name: a.name, sessionPath: a.sessionPath }))
            );
          }

          // Generate a descriptive name
          // Priority: explicit agentName > subagentType > fallback
          const effectiveName = agentName || subagentType || `Subagent-${subagentId}`;

          const agent = upsertAgent({
            id: subagentId,  // Use the unique agent_id from Claude
            name: effectiveName,
            pid: null,
            cwd: workingDirectory || process.cwd(),
            parentId,        // Link to parent (may be null if lookup failed)
            templateId: null,
            status: 'active' as AgentStatus,
            sessionPath: subagentId,  // Use agent_id as session path for this subagent
            initialPrompt: null,
          });

          logger.info(`[HIERARCHY] Subagent created in database:`, {
            agentId: agent.id,
            agentName: agent.name,
            parentId: agent.parentId,
            sessionPath: agent.sessionPath,
            lookupMethod: parentLookupMethod,
          });

          // Notify renderer of new agent with proper hierarchy
          const mainWindow = getMainWindow();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('agent:detected', {
              id: agent.id,
              name: effectiveName,
              parentId: agent.parentId,
              sessionId: subagentId,
            });
          }
        } catch (error) {
          logger.error('Failed to create subagent:', error);
        }
      } else {
        logger.warn('[HOOKS] SubagentStart missing agent_id - cannot create agent');
      }

      this.emit('agent:start', {
        agentName: agentName || subagentType || null,
        sessionId: subagentId,
      });
      return { decision: 'allow' };
    });

    // SubagentStop - Track agent completion
    // ============================================================================
    // SubagentStop also sends agent_id as the unique subagent identifier
    // ============================================================================
    this.registerHandler('SubagentStop', async (payload) => {
      // agent_id is the unique subagent ID
      const subagentId = getPayloadValue<string>(payload, 'agent_id', 'agentId');
      const agentName = getPayloadValue<string>(payload, 'agent_name', 'agentName');
      const parentSessionId = getPayloadValue<string>(payload, 'session_id', 'sessionId');
      const workingDirectory = getPayloadValue<string>(payload, 'working_directory', 'workingDirectory');

      logger.info(`[HOOKS] SubagentStop received`, { subagentId, agentName, parentSessionId, workingDirectory });

      // Mark the subagent as completed using agent_id
      if (subagentId) {
        try {
          // First try looking up by ID directly (most reliable)
          let agent = getAgent(subagentId);
          if (!agent) {
            // Fallback to session path lookup
            agent = findAgentBySession(subagentId);
          }

          if (agent) {
            updateAgentStatus(agent.id, 'completed');
            logger.info(`Subagent marked as completed: ${agent.id} (${agentName || agent.name})`);
          } else {
            logger.warn(`[HOOKS] SubagentStop: Could not find agent with ID ${subagentId}`);
          }
        } catch (error) {
          logger.error('Failed to mark subagent as completed:', error);
        }
      } else {
        logger.warn('[HOOKS] SubagentStop missing agent_id');
      }

      this.emit('agent:stop', {
        agentName,
        sessionId: subagentId,
      });
      return { decision: 'allow' };
    });

    // PermissionRequest - Route to approval queue
    this.registerHandler('PermissionRequest', async (payload) => {
      const permissionType = getPayloadValue<string>(payload, 'permission_type', 'permissionType');
      const permissionDetails = getPayloadValue<string>(payload, 'permission_details', 'permissionDetails');
      const sessionId = getPayloadValue<string>(payload, 'session_id', 'sessionId');

      // Future: Add to approval queue, check policies
      this.emit('permission:requested', {
        type: permissionType,
        details: permissionDetails,
        sessionId,
      });
      return { decision: 'allow' };
    });

    // Notification - Route to GoodVibes notifications
    this.registerHandler('Notification', async (payload) => {
      const notificationType = getPayloadValue<string>(payload, 'notification_type', 'notificationType');
      const notificationMessage = getPayloadValue<string>(payload, 'notification_message', 'notificationMessage');
      const sessionId = getPayloadValue<string>(payload, 'session_id', 'sessionId');

      this.notifyRenderer('hook:notification', {
        type: notificationType,
        message: notificationMessage,
        sessionId,
      });
      return { decision: 'allow' };
    });
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let hookServer: HookServerService | null = null;

export function getHookServer(): HookServerService {
  if (!hookServer) {
    hookServer = new HookServerService();
  }
  return hookServer;
}

export async function startHookServer(): Promise<void> {
  const server = getHookServer();
  await server.start();
}

export async function stopHookServer(): Promise<void> {
  if (hookServer) {
    await hookServer.stop();
  }
}

export function getHookServerStatus(): { running: boolean; port: number } {
  return hookServer?.getStatus() ?? { running: false, port: HOOK_SERVER_PORT };
}

// Export the class for testing
export { HookServerService };
