// ============================================================================
// HOOK HANDLERS TESTS
// ============================================================================
//
// Comprehensive tests for the default hook handlers created by createDefaultHandlers.
// Tests cover:
// - PreToolUse handler (Task tool detection)
// - PostToolUse handler (tool usage tracking)
// - SessionStart handler (session tracking, agent creation, context injection)
// - SessionEnd handler (session cleanup, agent status update)
// - SubagentStart handler (subagent creation, parent-child linking)
// - SubagentStop handler (subagent completion)
// - PermissionRequest handler (permission routing)
// - Notification handler (notification forwarding)
//
// ============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { HookPayload, HookResponse } from './types.js';

// ============================================================================
// MOCKS - Must be defined before imports using vi.hoisted
// ============================================================================

// Use vi.hoisted to ensure mock variables are available at mock definition time
const {
  mockAgents,
  mockFindAgentBySession,
  mockUpsertAgent,
  mockUpdateAgentStatus,
  mockGetAgent,
  mockGetAllAgents,
  mockActiveAgents,
  mockPendingSkills,
  mockIndexedAgents,
  mockIndexedSkills,
  mockSend,
} = vi.hoisted(() => {
  // Mock agent data store
  const mockAgents = new Map<string, {
    id: string;
    name: string;
    parentId: string | null;
    status: string;
    sessionPath: string | null;
  }>();

  // Database mock functions
  const mockFindAgentBySession = vi.fn((sessionId: string) => {
    for (const agent of mockAgents.values()) {
      if (agent.sessionPath === sessionId || agent.id === sessionId) {
        return agent;
      }
    }
    return null;
  });

  const mockUpsertAgent = vi.fn((agent: {
    id: string;
    name: string;
    parentId: string | null;
    status: string;
    sessionPath: string | null;
  }) => {
    const existing = mockAgents.get(agent.id);
    const result = { ...existing, ...agent };
    mockAgents.set(agent.id, result);
    return result;
  });

  const mockUpdateAgentStatus = vi.fn((id: string, status: string) => {
    const agent = mockAgents.get(id);
    if (agent) {
      agent.status = status;
    }
  });

  const mockGetAgent = vi.fn((id: string) => mockAgents.get(id) || null);

  const mockGetAllAgents = vi.fn(() => Array.from(mockAgents.values()));

  // Mock agency index data
  const mockActiveAgents: Array<{ agentId: string }> = [];
  const mockPendingSkills: Array<{ id: number; skillId: string }> = [];
  const mockIndexedAgents = new Map<string, { id: string; name: string; slug: string; description: string; content: string }>();
  const mockIndexedSkills = new Map<string, { id: string; name: string; slug: string; description: string; content: string }>();

  // Mock window send function
  const mockSend = vi.fn();

  return {
    mockAgents,
    mockFindAgentBySession,
    mockUpsertAgent,
    mockUpdateAgentStatus,
    mockGetAgent,
    mockGetAllAgents,
    mockActiveAgents,
    mockPendingSkills,
    mockIndexedAgents,
    mockIndexedSkills,
    mockSend,
  };
});

vi.mock('../../database/primitives.js', () => ({
  findAgentBySession: mockFindAgentBySession,
  upsertAgent: mockUpsertAgent,
  updateAgentStatus: mockUpdateAgentStatus,
  getAgent: mockGetAgent,
  getAllAgents: mockGetAllAgents,
  AgentStatus: { active: 'active', completed: 'completed' },
}));

vi.mock('../../database/agencyIndex.js', () => ({
  getActiveAgentsForProject: vi.fn((_projectPath: string) => mockActiveAgents),
  getPendingSkillsForProject: vi.fn((_projectPath: string) => mockPendingSkills),
  getIndexedAgent: vi.fn((agentId: string) => mockIndexedAgents.get(agentId) || null),
  getIndexedSkill: vi.fn((skillId: string) => mockIndexedSkills.get(skillId) || null),
  markSkillInjected: vi.fn(),
  recordAgentUsage: vi.fn(),
  recordSkillUsage: vi.fn(),
}));

