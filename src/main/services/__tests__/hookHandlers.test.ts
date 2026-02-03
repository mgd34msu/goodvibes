// ============================================================================
// HOOK HANDLERS TESTS
// ============================================================================
//
// Comprehensive tests for hook handlers integrating services.
// Tests cover:
// - PreToolUse - Agent tree tracking
// - PostToolUse - Post-execution handling
// - PermissionRequest - SECURITY CRITICAL policy engine routing
// - SubagentStart/Stop - Agent tree orchestration
// - SessionStart/End/Stop handlers
//
// ============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { HookPayload, HookResponse } from '../hookServer.js';

// ============================================================================
// MOCKS - Must be defined before imports
// ============================================================================

const mockAgentTreeService = {
  initialize: vi.fn(),
  getAgent: vi.fn(),
  recordToolCall: vi.fn(),
  handleAgentStart: vi.fn(),
  handleAgentStop: vi.fn(),
};

const mockPolicyEngine = {
  processPermissionRequest: vi.fn(),
  installDefaultPolicies: vi.fn(),
};

const mockHookServer = {
  clearHandlers: vi.fn(),
  registerHandler: vi.fn(),
};

// Mock services
vi.mock('../agentTree.js', () => ({
  getAgentTreeService: vi.fn(() => mockAgentTreeService),
}));

vi.mock('../policyEngine.js', () => ({
  getPolicyEngine: vi.fn(() => mockPolicyEngine),
}));

vi.mock('../hookServer.js', () => ({
  getHookServer: vi.fn(() => mockHookServer),
}));

vi.mock('../logger.js', () => ({
  Logger: class MockLogger {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    debug = vi.fn();
  },
}));

// ============================================================================
// IMPORTS - After mocks
// ============================================================================

import {
  registerEnhancedHookHandlers,
  initializeHookHandlers,
} from '../hookHandlers.js';

// ============================================================================
// TEST HELPERS
// ============================================================================

