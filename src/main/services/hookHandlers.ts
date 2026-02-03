// ============================================================================
// HOOK HANDLERS - Enhanced handlers integrating services
// ============================================================================
//
// This module registers enhanced hook handlers that integrate:
// - Approval Queue with Policy Engine
// - Agent Tree Orchestration
//
// ============================================================================

import { Logger } from './logger.js';
import { getHookServer, type HookPayload, type HookResponse } from './hookServer.js';
import { getPolicyEngine } from './policyEngine.js';
import { getAgentTreeService } from './agentTree.js';
import type { ExtendedHookEventType } from '../database/hookEvents.js';

const logger = new Logger('HookHandlers');

// ============================================================================
// HANDLER REGISTRATION
// ============================================================================

/**
 * Register all enhanced hook handlers
 */
export function registerEnhancedHookHandlers(): void {
  const hookServer = getHookServer();

  // Clear existing handlers and register enhanced ones
  const eventTypes: ExtendedHookEventType[] = [
    'PreToolUse',
    'PostToolUse',
    'SessionStart',
    'SessionEnd',
    'Stop',
    'SubagentStart',
    'SubagentStop',
    'PermissionRequest',
    'UserPromptSubmit',
  ];

  for (const eventType of eventTypes) {
    hookServer.clearHandlers(eventType);
  }

  // Register enhanced handlers
  hookServer.registerHandler('PreToolUse', handlePreToolUse);
  hookServer.registerHandler('PostToolUse', handlePostToolUse);
  hookServer.registerHandler('SessionStart', handleSessionStart);
  hookServer.registerHandler('SessionEnd', handleSessionEnd);
  hookServer.registerHandler('Stop', handleStop);
  hookServer.registerHandler('SubagentStart', handleSubagentStart);
  hookServer.registerHandler('SubagentStop', handleSubagentStop);
  hookServer.registerHandler('PermissionRequest', handlePermissionRequest);
  hookServer.registerHandler('UserPromptSubmit', handleUserPromptSubmit);

  logger.info('Enhanced hook handlers registered');
}

// ============================================================================
// PRE-TOOL-USE HANDLER
// ============================================================================

/**
 * Handle PreToolUse - Track tool calls in agent tree
 */
async function handlePreToolUse(payload: HookPayload): Promise<HookResponse> {
  // Track tool call in agent tree if in sub-agent context
  if (payload.session_id) {
    const agentTree = getAgentTreeService();
    const agent = agentTree.getAgent(payload.session_id);
    if (agent) {
      agentTree.recordToolCall(payload.session_id);
    }
  }

  return { decision: 'allow' };
}

// ============================================================================
// POST-TOOL-USE HANDLER
// ============================================================================

/**
 * Handle PostToolUse - Track in agent tree after tool execution
 */
async function handlePostToolUse(_payload: HookPayload): Promise<HookResponse> {
  // Agent tree tracking handled in PreToolUse
  return { decision: 'allow' };
}

// ============================================================================
// SESSION START HANDLER
// ============================================================================

/**
 * Handle SessionStart - Context injection for agents/skills is handled by hookServer.ts
 */
async function handleSessionStart(_payload: HookPayload): Promise<HookResponse> {
  // Note: Context injection for agents/skills is handled by the existing
  // handler in hookServer.ts
  return { decision: 'allow' };
}

// ============================================================================
// SESSION END HANDLER
// ============================================================================

/**
 * Handle SessionEnd - Session cleanup
 */
async function handleSessionEnd(_payload: HookPayload): Promise<HookResponse> {
  return { decision: 'allow' };
}

// ============================================================================
// STOP HANDLER
// ============================================================================

/**
 * Handle Stop - Session stop event
 */
async function handleStop(_payload: HookPayload): Promise<HookResponse> {
  return { decision: 'allow' };
}

// ============================================================================
// SUBAGENT START HANDLER
// ============================================================================

/**
 * Handle SubagentStart - Register in agent tree
 */
async function handleSubagentStart(payload: HookPayload): Promise<HookResponse> {
  const agentTree = getAgentTreeService();

  if (payload.session_id && payload.agent_name) {
    agentTree.handleAgentStart({
      sessionId: payload.session_id,
      agentName: payload.agent_name,
      parentSessionId: payload.parent_session_id,
    });
  }

  return { decision: 'allow' };
}

// ============================================================================
// SUBAGENT STOP HANDLER
// ============================================================================

/**
 * Handle SubagentStop - Update agent tree
 */
async function handleSubagentStop(payload: HookPayload): Promise<HookResponse> {
  const agentTree = getAgentTreeService();

  if (payload.session_id) {
    agentTree.handleAgentStop({
      sessionId: payload.session_id,
      success: true, // Assume success unless indicated otherwise
    });
  }

  return { decision: 'allow' };
}

// ============================================================================
// PERMISSION REQUEST HANDLER
// ============================================================================

/**
 * Handle PermissionRequest - Route through policy engine
 */
async function handlePermissionRequest(payload: HookPayload): Promise<HookResponse> {
  const policyEngine = getPolicyEngine();

  // Parse permission details
  let toolName: string | undefined;
  let filePath: string | undefined;
  let command: string | undefined;

  if (payload.permission_details) {
    try {
      const details = typeof payload.permission_details === 'string'
        ? JSON.parse(payload.permission_details)
        : payload.permission_details;

      toolName = details.tool_name || details.toolName;
      filePath = details.file_path || details.filePath;
      command = details.command;
    } catch (error) {
      // Log parse failure and continue with raw details - this is expected for non-JSON permission details
      logger.debug('Permission details not in JSON format, using raw value', {
        sessionId: payload.session_id,
        permissionType: payload.permission_type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Process through policy engine
  const decision = await policyEngine.processPermissionRequest({
    sessionId: payload.session_id || 'unknown',
    permissionType: payload.permission_type || 'unknown',
    toolName,
    filePath,
    command,
    details: payload.permission_details ? { raw: payload.permission_details } : undefined,
  });

  if (decision.approved) {
    return { decision: 'allow' };
  }

  if (decision.queueItem) {
    // Permission queued for manual review
    // For now, we'll block and require the user to approve in GoodVibes
    return {
      decision: 'block',
      message: 'Permission requires approval in GoodVibes. Check the approval queue.',
    };
  }

  // Auto-denied by policy
  return {
    decision: 'deny',
    message: decision.reason,
  };
}

// ============================================================================
// USER PROMPT SUBMIT HANDLER
// ============================================================================

/**
 * Handle UserPromptSubmit - User prompt received
 */
async function handleUserPromptSubmit(_payload: HookPayload): Promise<HookResponse> {
  return { decision: 'allow' };
}

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize all services and register handlers
 */
export function initializeHookHandlers(): void {
  // Initialize services
  getPolicyEngine();
  getAgentTreeService().initialize();

  // Install default policies
  getPolicyEngine().installDefaultPolicies();

  // Register enhanced handlers
  registerEnhancedHookHandlers();

  logger.info('Hook handlers initialized');
}