// Mock window
vi.mock('../../window.js', () => ({
  getMainWindow: vi.fn(() => ({
    isDestroyed: () => false,
    webContents: { send: mockSend },
  })),
}));

// Mock logger
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

import { createDefaultHandlers, type HandlerContext } from './handlers.js';

// ============================================================================
// TEST HELPERS
// ============================================================================

function createMockContext(): HandlerContext {
  const sessionStacks = new Map<string, string[]>();
  const emittedEvents: Array<{ event: string; data: unknown }> = [];

  return {
    pushSession: vi.fn((workingDirectory: string | undefined, sessionId: string) => {
      if (!workingDirectory) return;
      if (!sessionStacks.has(workingDirectory)) {
        sessionStacks.set(workingDirectory, []);
      }
      const stack = sessionStacks.get(workingDirectory)!;
      if (!stack.includes(sessionId)) {
        stack.push(sessionId);
      }
    }),
    popSession: vi.fn((workingDirectory: string | undefined, sessionId: string) => {
      if (!workingDirectory) return;
      const stack = sessionStacks.get(workingDirectory);
      if (stack) {
        const index = stack.indexOf(sessionId);
        if (index !== -1) {
          stack.splice(index, 1);
        }
      }
    }),
    getCurrentParentSession: vi.fn((workingDirectory: string | undefined) => {
      if (!workingDirectory) return null;
      const stack = sessionStacks.get(workingDirectory);
      if (!stack || stack.length === 0) return null;
      return stack[stack.length - 1];
    }),
    cleanupSession: vi.fn((sessionId: string) => {
      // Remove session from all stacks
      for (const stack of sessionStacks.values()) {
        const index = stack.indexOf(sessionId);
        if (index !== -1) {
          stack.splice(index, 1);
        }
      }
    }),
    emit: vi.fn((event: string, data: unknown) => {
      emittedEvents.push({ event, data });
    }),
    // Expose for testing
    _sessionStacks: sessionStacks,
    _emittedEvents: emittedEvents,
  } as HandlerContext & { _sessionStacks: Map<string, string[]>; _emittedEvents: Array<{ event: string; data: unknown }> };
}