function createHookPayload(overrides: Partial<HookPayload> = {}): HookPayload {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 'test-session-123',
    ...overrides,
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe('Hook Handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // HANDLER REGISTRATION
  // ==========================================================================

  describe('registerEnhancedHookHandlers', () => {
    it('should clear existing handlers', () => {
      registerEnhancedHookHandlers();

      expect(mockHookServer.clearHandlers).toHaveBeenCalledWith('PreToolUse');
      expect(mockHookServer.clearHandlers).toHaveBeenCalledWith('PostToolUse');
      expect(mockHookServer.clearHandlers).toHaveBeenCalledWith('SessionStart');
      expect(mockHookServer.clearHandlers).toHaveBeenCalledWith('SessionEnd');
      expect(mockHookServer.clearHandlers).toHaveBeenCalledWith('Stop');
      expect(mockHookServer.clearHandlers).toHaveBeenCalledWith('SubagentStart');
      expect(mockHookServer.clearHandlers).toHaveBeenCalledWith('SubagentStop');
      expect(mockHookServer.clearHandlers).toHaveBeenCalledWith('PermissionRequest');
      expect(mockHookServer.clearHandlers).toHaveBeenCalledWith('UserPromptSubmit');
    });

    it('should register all enhanced handlers', () => {
      registerEnhancedHookHandlers();

      expect(mockHookServer.registerHandler).toHaveBeenCalledWith('PreToolUse', expect.any(Function));
      expect(mockHookServer.registerHandler).toHaveBeenCalledWith('PostToolUse', expect.any(Function));
      expect(mockHookServer.registerHandler).toHaveBeenCalledWith('SessionStart', expect.any(Function));
      expect(mockHookServer.registerHandler).toHaveBeenCalledWith('SessionEnd', expect.any(Function));
      expect(mockHookServer.registerHandler).toHaveBeenCalledWith('Stop', expect.any(Function));
      expect(mockHookServer.registerHandler).toHaveBeenCalledWith('SubagentStart', expect.any(Function));
      expect(mockHookServer.registerHandler).toHaveBeenCalledWith('SubagentStop', expect.any(Function));
      expect(mockHookServer.registerHandler).toHaveBeenCalledWith('PermissionRequest', expect.any(Function));
      expect(mockHookServer.registerHandler).toHaveBeenCalledWith('UserPromptSubmit', expect.any(Function));
    });
  });

  describe('initializeHookHandlers', () => {
    it('should initialize all services', () => {
      initializeHookHandlers();

      expect(mockAgentTreeService.initialize).toHaveBeenCalled();
      expect(mockPolicyEngine.installDefaultPolicies).toHaveBeenCalled();
    });

    it('should register enhanced handlers', () => {
      initializeHookHandlers();

      expect(mockHookServer.registerHandler).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // PRE-TOOL-USE HANDLER
  // ==========================================================================

  describe('handlePreToolUse', () => {
    let preToolUseHandler: (payload: HookPayload) => Promise<HookResponse>;

    beforeEach(() => {
      registerEnhancedHookHandlers();
      // Extract the PreToolUse handler from registerHandler calls
      const preToolUseCall = mockHookServer.registerHandler.mock.calls.find(
        call => call[0] === 'PreToolUse'
      );
      preToolUseHandler = preToolUseCall?.[1] as (payload: HookPayload) => Promise<HookResponse>;
    });

    it('should track tool call in agent tree when agent exists', async () => {
      const mockAgent = { id: 'test-agent', name: 'TestAgent' };
      mockAgentTreeService.getAgent.mockReturnValue(mockAgent);

      const payload = createHookPayload({ session_id: 'test-session-123' });
      const result = await preToolUseHandler(payload);

      expect(mockAgentTreeService.getAgent).toHaveBeenCalledWith('test-session-123');
      expect(mockAgentTreeService.recordToolCall).toHaveBeenCalledWith('test-session-123');
      expect(result.decision).toBe('allow');
    });

    it('should not track when agent does not exist', async () => {
      mockAgentTreeService.getAgent.mockReturnValue(null);

      const payload = createHookPayload({ session_id: 'test-session-123' });
      const result = await preToolUseHandler(payload);

      expect(mockAgentTreeService.recordToolCall).not.toHaveBeenCalled();
      expect(result.decision).toBe('allow');
    });

    it('should handle missing session_id', async () => {
      const payload = createHookPayload({ session_id: undefined });
      const result = await preToolUseHandler(payload);

      expect(mockAgentTreeService.getAgent).not.toHaveBeenCalled();
      expect(result.decision).toBe('allow');
    });
  });

  // ==========================================================================
  // POST-TOOL-USE HANDLER
  // ==========================================================================

  describe('handlePostToolUse', () => {
    let postToolUseHandler: (payload: HookPayload) => Promise<HookResponse>;

    beforeEach(() => {
      registerEnhancedHookHandlers();
      const postToolUseCall = mockHookServer.registerHandler.mock.calls.find(
        call => call[0] === 'PostToolUse'
      );
      postToolUseHandler = postToolUseCall?.[1] as (payload: HookPayload) => Promise<HookResponse>;
    });

    it('should return allow decision', async () => {
      const payload = createHookPayload({ hook_event_name: 'PostToolUse' });
      const result = await postToolUseHandler(payload);

      expect(result.decision).toBe('allow');
    });
  });

  // ==========================================================================
  // PERMISSION REQUEST HANDLER - SECURITY CRITICAL
  // ==========================================================================

  describe('handlePermissionRequest', () => {
    let permissionHandler: (payload: HookPayload) => Promise<HookResponse>;

    beforeEach(() => {
      registerEnhancedHookHandlers();
      const permissionCall = mockHookServer.registerHandler.mock.calls.find(
        call => call[0] === 'PermissionRequest'
      );
      permissionHandler = permissionCall?.[1] as (payload: HookPayload) => Promise<HookResponse>;
    });

    it('should allow when policy engine approves', async () => {
      mockPolicyEngine.processPermissionRequest.mockResolvedValue({
        approved: true,
      });

      const payload = createHookPayload({
        hook_event_name: 'PermissionRequest',
        permission_type: 'file_write',
        permission_details: JSON.stringify({
          tool_name: 'Write',
          file_path: '/test/file.ts',
        }),
      });

      const result = await permissionHandler(payload);

      expect(mockPolicyEngine.processPermissionRequest).toHaveBeenCalledWith({
        sessionId: 'test-session-123',
        permissionType: 'file_write',
        toolName: 'Write',
        filePath: '/test/file.ts',
        command: undefined,
        details: expect.any(Object),
      });
      expect(result.decision).toBe('allow');
    });

    it('should block when permission is queued', async () => {
      mockPolicyEngine.processPermissionRequest.mockResolvedValue({
        approved: false,
        queueItem: { id: 1, status: 'pending' },
      });

      const payload = createHookPayload({
        hook_event_name: 'PermissionRequest',
        permission_type: 'command_execute',
        permission_details: JSON.stringify({ command: 'rm -rf /' }),
      });

      const result = await permissionHandler(payload);

      expect(result.decision).toBe('block');
      expect(result.message).toContain('approval queue');
    });

    it('should deny when policy engine auto-denies', async () => {
      mockPolicyEngine.processPermissionRequest.mockResolvedValue({
        approved: false,
        reason: 'Dangerous operation blocked by policy',
      });

      const payload = createHookPayload({
        hook_event_name: 'PermissionRequest',
        permission_type: 'command_execute',
        permission_details: JSON.stringify({ command: 'rm -rf /' }),
      });

      const result = await permissionHandler(payload);

      expect(result.decision).toBe('deny');
      expect(result.message).toBe('Dangerous operation blocked by policy');
    });

    it('should handle JSON permission details', async () => {
      mockPolicyEngine.processPermissionRequest.mockResolvedValue({ approved: true });

      const payload = createHookPayload({
        hook_event_name: 'PermissionRequest',
        permission_type: 'tool_use',
        permission_details: JSON.stringify({
          tool_name: 'Bash',
          file_path: '/test/script.sh',
          command: 'bash script.sh',
        }),
      });

      await permissionHandler(payload);

      expect(mockPolicyEngine.processPermissionRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'Bash',
          filePath: '/test/script.sh',
          command: 'bash script.sh',
        })
      );
    });

    it('should handle object permission details', async () => {
      mockPolicyEngine.processPermissionRequest.mockResolvedValue({ approved: true });

      const payload = createHookPayload({
        hook_event_name: 'PermissionRequest',
        permission_type: 'tool_use',
        permission_details: {
          toolName: 'Edit',
          filePath: '/test/code.ts',
        },
      });

      await permissionHandler(payload);

      expect(mockPolicyEngine.processPermissionRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'Edit',
          filePath: '/test/code.ts',
        })
      );
    });

    it('should handle non-JSON permission details gracefully', async () => {
      mockPolicyEngine.processPermissionRequest.mockResolvedValue({ approved: true });

      const payload = createHookPayload({
        hook_event_name: 'PermissionRequest',
        permission_type: 'tool_use',
        permission_details: 'plain text details',
      });

      await permissionHandler(payload);

      expect(mockPolicyEngine.processPermissionRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          details: { raw: 'plain text details' },
        })
      );
    });

    it('should handle missing permission details', async () => {
      mockPolicyEngine.processPermissionRequest.mockResolvedValue({ approved: true });

      const payload = createHookPayload({
        hook_event_name: 'PermissionRequest',
        permission_type: 'tool_use',
      });

      await permissionHandler(payload);

      expect(mockPolicyEngine.processPermissionRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: undefined,
          filePath: undefined,
          command: undefined,
          details: undefined,
        })
      );
    });
  });

  // ==========================================================================
  // SUBAGENT START HANDLER
  // ==========================================================================

  describe('handleSubagentStart', () => {
    let subagentStartHandler: (payload: HookPayload) => Promise<HookResponse>;

    beforeEach(() => {
      registerEnhancedHookHandlers();
      const subagentStartCall = mockHookServer.registerHandler.mock.calls.find(
        call => call[0] === 'SubagentStart'
      );
      subagentStartHandler = subagentStartCall?.[1] as (payload: HookPayload) => Promise<HookResponse>;
    });

    it('should register agent in agent tree', async () => {
      const payload = createHookPayload({
        hook_event_name: 'SubagentStart',
        session_id: 'child-session-456',
        agent_name: 'TestAgent',
        parent_session_id: 'parent-session-123',
      });

      const result = await subagentStartHandler(payload);

      expect(mockAgentTreeService.handleAgentStart).toHaveBeenCalledWith({
        sessionId: 'child-session-456',
        agentName: 'TestAgent',
        parentSessionId: 'parent-session-123',
      });
      expect(result.decision).toBe('allow');
    });

    it('should handle missing agent_name', async () => {
      const payload = createHookPayload({
        hook_event_name: 'SubagentStart',
        session_id: 'child-session-456',
      });

      const result = await subagentStartHandler(payload);

      expect(mockAgentTreeService.handleAgentStart).not.toHaveBeenCalled();
      expect(result.decision).toBe('allow');
    });

    it('should handle missing session_id', async () => {
      const payload = createHookPayload({
        hook_event_name: 'SubagentStart',
        agent_name: 'TestAgent',
        session_id: undefined,
      });

      const result = await subagentStartHandler(payload);

      expect(mockAgentTreeService.handleAgentStart).not.toHaveBeenCalled();
      expect(result.decision).toBe('allow');
    });
  });

  // ==========================================================================
  // SUBAGENT STOP HANDLER
  // ==========================================================================

  describe('handleSubagentStop', () => {
    let subagentStopHandler: (payload: HookPayload) => Promise<HookResponse>;

    beforeEach(() => {
      registerEnhancedHookHandlers();
      const subagentStopCall = mockHookServer.registerHandler.mock.calls.find(
        call => call[0] === 'SubagentStop'
      );
      subagentStopHandler = subagentStopCall?.[1] as (payload: HookPayload) => Promise<HookResponse>;
    });

    it('should update agent tree on stop', async () => {
      const payload = createHookPayload({
        hook_event_name: 'SubagentStop',
        session_id: 'child-session-456',
      });

      const result = await subagentStopHandler(payload);

      expect(mockAgentTreeService.handleAgentStop).toHaveBeenCalledWith({
        sessionId: 'child-session-456',
        success: true,
      });
      expect(result.decision).toBe('allow');
    });

    it('should handle missing session_id', async () => {
      const payload = createHookPayload({
        hook_event_name: 'SubagentStop',
        session_id: undefined,
      });

      const result = await subagentStopHandler(payload);

      expect(mockAgentTreeService.handleAgentStop).not.toHaveBeenCalled();
      expect(result.decision).toBe('allow');
    });
  });

  // ==========================================================================
  // SESSION HANDLERS
  // ==========================================================================

  describe('handleSessionStart', () => {
    let sessionStartHandler: (payload: HookPayload) => Promise<HookResponse>;

    beforeEach(() => {
      registerEnhancedHookHandlers();
      const sessionStartCall = mockHookServer.registerHandler.mock.calls.find(
        call => call[0] === 'SessionStart'
      );
      sessionStartHandler = sessionStartCall?.[1] as (payload: HookPayload) => Promise<HookResponse>;
    });

    it('should return allow decision', async () => {
      const payload = createHookPayload({ hook_event_name: 'SessionStart' });
      const result = await sessionStartHandler(payload);

      expect(result.decision).toBe('allow');
    });
  });

  describe('handleSessionEnd', () => {
    let sessionEndHandler: (payload: HookPayload) => Promise<HookResponse>;

    beforeEach(() => {
      registerEnhancedHookHandlers();
      const sessionEndCall = mockHookServer.registerHandler.mock.calls.find(
        call => call[0] === 'SessionEnd'
      );
      sessionEndHandler = sessionEndCall?.[1] as (payload: HookPayload) => Promise<HookResponse>;
    });

    it('should return allow decision', async () => {
      const payload = createHookPayload({ hook_event_name: 'SessionEnd' });
      const result = await sessionEndHandler(payload);

      expect(result.decision).toBe('allow');
    });
  });

  describe('handleStop', () => {
    let stopHandler: (payload: HookPayload) => Promise<HookResponse>;

    beforeEach(() => {
      registerEnhancedHookHandlers();
      const stopCall = mockHookServer.registerHandler.mock.calls.find(
        call => call[0] === 'Stop'
      );
      stopHandler = stopCall?.[1] as (payload: HookPayload) => Promise<HookResponse>;
    });

    it('should return allow decision', async () => {
      const payload = createHookPayload({ hook_event_name: 'Stop' });
      const result = await stopHandler(payload);

      expect(result.decision).toBe('allow');
    });
  });

  describe('handleUserPromptSubmit', () => {
    let userPromptHandler: (payload: HookPayload) => Promise<HookResponse>;

    beforeEach(() => {
      registerEnhancedHookHandlers();
      const userPromptCall = mockHookServer.registerHandler.mock.calls.find(
        call => call[0] === 'UserPromptSubmit'
      );
      userPromptHandler = userPromptCall?.[1] as (payload: HookPayload) => Promise<HookResponse>;
    });

    it('should return allow decision', async () => {
      const payload = createHookPayload({ hook_event_name: 'UserPromptSubmit' });
      const result = await userPromptHandler(payload);

      expect(result.decision).toBe('allow');
    });
  });
});
