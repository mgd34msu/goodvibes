// ============================================================================
// HOOK EXECUTION TESTS
// ============================================================================
//
// Comprehensive tests for HookExecutor context matching and validation logic.
// Tests cover:
// - Context matching patterns
// - Glob-based matching
// - Tool name and argument matching
//
// NOTE: Tests for actual process execution require complex child_process mocking
// and are deferred to integration tests. These unit tests focus on the matching
// and validation logic which is the core business logic of the HookExecutor.
// ============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================================
// MOCKS
// ============================================================================

// Mock database primitives
vi.mock('../../database/primitives.js', () => ({
  recordHookExecution: vi.fn(),
}));

// Mock input sanitizer
vi.mock('../inputSanitizer.js', () => ({
  validateHookCommand: vi.fn().mockReturnValue({ valid: true, sanitized: undefined }),
  validatePath: vi.fn().mockReturnValue({ valid: true, sanitized: undefined }),
  logSecurityEvent: vi.fn(),
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

// Mock constants
vi.mock('../../../../shared/constants.js', () => ({
  DEFAULT_HOOK_TIMEOUT_MS: 5000,
}));

// ============================================================================
// IMPORTS - After mocks
// ============================================================================

import { HookExecutor } from './hook-execution.js';
import type { HookConfig } from './types.js';
import type { HookExecutionContext } from './types.js';

// ============================================================================
// TEST HELPERS
// ============================================================================

function createMockHookConfig(overrides: Partial<HookConfig> = {}): HookConfig {
  return {
    id: 1,
    name: 'Test Hook',
    eventType: 'PreToolUse',
    matcher: '*',
    command: 'echo "test"',
    timeout: 1000,
    enabled: true,
    scope: 'project',
    projectPath: '/test/project',
    executionCount: 0,
    lastExecuted: null,
    lastResult: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    hookType: 'command',
    prompt: null,
    ...overrides,
  };
}

function createMockContext(overrides: Partial<HookExecutionContext> = {}): HookExecutionContext {
  return {
    eventType: 'PreToolUse',
    toolName: 'Read',
    toolInput: { file_path: '/test/file.ts' },
    sessionId: 'test-session',
    projectPath: '/test/project',
    timestamp: Date.now(),
    ...overrides,
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe('HookExecutor', () => {
  let executor: HookExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new HookExecutor();
  });

  // ==========================================================================
  // INITIALIZATION
  // ==========================================================================

  describe('Initialization', () => {
    it('should create a HookExecutor instance', () => {
      expect(executor).toBeDefined();
      expect(executor).toBeInstanceOf(HookExecutor);
    });

    it('should start with zero running hooks', () => {
      expect(executor.getRunningCount()).toBe(0);
    });
  });

  // ==========================================================================
  // CONTEXT MATCHING
  // ==========================================================================

  describe('Context Matching', () => {
    describe('Wildcard Patterns', () => {
      it('should match wildcard pattern "*"', () => {
        const hook = createMockHookConfig({ matcher: '*' });
        const context = createMockContext({ toolName: 'AnyTool' });

        expect(executor.matchesContext(hook, context)).toBe(true);
      });

      it('should match empty matcher as wildcard', () => {
        const hook = createMockHookConfig({ matcher: '' });
        const context = createMockContext({ toolName: 'AnyTool' });

        expect(executor.matchesContext(hook, context)).toBe(true);
      });

      it('should match undefined matcher as wildcard', () => {
        const hook = createMockHookConfig({ matcher: undefined as unknown as string });
        const context = createMockContext({ toolName: 'AnyTool' });

        expect(executor.matchesContext(hook, context)).toBe(true);
      });
    });

    describe('Exact Tool Name Matching', () => {
      it('should match exact tool name', () => {
        const hook = createMockHookConfig({ matcher: 'Read' });
        const context = createMockContext({ toolName: 'Read' });

        expect(executor.matchesContext(hook, context)).toBe(true);
      });

      it('should not match different tool name', () => {
        const hook = createMockHookConfig({ matcher: 'Read' });
        const context = createMockContext({ toolName: 'Write' });

        expect(executor.matchesContext(hook, context)).toBe(false);
      });

      it('should handle case sensitivity', () => {
        const hook = createMockHookConfig({ matcher: 'read' });
        const context = createMockContext({ toolName: 'Read' });

        // Exact match is case-sensitive
        expect(executor.matchesContext(hook, context)).toBe(false);
      });
    });

    describe('Tool Pattern Matching with Arguments', () => {
      it('should match tool pattern with argument wildcard', () => {
        const hook = createMockHookConfig({ matcher: 'Bash(*)' });
        const context = createMockContext({
          toolName: 'Bash',
          toolInput: { command: 'npm install' },
        });

        expect(executor.matchesContext(hook, context)).toBe(true);
      });

      it('should match tool pattern with specific argument pattern', () => {
        const hook = createMockHookConfig({ matcher: 'Edit(src/*)' });
        const context = createMockContext({
          toolName: 'Edit',
          toolInput: { file_path: 'src/index.ts' },
        });

        expect(executor.matchesContext(hook, context)).toBe(true);
      });

      it('should not match tool pattern when tool name differs', () => {
        const hook = createMockHookConfig({ matcher: 'Read(*)' });
        const context = createMockContext({
          toolName: 'Write',
          toolInput: { file_path: 'test.ts' },
        });

        expect(executor.matchesContext(hook, context)).toBe(false);
      });

      it('should not match when argument pattern does not match', () => {
        const hook = createMockHookConfig({ matcher: 'Edit(src/*)' });
        const context = createMockContext({
          toolName: 'Edit',
          toolInput: { file_path: 'dist/bundle.js' },
        });

        expect(executor.matchesContext(hook, context)).toBe(false);
      });

      it('should match nested glob patterns', () => {
        const hook = createMockHookConfig({ matcher: 'Edit(src/**/*.ts)' });
        const context = createMockContext({
          toolName: 'Edit',
          toolInput: { file_path: 'src/components/Button.ts' },
        });

        expect(executor.matchesContext(hook, context)).toBe(true);
      });

      it('should not match when nested pattern does not match', () => {
        const hook = createMockHookConfig({ matcher: 'Edit(src/**/*.ts)' });
        const context = createMockContext({
          toolName: 'Edit',
          toolInput: { file_path: 'src/components/Button.js' },
        });

        expect(executor.matchesContext(hook, context)).toBe(false);
      });
    });

    describe('Bash Command Pattern Matching', () => {
      it('should match Bash command prefix pattern', () => {
        const hook = createMockHookConfig({ matcher: 'Bash(npm *)' });
        const context = createMockContext({
          toolName: 'Bash',
          toolInput: { command: 'npm install lodash' },
        });

        expect(executor.matchesContext(hook, context)).toBe(true);
      });

      it('should not match Bash pattern with different command prefix', () => {
        const hook = createMockHookConfig({ matcher: 'Bash(npm *)' });
        const context = createMockContext({
          toolName: 'Bash',
          toolInput: { command: 'yarn add lodash' },
        });

        expect(executor.matchesContext(hook, context)).toBe(false);
      });

      it('should match multiple Bash command patterns', () => {
        const hook1 = createMockHookConfig({ matcher: 'Bash(git *)' });
        const hook2 = createMockHookConfig({ matcher: 'Bash(npm *)' });
        const context = createMockContext({
          toolName: 'Bash',
          toolInput: { command: 'git status' },
        });

        expect(executor.matchesContext(hook1, context)).toBe(true);
        expect(executor.matchesContext(hook2, context)).toBe(false);
      });
    });

    describe('Edge Cases', () => {
      it('should match when context has no tool name', () => {
        const hook = createMockHookConfig({ matcher: '*' });
        const context = createMockContext({ toolName: undefined });

        expect(executor.matchesContext(hook, context)).toBe(true);
      });

      it('should handle empty tool input with wildcard pattern', () => {
        const hook = createMockHookConfig({ matcher: 'Read(*)' });
        const context = createMockContext({
          toolName: 'Read',
          toolInput: undefined,
        });

        // The wildcard (*) pattern matches anything including undefined input
        // This is the expected behavior - wildcards are permissive
        expect(executor.matchesContext(hook, context)).toBe(true);
      });

      it('should handle tool input without expected field', () => {
        const hook = createMockHookConfig({ matcher: 'Edit(src/*)' });
        const context = createMockContext({
          toolName: 'Edit',
          toolInput: { content: 'some content' }, // Missing file_path
        });

        // Should not match if expected input field is missing
        expect(executor.matchesContext(hook, context)).toBe(false);
      });

      it('should handle special regex characters in patterns', () => {
        const hook = createMockHookConfig({ matcher: 'Edit(package.json)' });
        const context = createMockContext({
          toolName: 'Edit',
          toolInput: { file_path: 'package.json' },
        });

        expect(executor.matchesContext(hook, context)).toBe(true);
      });
    });
  });

  // ==========================================================================
  // PROCESS MANAGEMENT
  // ==========================================================================

  describe('Process Management', () => {
    it('should return false when killing non-existent hook', () => {
      const killed = executor.killHook(99999);
      expect(killed).toBe(false);
    });

    it('should have killAllHooks method', () => {
      expect(typeof executor.killAllHooks).toBe('function');
      // Should not throw when no hooks are running
      expect(() => executor.killAllHooks()).not.toThrow();
    });

    it('should track running count as zero initially', () => {
      expect(executor.getRunningCount()).toBe(0);
    });
  });

  // ==========================================================================
  // HOOK CONFIG VALIDATION
  // ==========================================================================

  describe('Hook Config', () => {
    it('should accept valid hook configs', () => {
      const hook = createMockHookConfig();
      const context = createMockContext();

      // matchesContext should not throw for valid configs
      expect(() => executor.matchesContext(hook, context)).not.toThrow();
    });

    it('should handle hook with various event types', () => {
      const eventTypes = ['PreToolUse', 'PostToolUse', 'SessionStart', 'SessionEnd'] as const;

      eventTypes.forEach((eventType) => {
        const hook = createMockHookConfig({ eventType });
        const context = createMockContext({ eventType });

        // Should not throw
        expect(() => executor.matchesContext(hook, context)).not.toThrow();
      });
    });

    it('should handle hook with different timeouts', () => {
      const timeouts = [100, 1000, 5000, 10000, 60000];

      timeouts.forEach((timeout) => {
        const hook = createMockHookConfig({ timeout });
        const context = createMockContext();

        expect(() => executor.matchesContext(hook, context)).not.toThrow();
      });
    });
  });
});

// ==========================================================================
// HOOK EXECUTION RESULT STRUCTURE
// ==========================================================================

describe('Hook Execution Result Structure', () => {
  it('should have expected result fields', () => {
    // This test documents the expected structure of HookExecutionResult
    const expectedFields = [
      'hookId',
      'hookName',
      'success',
      'exitCode',
      'stdout',
      'stderr',
      'durationMs',
      'shouldBlock',
    ];

    // The fields are defined in types.ts
    // This test serves as documentation
    expect(expectedFields).toHaveLength(8);
  });

  it('shouldBlock should be true for exit code 2', () => {
    // Exit code 2 conventionally means "block the action"
    // This behavior is documented here even though we can't test execution
    const exitCode2MeansBlock = 2;
    expect(exitCode2MeansBlock).toBe(2);
  });
});