function createMockPayload(overrides: Partial<HookPayload> = {}): HookPayload {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 'test-session-123',
    working_directory: '/test/project',
    ...overrides,
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe('Hook Handlers', () => {
  let context: ReturnType<typeof createMockContext>;
  let handlers: Map<string, (payload: HookPayload) => Promise<HookResponse> | HookResponse>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAgents.clear();
    mockActiveAgents.length = 0;
    mockPendingSkills.length = 0;
    mockIndexedAgents.clear();
    mockIndexedSkills.clear();
    mockSend.mockClear();

    context = createMockContext();
    handlers = createDefaultHandlers(context);
  });

  // ==========================================================================
  // HANDLER REGISTRATION
  // ==========================================================================

  describe('Handler Registration', () => {
    it('should create handlers for all expected event types', () => {
      expect(handlers.has('PreToolUse')).toBe(true);
      expect(handlers.has('PostToolUse')).toBe(true);
      expect(handlers.has('SessionStart')).toBe(true);
      expect(handlers.has('SessionEnd')).toBe(true);
      expect(handlers.has('SubagentStart')).toBe(true);
      expect(handlers.has('SubagentStop')).toBe(true);
      expect(handlers.has('PermissionRequest')).toBe(true);
      expect(handlers.has('Notification')).toBe(true);
    });
  });

  // ==========================================================================
  // PreToolUse HANDLER
  // ==========================================================================

  describe('PreToolUse Handler', () => {
    it('should allow tool use by default', async () => {
      const handler = handlers.get('PreToolUse')!;
      const payload = createMockPayload({
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
      });

      const response = await handler(payload);

      expect(response.decision).toBe('allow');
    });

    it('should track Task tool invocations for parent session', async () => {
      const handler = handlers.get('PreToolUse')!;
      const payload = createMockPayload({
        hook_event_name: 'PreToolUse',
        tool_name: 'Task',
        session_id: 'parent-session',
        working_directory: '/test/project',
      });

      await handler(payload);

      expect(context.pushSession).toHaveBeenCalledWith('/test/project', 'parent-session');
    });

    it('should not track non-Task tools for parent session', async () => {
      const handler = handlers.get('PreToolUse')!;
      const payload = createMockPayload({
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        session_id: 'some-session',
      });

      await handler(payload);

      expect(context.pushSession).not.toHaveBeenCalled();
    });

    it('should handle missing session ID', async () => {
      const handler = handlers.get('PreToolUse')!;
      const payload = createMockPayload({
        hook_event_name: 'PreToolUse',
        tool_name: 'Task',
        session_id: undefined,
      });

      const response = await handler(payload);

      expect(response.decision).toBe('allow');
      expect(context.pushSession).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // PostToolUse HANDLER
  // ==========================================================================

  describe('PostToolUse Handler', () => {
    it('should emit tool:used event on successful tool use', async () => {
      const handler = handlers.get('PostToolUse')!;
      const payload = createMockPayload({
        hook_event_name: 'PostToolUse',
        tool_name: 'Read',
        session_id: 'test-session',
        tool_response: { success: true, content: 'file contents' },
      });

      const response = await handler(payload);

      expect(response.decision).toBe('allow');
      expect(context.emit).toHaveBeenCalledWith('tool:used', {
        toolName: 'Read',
        sessionId: 'test-session',
        success: true,
      });
    });

    it('should emit tool:used event with success=false on failure', async () => {
      const handler = handlers.get('PostToolUse')!;
      const payload = createMockPayload({
        hook_event_name: 'PostToolUse',
        tool_name: 'Write',
        session_id: 'test-session',
        tool_response: { success: false, content: 'Permission denied' },
      });

      await handler(payload);

      expect(context.emit).toHaveBeenCalledWith('tool:used', {
        toolName: 'Write',
        sessionId: 'test-session',
        success: false,
      });
    });

    it('should default success to true when toolResponse is missing', async () => {
      const handler = handlers.get('PostToolUse')!;
      const payload = createMockPayload({
        hook_event_name: 'PostToolUse',
        tool_name: 'Read',
        session_id: 'test-session',
        tool_response: undefined,
      });

      await handler(payload);

      expect(context.emit).toHaveBeenCalledWith('tool:used', {
        toolName: 'Read',
        sessionId: 'test-session',
        success: true,
      });
    });

    it('should handle camelCase toolResponse', async () => {
      const handler = handlers.get('PostToolUse')!;
      const payload = {
        hook_event_name: 'PostToolUse',
        toolName: 'Edit',
        sessionId: 'test-session',
        toolResponse: { success: true, content: 'edited' },
      } as HookPayload;

      await handler(payload);

      expect(context.emit).toHaveBeenCalledWith('tool:used', {
        toolName: 'Edit',
        sessionId: 'test-session',
        success: true,
      });
    });
  });

  // ==========================================================================
  // SessionStart HANDLER
  // ==========================================================================

  describe('SessionStart Handler', () => {
    it('should create root agent on session start', async () => {
      const handler = handlers.get('SessionStart')!;
      const payload = createMockPayload({
        hook_event_name: 'SessionStart',
        session_id: 'new-session-123',
        working_directory: '/project/path',
      });

      const response = await handler(payload);

      expect(response.decision).toBe('allow');
      expect(mockUpsertAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'new-session-123',
          name: 'Main Session',
          parentId: null,
          status: 'active',
          sessionPath: 'new-session-123',
        })
      );
    });

    it('should push session to stack', async () => {
      const handler = handlers.get('SessionStart')!;
      const payload = createMockPayload({
        hook_event_name: 'SessionStart',
        session_id: 'stack-session',
        working_directory: '/project',
      });

      await handler(payload);

      expect(context.pushSession).toHaveBeenCalledWith('/project', 'stack-session');
    });

    it('should emit session:start event', async () => {
      const handler = handlers.get('SessionStart')!;
      const payload = createMockPayload({
        hook_event_name: 'SessionStart',
        session_id: 'event-session',
        working_directory: '/project',
      });

      await handler(payload);

      expect(context.emit).toHaveBeenCalledWith('session:start', {
        sessionId: 'event-session',
        projectPath: '/project',
      });
    });

    it('should inject active agents context', async () => {
      // Set up mock active agent
      mockActiveAgents.push({ agentId: 'agent-1' });
      mockIndexedAgents.set('agent-1', {
        id: 'agent-1',
        name: 'Test Agent',
        slug: 'test-agent',
        description: 'A test agent',
        content: 'Agent instructions here',
      });

      const handler = handlers.get('SessionStart')!;
      const payload = createMockPayload({
        hook_event_name: 'SessionStart',
        session_id: 'inject-session',
        working_directory: '/project',
      });

      const response = await handler(payload);

      expect(response.inject_context).toContain('GOODVIBES:AGENT:test-agent');
      expect(response.inject_context).toContain('Test Agent');
      expect(response.inject_context).toContain('Agent instructions here');
    });

    it('should inject pending skills context', async () => {
      // Set up mock pending skill
      mockPendingSkills.push({ id: 1, skillId: 'skill-1' });
      mockIndexedSkills.set('skill-1', {
        id: 'skill-1',
        name: 'Test Skill',
        slug: 'test-skill',
        description: 'A test skill',
        content: 'Skill instructions here',
      });

      const handler = handlers.get('SessionStart')!;
      const payload = createMockPayload({
        hook_event_name: 'SessionStart',
        session_id: 'skill-session',
        working_directory: '/project',
      });

      const response = await handler(payload);

      expect(response.inject_context).toContain('GOODVIBES:SKILL:test-skill');
      expect(response.inject_context).toContain('Test Skill');
      expect(response.inject_context).toContain('Skill instructions here');
    });

    it('should handle missing working directory', async () => {
      const handler = handlers.get('SessionStart')!;
      const payload = createMockPayload({
        hook_event_name: 'SessionStart',
        session_id: 'no-dir-session',
        working_directory: undefined,
      });

      const response = await handler(payload);

      expect(response.decision).toBe('allow');
      expect(context.pushSession).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // SessionEnd HANDLER
  // ==========================================================================

  describe('SessionEnd Handler', () => {
    it('should mark agent as completed on session end', async () => {
      // First create an agent
      mockAgents.set('ending-session', {
        id: 'ending-session',
        name: 'Test Session',
        parentId: null,
        status: 'active',
        sessionPath: 'ending-session',
      });

      const handler = handlers.get('SessionEnd')!;
      const payload = createMockPayload({
        hook_event_name: 'SessionEnd',
        session_id: 'ending-session',
        working_directory: '/project',
      });

      const response = await handler(payload);

      expect(response.decision).toBe('allow');
      expect(mockUpdateAgentStatus).toHaveBeenCalledWith('ending-session', 'completed');
    });

    it('should pop session from stack', async () => {
      const handler = handlers.get('SessionEnd')!;
      const payload = createMockPayload({
        hook_event_name: 'SessionEnd',
        session_id: 'pop-session',
        working_directory: '/project',
      });

      await handler(payload);

      expect(context.popSession).toHaveBeenCalledWith('/project', 'pop-session');
    });

    it('should emit session:end event', async () => {
      const handler = handlers.get('SessionEnd')!;
      const payload = createMockPayload({
        hook_event_name: 'SessionEnd',
        session_id: 'end-event-session',
        working_directory: '/project',
      });

      await handler(payload);

      expect(context.emit).toHaveBeenCalledWith('session:end', {
        sessionId: 'end-event-session',
        projectPath: '/project',
      });
    });

    it('should handle non-existent agent gracefully', async () => {
      const handler = handlers.get('SessionEnd')!;
      const payload = createMockPayload({
        hook_event_name: 'SessionEnd',
        session_id: 'non-existent-session',
      });

      const response = await handler(payload);

      expect(response.decision).toBe('allow');
      expect(mockUpdateAgentStatus).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // SubagentStart HANDLER
  // ==========================================================================

  describe('SubagentStart Handler', () => {
    it('should create subagent with parent from session stack', async () => {
      // Set up parent session
      mockAgents.set('parent-agent', {
        id: 'parent-agent',
        name: 'Parent Session',
        parentId: null,
        status: 'active',
        sessionPath: 'parent-session',
      });

      // Simulate parent being on stack
      (context.getCurrentParentSession as ReturnType<typeof vi.fn>).mockReturnValue('parent-session');
      mockFindAgentBySession.mockReturnValue(mockAgents.get('parent-agent') ?? null);

      const handler = handlers.get('SubagentStart')!;
      const payload = createMockPayload({
        hook_event_name: 'SubagentStart',
        agent_id: 'subagent-1',
        agent_name: 'Child Agent',
        agent_type: 'Task',
        working_directory: '/project',
      });

      const response = await handler(payload);

      expect(response.decision).toBe('allow');
      expect(mockUpsertAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'subagent-1',
          name: 'Child Agent',
          parentId: 'parent-agent',
          status: 'active',
        })
      );
    });

    it('should use explicit parent_session_id when provided', async () => {
      mockAgents.set('explicit-parent', {
        id: 'explicit-parent',
        name: 'Explicit Parent',
        parentId: null,
        status: 'active',
        sessionPath: 'explicit-parent-session',
      });

      mockFindAgentBySession.mockImplementation((sessionId) => {
        if (sessionId === 'explicit-parent-session') {
          return mockAgents.get('explicit-parent') ?? null;
        }
        return null;
      });

      const handler = handlers.get('SubagentStart')!;
      const payload = createMockPayload({
        hook_event_name: 'SubagentStart',
        agent_id: 'child-with-explicit-parent',
        parent_session_id: 'explicit-parent-session',
        working_directory: '/project',
      });

      const response = await handler(payload);

      expect(response.decision).toBe('allow');
      expect(mockUpsertAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'child-with-explicit-parent',
          parentId: 'explicit-parent',
        })
      );
    });

    it('should emit agent:start event', async () => {
      const handler = handlers.get('SubagentStart')!;
      const payload = createMockPayload({
        hook_event_name: 'SubagentStart',
        agent_id: 'start-event-agent',
        agent_name: 'Event Agent',
      });

      await handler(payload);

      expect(context.emit).toHaveBeenCalledWith('agent:start', {
        agentName: 'Event Agent',
        sessionId: 'start-event-agent',
      });
    });

    it('should notify renderer of new agent', async () => {
      const handler = handlers.get('SubagentStart')!;
      const payload = createMockPayload({
        hook_event_name: 'SubagentStart',
        agent_id: 'renderer-notify-agent',
        agent_name: 'Renderer Agent',
      });

      await handler(payload);

      expect(mockSend).toHaveBeenCalledWith('agent:detected', expect.objectContaining({
        id: 'renderer-notify-agent',
        name: 'Renderer Agent',
      }));
    });

    it('should use agent_type as name when agent_name is missing', async () => {
      const handler = handlers.get('SubagentStart')!;
      const payload = createMockPayload({
        hook_event_name: 'SubagentStart',
        agent_id: 'type-name-agent',
        agent_type: 'TaskAgent',
        agent_name: undefined,
      });

      await handler(payload);

      expect(mockUpsertAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'TaskAgent',
        })
      );
    });

    it('should handle missing agent_id gracefully', async () => {
      const handler = handlers.get('SubagentStart')!;
      const payload = createMockPayload({
        hook_event_name: 'SubagentStart',
        agent_id: undefined,
      });

      const response = await handler(payload);

      expect(response.decision).toBe('allow');
      expect(mockUpsertAgent).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // SubagentStop HANDLER
  // ==========================================================================

  describe('SubagentStop Handler', () => {
    it('should mark subagent as completed', async () => {
      mockAgents.set('stopping-agent', {
        id: 'stopping-agent',
        name: 'Stopping Agent',
        parentId: null,
        status: 'active',
        sessionPath: 'stopping-agent',
      });

      mockGetAgent.mockReturnValue(mockAgents.get('stopping-agent') ?? null);

      const handler = handlers.get('SubagentStop')!;
      const payload = createMockPayload({
        hook_event_name: 'SubagentStop',
        agent_id: 'stopping-agent',
      });

      const response = await handler(payload);

      expect(response.decision).toBe('allow');
      expect(mockUpdateAgentStatus).toHaveBeenCalledWith('stopping-agent', 'completed');
    });

    it('should emit agent:stop event', async () => {
      const handler = handlers.get('SubagentStop')!;
      const payload = createMockPayload({
        hook_event_name: 'SubagentStop',
        agent_id: 'stop-event-agent',
        agent_name: 'Stop Event Agent',
      });

      await handler(payload);

      expect(context.emit).toHaveBeenCalledWith('agent:stop', {
        agentName: 'Stop Event Agent',
        sessionId: 'stop-event-agent',
      });
    });

    it('should find agent by session lookup if direct lookup fails', async () => {
      mockAgents.set('session-lookup-agent', {
        id: 'session-lookup-agent',
        name: 'Session Lookup Agent',
        parentId: null,
        status: 'active',
        sessionPath: 'different-session-path',
      });

      mockGetAgent.mockReturnValue(null);
      mockFindAgentBySession.mockReturnValue(mockAgents.get('session-lookup-agent') ?? null);

      const handler = handlers.get('SubagentStop')!;
      const payload = createMockPayload({
        hook_event_name: 'SubagentStop',
        agent_id: 'session-lookup-agent',
      });

      await handler(payload);

      expect(mockUpdateAgentStatus).toHaveBeenCalledWith('session-lookup-agent', 'completed');
    });

    it('should handle missing agent_id gracefully', async () => {
      const handler = handlers.get('SubagentStop')!;
      const payload = createMockPayload({
        hook_event_name: 'SubagentStop',
        agent_id: undefined,
      });

      const response = await handler(payload);

      expect(response.decision).toBe('allow');
      expect(mockUpdateAgentStatus).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // PermissionRequest HANDLER
  // ==========================================================================

  describe('PermissionRequest Handler', () => {
    it('should emit permission:requested event', async () => {
      const handler = handlers.get('PermissionRequest')!;
      const payload = createMockPayload({
        hook_event_name: 'PermissionRequest',
        permission_type: 'file_write',
        permission_details: '/etc/passwd',
        session_id: 'permission-session',
      });

      const response = await handler(payload);

      expect(response.decision).toBe('allow');
      expect(context.emit).toHaveBeenCalledWith('permission:requested', {
        type: 'file_write',
        details: '/etc/passwd',
        sessionId: 'permission-session',
      });
    });

    it('should handle camelCase permission fields', async () => {
      const handler = handlers.get('PermissionRequest')!;
      const payload = {
        hook_event_name: 'PermissionRequest',
        permissionType: 'network_access',
        permissionDetails: 'https://api.example.com',
        sessionId: 'camel-permission-session',
      } as HookPayload;

      await handler(payload);

      expect(context.emit).toHaveBeenCalledWith('permission:requested', {
        type: 'network_access',
        details: 'https://api.example.com',
        sessionId: 'camel-permission-session',
      });
    });
  });

  // ==========================================================================
  // Notification HANDLER
  // ==========================================================================

  describe('Notification Handler', () => {
    it('should forward notification to renderer', async () => {
      const handler = handlers.get('Notification')!;
      const payload = createMockPayload({
        hook_event_name: 'Notification',
        notification_type: 'info',
        notification_message: 'Task completed successfully',
        session_id: 'notification-session',
      });

      const response = await handler(payload);

      expect(response.decision).toBe('allow');
      expect(mockSend).toHaveBeenCalledWith('hook:notification', {
        type: 'info',
        message: 'Task completed successfully',
        sessionId: 'notification-session',
      });
    });

    it('should handle camelCase notification fields', async () => {
      const handler = handlers.get('Notification')!;
      const payload = {
        hook_event_name: 'Notification',
        notificationType: 'warning',
        notificationMessage: 'Resource usage high',
        sessionId: 'camel-notification-session',
      } as HookPayload;

      await handler(payload);

      expect(mockSend).toHaveBeenCalledWith('hook:notification', {
        type: 'warning',
        message: 'Resource usage high',
        sessionId: 'camel-notification-session',
      });
    });
  });
});
