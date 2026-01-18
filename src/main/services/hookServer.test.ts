// ============================================================================
// HOOK SERVER TESTS
// ============================================================================
//
// Comprehensive tests for the HookServerService components.
// Tests cover:
// - Payload value extraction helper
// - Types and constants
// - Handler creation and registration
//
// NOTE: These are unit tests that test individual components without
// starting an actual HTTP server. Integration tests should be run separately.
// ============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================================
// MOCKS - Must be defined before imports using vi.hoisted
// ============================================================================

const { mockSend } = vi.hoisted(() => {
  // Mock window send function
  const mockSend = vi.fn();

  return { mockSend };
});

// Mock database functions
vi.mock('../../database/hookEvents.js', () => ({
  recordHookEvent: vi.fn(),
}));

// Mock database primitives
vi.mock('../../database/primitives.js', () => ({
  findAgentBySession: vi.fn(() => null),
  upsertAgent: vi.fn((agent: { id: string; name: string; parentId: string | null; status: string; sessionPath: string | null }) => ({
    id: agent.id,
    name: agent.name,
    parentId: agent.parentId,
    status: agent.status,
    sessionPath: agent.sessionPath,
  })),
  updateAgentStatus: vi.fn(),
  getAgent: vi.fn(() => null),
  getAllAgents: vi.fn(() => []),
}));

// Mock agency index
vi.mock('../../database/agencyIndex.js', () => ({
  getActiveAgentsForProject: vi.fn(() => []),
  getPendingSkillsForProject: vi.fn(() => []),
  getIndexedAgent: vi.fn(() => null),
  getIndexedSkill: vi.fn(() => null),
  markSkillInjected: vi.fn(),
  recordAgentUsage: vi.fn(),
  recordSkillUsage: vi.fn(),
}));

// Mock window module
vi.mock('../../window.js', () => ({
  getMainWindow: vi.fn(() => ({
    isDestroyed: () => false,
    webContents: {
      send: mockSend,
    },
  })),
}));

// Mock logger
vi.mock('./logger.js', () => ({
  Logger: class MockLogger {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    debug = vi.fn();
  },
}));

// Mock date utils
vi.mock('../../../shared/dateUtils.js', () => ({
  formatTimestamp: vi.fn(() => new Date().toISOString()),
}));

// ============================================================================
// IMPORTS - After mocks
// ============================================================================

import { HOOK_SERVER_PORT, getPayloadValue, type HookPayload } from './hookServer/types.js';

// ============================================================================
// TESTS
// ============================================================================

