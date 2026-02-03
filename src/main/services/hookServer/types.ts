// ============================================================================
// HOOK SERVER TYPES
// ============================================================================

import type { ExtendedHookEventType } from '../../database/hookEvents.js';

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
// HELPER FUNCTIONS
// ============================================================================

/**
 * Helper to get a value from payload, supporting both camelCase and snake_case
 */
export function getPayloadValue<T>(payload: HookPayload, snakeCase: keyof HookPayload, camelCase: keyof HookPayload): T | undefined {
  return (payload[camelCase] ?? payload[snakeCase]) as T | undefined;
}