describe('Hook Server Types', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // CONSTANTS
  // ==========================================================================

  describe('HOOK_SERVER_PORT', () => {
    it('should be defined', () => {
      expect(HOOK_SERVER_PORT).toBeDefined();
      expect(typeof HOOK_SERVER_PORT).toBe('number');
    });

    it('should be a valid port number', () => {
      expect(HOOK_SERVER_PORT).toBeGreaterThan(0);
      expect(HOOK_SERVER_PORT).toBeLessThan(65536);
    });

    it('should use the standard hook server port', () => {
      expect(HOOK_SERVER_PORT).toBe(23847);
    });
  });

  // ==========================================================================
  // getPayloadValue HELPER
  // ==========================================================================

  describe('getPayloadValue', () => {
    it('should return camelCase value when present', () => {
      const payload: HookPayload = {
        hook_event_name: 'PreToolUse',
        sessionId: 'camel-value',
      };

      const result = getPayloadValue<string>(payload, 'session_id', 'sessionId');
      expect(result).toBe('camel-value');
    });

    it('should return snake_case value when camelCase is missing', () => {
      const payload: HookPayload = {
        hook_event_name: 'PreToolUse',
        session_id: 'snake-value',
      };

      const result = getPayloadValue<string>(payload, 'session_id', 'sessionId');
      expect(result).toBe('snake-value');
    });

    it('should return undefined when neither is present', () => {
      const payload: HookPayload = {
        hook_event_name: 'PreToolUse',
      };

      const result = getPayloadValue<string>(payload, 'session_id', 'sessionId');
      expect(result).toBeUndefined();
    });

    it('should prefer camelCase when both are provided', () => {
      const payload: HookPayload = {
        hook_event_name: 'PreToolUse',
        session_id: 'snake-value',
        sessionId: 'camel-value',
      };

      const result = getPayloadValue<string>(payload, 'session_id', 'sessionId');
      expect(result).toBe('camel-value');
    });

    it('should handle complex types', () => {
      const payload: HookPayload = {
        hook_event_name: 'PostToolUse',
        toolResponse: { success: true, content: 'result' },
      };

      const result = getPayloadValue<{ success: boolean; content: string }>(
        payload,
        'tool_response',
        'toolResponse'
      );
      expect(result).toEqual({ success: true, content: 'result' });
    });

    it('should handle null values', () => {
      const payload: HookPayload = {
        hook_event_name: 'PreToolUse',
        sessionId: null as unknown as string,
      };

      const result = getPayloadValue<string>(payload, 'session_id', 'sessionId');
      // getPayloadValue returns undefined for null values since it checks for truthy camelCase first
      expect(result).toBeUndefined();
    });

    it('should handle empty string values', () => {
      const payload: HookPayload = {
        hook_event_name: 'PreToolUse',
        session_id: '',
      };

      const result = getPayloadValue<string>(payload, 'session_id', 'sessionId');
      expect(result).toBe('');
    });

    it('should handle numeric values', () => {
      // Using tool_response which is an actual payload field that can contain numbers
      const payload: HookPayload = {
        hook_event_name: 'PostToolUse',
        toolResponse: { exitCode: 2 },
      };

      const result = getPayloadValue<{ exitCode: number }>(payload, 'tool_response', 'toolResponse');
      expect(result?.exitCode).toBe(2);
    });

    it('should handle boolean values', () => {
      // Using a valid payload structure
      const payload: HookPayload = {
        hook_event_name: 'PostToolUse',
        toolResponse: { success: true },
      };

      const result = getPayloadValue<{ success: boolean }>(payload, 'tool_response', 'toolResponse');
      expect(result?.success).toBe(true);
    });

    it('should handle array values', () => {
      // Using a valid payload structure
      const payload: HookPayload = {
        hook_event_name: 'PostToolUse',
        toolResponse: { files: ['file1.ts', 'file2.ts'] },
      };

      const result = getPayloadValue<{ files: string[] }>(payload, 'tool_response', 'toolResponse');
      expect(result?.files).toEqual(['file1.ts', 'file2.ts']);
    });
  });

  // ==========================================================================
  // PAYLOAD FIELD NORMALIZATION
  // ==========================================================================

  describe('Payload Field Normalization', () => {
    it('should extract session_id correctly', () => {
      const snakePayload: HookPayload = { hook_event_name: 'SessionStart', session_id: 'session-1' };
      const camelPayload: HookPayload = { hook_event_name: 'SessionStart', sessionId: 'session-2' };

      expect(getPayloadValue(snakePayload, 'session_id', 'sessionId')).toBe('session-1');
      expect(getPayloadValue(camelPayload, 'session_id', 'sessionId')).toBe('session-2');
    });

    it('should extract working_directory correctly', () => {
      const snakePayload: HookPayload = { hook_event_name: 'SessionStart', working_directory: '/path/1' };
      const camelPayload: HookPayload = { hook_event_name: 'SessionStart', workingDirectory: '/path/2' };

      expect(getPayloadValue(snakePayload, 'working_directory', 'workingDirectory')).toBe('/path/1');
      expect(getPayloadValue(camelPayload, 'working_directory', 'workingDirectory')).toBe('/path/2');
    });

    it('should extract tool_name correctly', () => {
      const snakePayload: HookPayload = { hook_event_name: 'PreToolUse', tool_name: 'Read' };
      const camelPayload: HookPayload = { hook_event_name: 'PreToolUse', toolName: 'Write' };

      expect(getPayloadValue(snakePayload, 'tool_name', 'toolName')).toBe('Read');
      expect(getPayloadValue(camelPayload, 'tool_name', 'toolName')).toBe('Write');
    });

    it('should extract tool_input correctly', () => {
      const input = { file_path: '/test/file.ts' };
      const snakePayload: HookPayload = { hook_event_name: 'PreToolUse', tool_input: input };
      const camelPayload: HookPayload = { hook_event_name: 'PreToolUse', toolInput: input };

      expect(getPayloadValue(snakePayload, 'tool_input', 'toolInput')).toEqual(input);
      expect(getPayloadValue(camelPayload, 'tool_input', 'toolInput')).toEqual(input);
    });

    it('should extract tool_response correctly', () => {
      const response = { success: true, content: 'file contents' };
      const snakePayload: HookPayload = { hook_event_name: 'PostToolUse', tool_response: response };
      const camelPayload: HookPayload = { hook_event_name: 'PostToolUse', toolResponse: response };

      expect(getPayloadValue(snakePayload, 'tool_response', 'toolResponse')).toEqual(response);
      expect(getPayloadValue(camelPayload, 'tool_response', 'toolResponse')).toEqual(response);
    });

    it('should extract agent_id correctly', () => {
      const snakePayload: HookPayload = { hook_event_name: 'SubagentStart', agent_id: 'agent-1' };
      const camelPayload: HookPayload = { hook_event_name: 'SubagentStart', agentId: 'agent-2' };

      expect(getPayloadValue(snakePayload, 'agent_id', 'agentId')).toBe('agent-1');
      expect(getPayloadValue(camelPayload, 'agent_id', 'agentId')).toBe('agent-2');
    });

    it('should extract agent_name correctly', () => {
      const snakePayload: HookPayload = { hook_event_name: 'SubagentStart', agent_name: 'Test Agent 1' };
      const camelPayload: HookPayload = { hook_event_name: 'SubagentStart', agentName: 'Test Agent 2' };

      expect(getPayloadValue(snakePayload, 'agent_name', 'agentName')).toBe('Test Agent 1');
      expect(getPayloadValue(camelPayload, 'agent_name', 'agentName')).toBe('Test Agent 2');
    });

    it('should extract agent_type correctly', () => {
      const snakePayload: HookPayload = { hook_event_name: 'SubagentStart', agent_type: 'Task' };
      const camelPayload: HookPayload = { hook_event_name: 'SubagentStart', agentType: 'Agent' };

      expect(getPayloadValue(snakePayload, 'agent_type', 'agentType')).toBe('Task');
      expect(getPayloadValue(camelPayload, 'agent_type', 'agentType')).toBe('Agent');
    });

    it('should extract parent_session_id correctly', () => {
      const snakePayload: HookPayload = { hook_event_name: 'SubagentStart', parent_session_id: 'parent-1' };
      const camelPayload: HookPayload = { hook_event_name: 'SubagentStart', parentSessionId: 'parent-2' };

      expect(getPayloadValue(snakePayload, 'parent_session_id', 'parentSessionId')).toBe('parent-1');
      expect(getPayloadValue(camelPayload, 'parent_session_id', 'parentSessionId')).toBe('parent-2');
    });

    it('should extract permission_type correctly', () => {
      const snakePayload: HookPayload = { hook_event_name: 'PermissionRequest', permission_type: 'file_write' };
      const camelPayload: HookPayload = { hook_event_name: 'PermissionRequest', permissionType: 'network' };

      expect(getPayloadValue(snakePayload, 'permission_type', 'permissionType')).toBe('file_write');
      expect(getPayloadValue(camelPayload, 'permission_type', 'permissionType')).toBe('network');
    });

    it('should extract permission_details correctly', () => {
      const snakePayload: HookPayload = { hook_event_name: 'PermissionRequest', permission_details: '/etc/passwd' };
      const camelPayload: HookPayload = { hook_event_name: 'PermissionRequest', permissionDetails: 'https://api.example.com' };

      expect(getPayloadValue(snakePayload, 'permission_details', 'permissionDetails')).toBe('/etc/passwd');
      expect(getPayloadValue(camelPayload, 'permission_details', 'permissionDetails')).toBe('https://api.example.com');
    });

    it('should extract notification_type correctly', () => {
      const snakePayload: HookPayload = { hook_event_name: 'Notification', notification_type: 'info' };
      const camelPayload: HookPayload = { hook_event_name: 'Notification', notificationType: 'warning' };

      expect(getPayloadValue(snakePayload, 'notification_type', 'notificationType')).toBe('info');
      expect(getPayloadValue(camelPayload, 'notification_type', 'notificationType')).toBe('warning');
    });

    it('should extract notification_message correctly', () => {
      const snakePayload: HookPayload = { hook_event_name: 'Notification', notification_message: 'Task complete' };
      const camelPayload: HookPayload = { hook_event_name: 'Notification', notificationMessage: 'Error occurred' };

      expect(getPayloadValue(snakePayload, 'notification_message', 'notificationMessage')).toBe('Task complete');
      expect(getPayloadValue(camelPayload, 'notification_message', 'notificationMessage')).toBe('Error occurred');
    });
  });

  // ==========================================================================
  // HOOK EVENT TYPES
  // ==========================================================================

  describe('Hook Event Types', () => {
    it('should recognize valid hook event types', () => {
      // These are the extended hook event types used by the hook server
      const validEventTypes: Array<HookPayload['hook_event_name']> = [
        'PreToolUse',
        'PostToolUse',
        'SessionStart',
        'SessionEnd',
        'SubagentStart',
        'SubagentStop',
        'PermissionRequest',
        'Notification',
        'Stop',
      ];

      validEventTypes.forEach((eventType) => {
        const payload: HookPayload = { hook_event_name: eventType };
        expect(payload.hook_event_name).toBe(eventType);
      });
    });
  });
});
